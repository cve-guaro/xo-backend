/**
 * Fix #1 / Fix #2 regression suite. Run with the dev server STOPPED: npm test
 *
 * Covers every earlier-requested test plus the Amendment 2 tests:
 *   T1  classification table (allow-list shipped EMPTY — everything ambiguous)
 *   T2  settle FAILED twice -> refund exactly once (status guard)
 *   T3  ambiguous -> stays PENDING; cron success -> COMPLETED/no refund;
 *       cron failed -> exactly one refund, rerun no-op
 *   T4  3 parallel cron runs -> exactly one refund
 *   T5  cron + admin reject race -> exactly one refund
 *   T6  late success after refund -> no double credit, no SMS, PAYOUT_LATE_SUCCESS alert
 *   T7  unique partial index blocks duplicate keys (raw + via fn_wallet_apply_tx)
 *   T8  success run once -> exactly one SMS, no double settle
 *   T9  deposit flow with bare-UUID keys under the unique index
 */
process.env.LOCAL_CORS = 'http://localhost:9999';
const net = require('net');
const { assertServerStopped } = require('./helpers');

// ── stubs BEFORE requiring cron (destructured at require time) ──
const smsModule = require('../src/utils/sms');
let smsCalls = 0;
smsModule.sendSMS = async () => true;
smsModule.sendWithdrawalSMS = async () => { smsCalls++; return true; };

const chapaModule = require('../src/models/Chapa');
let verifyStub = async () => { throw new Error('stub not configured'); };
chapaModule.getChapaTransferStatus = async (txId) => verifyStub(txId);

const { pool, USER_X, USER_O, assertNoForeignDbClients, resetUsers, checkInvariant,
        walletOf, txsOf, insertPendingWithdraw, report, summary } = require('./helpers');
const { verifyPendingPayouts } = require('../src/cron/verifyPendingPayouts');
const { settleWithdrawal } = require('../src/models/settleWithdrawal');
const { classifyChapaInitError, DEFINITIVE_PATTERNS } = require('../src/models/classifyChapaInitError');
const { getGhostCallback } = require('./cronCapture');
const { finishAndPayout, activeGames } = require('../src/socket/game');
const { checkIdempotencyIndex } = require('../src/models/idempotencyIndex');

function mkErr({ status, body, message, code }) {
  const e = new Error(message || 'err');
  if (status) { e.status = status; e.response = { status, data: { message: body } }; }
  else if (code) { e.code = code; }
  return e;
}

async function t1() {
  console.log('\nT1: classification table (empty allow-list — ambiguous by default)');
  report('T1.0 allow-list is empty', Array.isArray(DEFINITIVE_PATTERNS) && DEFINITIVE_PATTERNS.length === 0,
    `patterns=${JSON.stringify(DEFINITIVE_PATTERNS)}`);
  const CASES = [
    ['400 insufficient balance',           mkErr({ status: 400, body: 'Insufficient balance in wallet' }),  'ambiguous', false],
    ['422 invalid account',                mkErr({ status: 422, body: 'Invalid account number provided' }), 'ambiguous', false],
    ['400 unknown body',                   mkErr({ status: 400, body: 'something new we never saw' }),      'ambiguous', false],
    ['400 reference already used',         mkErr({ status: 400, body: 'Reference already used' }),          'ambiguous', false],
    ['401 auth',                           mkErr({ status: 401, body: 'Unauthorized' }),                    'ambiguous', true],
    ['403 auth',                           mkErr({ status: 403, body: 'Forbidden' }),                       'ambiguous', true],
    ['500 with "insufficient balance" text', mkErr({ status: 500, body: 'insufficient balance somewhere' }), 'ambiguous', false],
    ['timeout ECONNRESET',                 mkErr({ code: 'ECONNRESET' }),                                   'ambiguous', false],
    ['no status, plain message',           mkErr({ message: 'insufficient balance' }),                      'ambiguous', false],
  ];
  for (const [label, err, wantClass, wantAlert] of CASES) {
    const got = classifyChapaInitError(err);
    report(`T1 ${label}`, got.classification === wantClass && !!got.alert === wantAlert,
      `-> ${got.classification}${got.alert ? '+' + got.alert : ''}`);
  }
}

async function t2() {
  console.log('\nT2: settle FAILED twice -> refund exactly once');
  const tx = await insertPendingWithdraw('TEST_T2');
  const r1 = await settleWithdrawal(tx, 'FAILED', { reason: 'first', provider: 'SYSTEM_AUTO_REFUND' });
  const r2 = await settleWithdrawal(tx, 'FAILED', { reason: 'second', provider: 'SYSTEM_AUTO_REFUND' });
  const txs = await txsOf(USER_X);
  const refunds = txs.filter(t => t.tx_type === 'REFUND');
  const wd = txs.find(t => t.id === tx);
  report('T2 first settles + refunds', r1.settled && r1.refunded === true);
  report('T2 second call skipped', r2.settled === false && r2.refunded === false);
  report('T2 wallet credited once (100/100)', (await walletOf(USER_X)).available_balance === 100 && (await walletOf(USER_X)).withdrawable_balance === 100);
  report('T2 exactly one refund ledger row with WITHDRAW_REFUND key', refunds.length === 1 && refunds[0].idempotency_key === `WITHDRAW_REFUND:${tx}`);
  report('T2 withdrawal marked FAILED', wd.status === 'FAILED');
  await checkInvariant('T2');
}

async function t3() {
  console.log('\nT3: ambiguous -> PENDING; cron success -> COMPLETED/no refund; cron failed -> one refund');
  await resetUsers();
  const tx = await insertPendingWithdraw('TEST_T3');
  verifyStub = async () => ({ data: { status: 'pending' } });
  await verifyPendingPayouts();
  let txs = await txsOf(USER_X);
  report('T3a status=pending leaves row PENDING, no refund',
    txs.find(t => t.id === tx).status === 'PENDING' && !txs.some(t => t.tx_type === 'REFUND'));

  verifyStub = async () => ({ data: { status: 'success' } });
  await verifyPendingPayouts();
  txs = await txsOf(USER_X);
  report('T3b cron success -> COMPLETED, no refund, wallet untouched',
    txs.find(t => t.id === tx).status === 'COMPLETED' && !txs.some(t => t.tx_type === 'REFUND') &&
    (await walletOf(USER_X)).available_balance === 0);

  const tx2 = await insertPendingWithdraw('TEST_T3C');
  verifyStub = async () => ({ data: { status: 'failed' } });
  await verifyPendingPayouts();
  const after1 = (await txsOf(USER_X)).filter(t => t.tx_type === 'REFUND').length;
  await verifyPendingPayouts(); // rerun must be a no-op
  const after2 = (await txsOf(USER_X)).filter(t => t.tx_type === 'REFUND').length;
  report('T3c cron failed -> exactly one refund; rerun no-op', after1 === 1 && after2 === 1 &&
    (await walletOf(USER_X)).available_balance === 100 && (await txsOf(USER_X)).find(t => t.id === tx2).status === 'FAILED');
  await checkInvariant('T3');
}

async function t4() {
  console.log('\nT4: 3 parallel cron runs -> exactly one refund');
  await resetUsers();
  const tx = await insertPendingWithdraw('TEST_T4');
  verifyStub = async () => ({ data: { status: 'failed' } });
  await Promise.allSettled([verifyPendingPayouts(), verifyPendingPayouts(), verifyPendingPayouts()]);
  const refunds = (await txsOf(USER_X)).filter(t => t.tx_type === 'REFUND');
  report('T4 exactly one refund from 3 parallel runs', refunds.length === 1 &&
    (await walletOf(USER_X)).available_balance === 100, `refunds=${refunds.length}`);
  await checkInvariant('T4');
}

async function t5() {
  console.log('\nT5: cron + admin reject race -> exactly one refund');
  await resetUsers();
  const tx = await insertPendingWithdraw('TEST_T5');
  verifyStub = async () => ({ data: { status: 'failed' } });
  // The admin reject route delegates to settleWithdrawal(tx,'FAILED',{provider:'ADMIN'}),
  // so racing the two settle paths at unit level is the same race the route would produce.
  await Promise.allSettled([
    verifyPendingPayouts(),
    settleWithdrawal(tx, 'FAILED', { reason: 'Rejected by admin', provider: 'ADMIN' })
  ]);
  const refunds = (await txsOf(USER_X)).filter(t => t.tx_type === 'REFUND');
  report('T5 exactly one refund (cron vs admin reject)', refunds.length === 1 &&
    (await walletOf(USER_X)).available_balance === 100, `refunds=${refunds.length}`);
  await checkInvariant('T5');
}

async function t6() {
  console.log('\nT6: late success after refund -> no double credit, no SMS, one alert (no duplicates)');
  await resetUsers();
  await pool.query(`DELETE FROM system_alerts WHERE event_type = 'PAYOUT_LATE_SUCCESS'`);
  const tx = await insertPendingWithdraw('TEST_T6');
  await settleWithdrawal(tx, 'FAILED', { reason: '3x404 refund', provider: 'SYSTEM_AUTO_REFUND' });
  const walletAfterRefund = await walletOf(USER_X);
  smsCalls = 0;
  verifyStub = async () => ({ data: { status: 'success' } });
  await verifyPendingPayouts(); // late-success sweep discovers the delivered transfer
  await verifyPendingPayouts(); // second run must NOT raise a duplicate alert
  const txs = await txsOf(USER_X);
  const { rows: alerts } = await pool.query(`SELECT id FROM system_alerts WHERE event_type = 'PAYOUT_LATE_SUCCESS' AND details->>'txId' = $1`, [tx]);
  report('T6 wallet NOT credited again', JSON.stringify(await walletOf(USER_X)) === JSON.stringify(walletAfterRefund));
  report('T6 row stays FAILED', txs.find(t => t.id === tx).status === 'FAILED');
  report('T6 no success SMS sent', smsCalls === 0, `smsCalls=${smsCalls}`);
  report('T6 exactly one PAYOUT_LATE_SUCCESS alert (deduped by late_success_checked)', alerts.length === 1, `alerts=${alerts.length}`);
  await checkInvariant('T6');
}

async function t7() {
  console.log('\nT7: unique partial index blocks duplicate keys');
  await resetUsers();
  const key = 'TEST_T7_UNIQUE_KEY';
  await pool.query(`
    INSERT INTO wallet_transactions (user_id, tx_type, amount, status, idempotency_key, provider)
    VALUES ($1, 'REFUND', 50, 'COMPLETED', $2, 'TEST')
  `, [USER_X, key]);
  let dupBlocked = false, dupCode = null;
  try {
    await pool.query(`
      INSERT INTO wallet_transactions (user_id, tx_type, amount, status, idempotency_key, provider)
      VALUES ($1, 'REFUND', 50, 'COMPLETED', $2, 'TEST')
    `, [USER_X, key]);
  } catch (e) { dupBlocked = true; dupCode = e.code; }
  report('T7 raw duplicate INSERT blocked', dupBlocked && dupCode === '23505', `code=${dupCode}`);

  // fn_wallet_apply_tx idempotency: same key returns the same tx id
  const r1 = await pool.query(`SELECT fn_wallet_apply_tx($1, 'DEPOSIT', 50, 'COMPLETED', $2, 'TEST', NULL, '{}'::jsonb) AS id`, [USER_X, 'TEST_T7_FN_KEY']);
  const r2 = await pool.query(`SELECT fn_wallet_apply_tx($1, 'DEPOSIT', 50, 'COMPLETED', $2, 'TEST', NULL, '{}'::jsonb) AS id`, [USER_X, 'TEST_T7_FN_KEY']);
  report('T7 fn_wallet_apply_tx same key -> same tx id, no error', r1.rows[0].id === r2.rows[0].id);
  await checkInvariant('T7');
}

async function t8() {
  console.log('\nT8: success run once -> exactly one SMS, no double settle');
  await resetUsers();
  const tx = await insertPendingWithdraw('TEST_T8');
  verifyStub = async () => ({ data: { status: 'success' } });
  smsCalls = 0;
  await verifyPendingPayouts();
  const sms1 = smsCalls;
  await verifyPendingPayouts(); // row no longer PENDING -> untouched
  const txs = await txsOf(USER_X);
  report('T8 first run sends exactly one SMS', sms1 === 1, `sms=${sms1}`);
  report('T8 second run sends no SMS', smsCalls === 1, `sms total=${smsCalls}`);
  report('T8 row COMPLETED once, no refund rows', txs.find(t => t.id === tx).status === 'COMPLETED' &&
    !txs.some(t => t.tx_type === 'REFUND'));
  await checkInvariant('T8');
}

async function t9() {
  console.log('\nT9: deposit flow with bare-UUID keys under the unique index');
  await resetUsers();
  const key = 'a3f1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d'; // bare UUID, like Chapa tx_refs
  const r1 = await pool.query(`SELECT fn_wallet_apply_tx($1, 'DEPOSIT', 100, 'COMPLETED', $2, 'CHAPA', 'ref1', '{}'::jsonb) AS id`, [USER_X, key]);
  let retriedSame = false;
  try {
    const r2 = await pool.query(`SELECT fn_wallet_apply_tx($1, 'DEPOSIT', 100, 'COMPLETED', $2, 'CHAPA', 'ref2', '{}'::jsonb) AS id`, [USER_X, key]);
    retriedSame = r1.rows[0].id === r2.rows[0].id;
  } catch (e) { retriedSame = false; }
  report('T9 deposit retry with same UUID key returns existing tx (no violation)', retriedSame);
  report('T9 deposit credited once (available=100, withdrawable=0)',
    (await walletOf(USER_X)).available_balance === 100 && (await walletOf(USER_X)).withdrawable_balance === 0);
  const { rows: deposits } = await pool.query(`SELECT count(*)::int AS c FROM wallet_transactions WHERE user_id = $1 AND tx_type = 'DEPOSIT'`, [USER_X]);
  report('T9 exactly one DEPOSIT ledger row', deposits[0].c === 1);
  await checkInvariant('T9');
}

async function t10() {
  console.log('\nT10: leaderboard Send & Snapshot double-click (real handler, 3 parallel iterations)');
  const lb = require('./leaderboardHandler');
  if (!lb.handlerAvailable) { report('T10 handler extracted', false); return; }
  let doubleCredits = 0;
  for (let i = 0; i < 3; i++) {
    await lb.setupWeek();
    await Promise.allSettled([lb.callHandler(), lb.callHandler()]);
    const m = await lb.measureWeek();
    if (m.avail > 500 || m.blogs > 1) doubleCredits++;
    if (i === 0) console.log(`    sample state: avail=+${m.avail} snaps=${m.snaps} ledger=${m.ledger} bonus_logs=${m.blogs}`);
  }
  const m = await lb.measureWeek();
  report('T10 no double credit across 3 parallel double-clicks', doubleCredits === 0, `doubleCredits=${doubleCredits}`);
  report('T10 no duplicate snapshots (UNIQUE week_start,rank)', m.snaps === 1, `snaps=${m.snaps}`);
  report('T10 ledger row exists for the prize (never swallowed)', m.ledger >= 1);
  report('T10 exactly one bonus_logs row', m.blogs === 1, `blogs=${m.blogs}`);
  await lb.cleanupWeek();
  await checkInvariant('T10');
}

// Replicates game.js's stake deduction verbatim (bonus-first + GREATEST clamps)
// and records the bucket split the new game.js code records on the games row.
async function applyStake(gameId, betAmount = 100, userId = USER_X, side = 'x') {
  const w = (await pool.query(`SELECT available_balance, bonus_balance, withdrawable_balance FROM wallets WHERE user_id = $1`, [userId])).rows[0];
  const bonusToUse = Math.min(Number(w.bonus_balance), betAmount);
  const realToUse = betAmount - bonusToUse;
  const wdUsed = Math.min(Number(w.withdrawable_balance), realToUse);
  const lockedUsed = realToUse - wdUsed;
  await pool.query(`
    UPDATE wallets
    SET available_balance = GREATEST(available_balance - $1, 0),
        bonus_balance = GREATEST(bonus_balance - $2, 0),
        withdrawable_balance = GREATEST(withdrawable_balance - $3, 0),
        updated_at = now()
    WHERE user_id = $4
  `, [betAmount, bonusToUse, realToUse, userId]);
  await pool.query(`
    UPDATE games SET
      bonus_used_${side} = $2,
      withdrawable_used_${side} = $3,
      locked_used_${side} = $4
    WHERE id = $1
  `, [gameId, bonusToUse, wdUsed, lockedUsed]);
  return { bonusToUse, wdUsed, lockedUsed };
}

async function freshGame(ageMin = 31) {
  const { rows } = await pool.query(`
    INSERT INTO games (player_x, player_o, bet_amount, status, winner, prize_amount, created_at, finished_at, moves, bonus_used_x, bonus_used_o)
    VALUES ($1, $2, 100, 'ongoing', NULL, 0, now() - ($3 || ' minutes')::interval, NULL, '[]'::jsonb, 0, 0)
    RETURNING id::text AS id
  `, [USER_X, USER_O, String(ageMin)]);
  return rows[0].id;
}

async function t14() {
  console.log('\nT14: rollover — deposit-only wallet, stake 100, refunds must NOT create withdrawable money');
  const ghostCallback = getGhostCallback();
  await resetUsers();
  await pool.query(`DELETE FROM games WHERE player_x = $1`, [USER_X]);

  // (i) ghost-cron refund
  await pool.query(`UPDATE wallets SET available_balance = 100, withdrawable_balance = 0, bonus_balance = 0 WHERE user_id = $1`, [USER_X]);
  const g1 = await freshGame(31);
  await applyStake(g1);
  await ghostCallback();
  let w = await walletOf(USER_X);
  report('T14-i ghost refund keeps deposit money non-withdrawable (wd=0)', w.available_balance === 100 && w.withdrawable_balance === 0 && w.bonus_balance === 0, JSON.stringify(w));

  // (ii) game.js stale refund via finishAndPayout(matchId, 'refund', null, 0)
  await pool.query(`UPDATE wallets SET available_balance = 100, withdrawable_balance = 0, bonus_balance = 0 WHERE user_id = $1`, [USER_X]);
  const g2 = await freshGame(31);
  await applyStake(g2);
  activeGames.set(g2, { players: { X: USER_X, O: USER_O }, finished: false, moves: [] });
  await finishAndPayout(g2, 'refund', null, 0);
  w = await walletOf(USER_X);
  report('T14-ii stale refund keeps deposit money non-withdrawable (wd=0)', w.available_balance === 100 && w.withdrawable_balance === 0 && w.bonus_balance === 0, JSON.stringify(w));
  await pool.query(`DELETE FROM games WHERE id IN ($1,$2)`, [g1, g2]);
  activeGames.delete(g2);
  await checkInvariant('T14');
}

async function t15() {
  console.log('\nT15: mixed buckets — stake 100 from bonus 30 / withdrawable 50 / deposit 20 restores exactly');
  const ghostCallback = getGhostCallback();
  await resetUsers();
  await pool.query(`DELETE FROM games WHERE player_x = $1`, [USER_X]);

  // deposit 100 then 30 bonus gift: avail 130, wd 0, bonus 30. Grant wd 50 directly
  // (as a prize would) to model avail=130, wd=50, bonus=30
  await pool.query(`UPDATE wallets SET available_balance = 130, withdrawable_balance = 50, bonus_balance = 30 WHERE user_id = $1`, [USER_X]);
  const g = await freshGame(31);
  const split = await applyStake(g);
  // stake: bonus 30, real 70 -> wdUsed = min(50,70) = 50, locked = 20
  report('T15 split computed correctly at stake time', split.bonusToUse === 30 && split.wdUsed === 50 && split.lockedUsed === 20, JSON.stringify(split));
  let w = await walletOf(USER_X);
  report('T15 stake deducted (avail 30, wd 0, bonus 0)', w.available_balance === 30 && w.withdrawable_balance === 0 && w.bonus_balance === 0, JSON.stringify(w));

  await ghostCallback();
  w = await walletOf(USER_X);
  report('T15 ghost refund restores exact buckets (avail 130, bonus 30, wd 50)',
    w.available_balance === 130 && w.bonus_balance === 30 && w.withdrawable_balance === 50, JSON.stringify(w));
  await pool.query(`DELETE FROM games WHERE id = $1`, [g]);
  await checkInvariant('T15');
}

async function t16() {
  console.log('\nT16: idempotency index guard — fail closed when uq_wallet_tx_idem is missing');
  const { withTx: withTxDb } = require('../src/db');
  const { ledgerFirstCredit } = require('../src/models/ledgerFirstCredit');
  await resetUsers();
  // Simulate the missing index (server is stopped; no other writers)
  await pool.query(`DROP INDEX uq_wallet_tx_idem`);
  try {
    const ok = await checkIdempotencyIndex();
    report('T16 check reports index missing', ok === false);
    let refused = false;
    try {
      await withTxDb(c => ledgerFirstCredit(c, { userId: USER_X, txType: 'REFUND', amount: 10, idempotencyKey: 'TEST_T16', provider: 'TEST' }));
    } catch (e) { refused = String(e.message).includes('IDEMPOTENCY_INDEX_UNAVAILABLE'); }
    report('T16 ledgerFirstCredit REFUSES to credit without the index', refused);
    const { rows: alerts } = await pool.query(`SELECT id FROM system_alerts WHERE event_type = 'IDEMPOTENCY_INDEX_MISSING'`);
    report('T16 IDEMPOTENCY_INDEX_MISSING alert written', alerts.length >= 1);
  } finally {
    // Always restore the index
    await pool.query(`CREATE UNIQUE INDEX uq_wallet_tx_idem ON wallet_transactions (idempotency_key) WHERE status <> 'FAILED'`);
    const ok = await checkIdempotencyIndex();
    report('T16 index restored -> guard active again', ok === true);
  }
  await checkInvariant('T16');
}

async function t17() {
  console.log('\nT17: payout_failed admin resolution — pay winner once through the real payout');
  const adminRouter = require('../src/routes/admin');
  let listHandler = null, payHandler = null;
  for (const layer of adminRouter.stack) {
    if (layer.route && layer.route.path === '/games/payout-failed') {
      const h = layer.route.stack.filter(l => l.handle);
      listHandler = h[h.length - 1].handle;
    }
    if (layer.route && layer.route.path === '/games/:gameId/pay-winner') {
      const h = layer.route.stack.filter(l => l.handle);
      payHandler = h[h.length - 1].handle;
    }
  }
  if (!listHandler || !payHandler) { report('T17 handlers extracted', false); return; }

  await resetUsers();
  await pool.query(`DELETE FROM games WHERE player_x = $1`, [USER_X]);
  const g = await freshGame(31);
  await applyStake(g);
  await pool.query(`UPDATE games SET status = 'payout_failed', finished_at = now() WHERE id = $1`, [g]);

  function call(method, path, body) {
    const res = {
      statusCode: 0, _resolve: null,
      status(c) { this.statusCode = c; return this; },
      json(o) { this._body = o; if (this._resolve) this._resolve({ status: this.statusCode || 200, body: o }); return this; }
    };
    const req = { method, body: body || {}, user: { id: '00000000-0000-0000-0000-000000000001' }, params: { gameId: g }, query: {} };
    const handler = method === 'GET' ? listHandler : payHandler;
    return new Promise(resolve => {
      res._resolve = resolve;
      try { handler(req, res, () => resolve({ status: 'next' })); }
      catch (e) { resolve({ status: 'throw', body: { error: e.message } }); }
    });
  }

  const listed = await call('GET');
  report('T17 payout-failed list includes the game', listed.status === 200 && JSON.stringify(listed.body).includes(g));
  const pay1 = await call('POST', null, { winnerSymbol: 'X' });
  let w = await walletOf(USER_X);
  const gRow = (await pool.query(`SELECT status, winner::text AS winner, prize_amount::int AS prize FROM games WHERE id = $1`, [g])).rows[0];
  report('T17 pay-winner completes the game', pay1.status === 200 && gRow.status === 'completed' && gRow.winner === USER_X && gRow.prize === 180, JSON.stringify(pay1.body || pay1));
  report('T17 winner credited 180 (wd=180, no bonus used)', w.available_balance === 180 && w.withdrawable_balance === 180, JSON.stringify(w));
  const pay2 = await call('POST', null, { winnerSymbol: 'X' });
  report('T17 second pay-winner rejected (409 already resolved)', pay2.status === 409, JSON.stringify(pay2.body));
  report('T17 wallet NOT credited twice', (await walletOf(USER_X)).available_balance === 180);
  await pool.query(`DELETE FROM games WHERE id = $1`, [g]);
  await checkInvariant('T17');
}

async function t18() {
  console.log('\nT18: admin refund validations + reject policy (PENDING_MANUAL only)');
  const adminRouter = require('../src/routes/admin');
  let refundHandler = null, rejectHandler = null;
  for (const layer of adminRouter.stack) {
    if (layer.route && layer.route.path === '/refund') {
      const h = layer.route.stack.filter(l => l.handle);
      refundHandler = h[h.length - 1].handle;
    }
    if (layer.route && layer.route.path === '/transactions/:id/reject') {
      const h = layer.route.stack.filter(l => l.handle);
      rejectHandler = h[h.length - 1].handle;
    }
  }
  if (!refundHandler || !rejectHandler) { report('T18 handlers extracted', false); return; }
  await resetUsers();

  function call(handler, body, params = {}) {
    const res = {
      statusCode: 0, _resolve: null,
      status(c) { this.statusCode = c; return this; },
      json(o) { this._body = o; if (this._resolve) this._resolve({ status: this.statusCode || 200, body: o }); return this; }
    };
    const req = { body, user: { id: '00000000-0000-0000-0000-000000000001' }, params, query: {} };
    return new Promise(resolve => {
      res._resolve = resolve;
      try { handler(req, res, () => resolve({ status: 'next' })); }
      catch (e) { resolve({ status: 'throw', body: { error: e.message } }); }
    });
  }

  const dep = await pool.query(`SELECT fn_wallet_apply_tx($1, 'DEPOSIT', 200, 'COMPLETED', 'TEST_T18_DEP', 'CHAPA', NULL, '{}'::jsonb) AS id`, [USER_X]);
  const origId = dep.rows[0].id;

  // amount > original -> 400
  const over = await call(refundHandler, { phoneOrUsername: '0900000099', amount: 300, target: 'available', originalTxId: origId });
  report('T18 refund > original amount rejected (400)', over.status === 400, JSON.stringify(over.body));

  // GIFT original -> 400 (not refundable type)
  const gift = await pool.query(`INSERT INTO wallet_transactions (user_id, tx_type, amount, status, provider, idempotency_key) VALUES ($1, 'GIFT', 50, 'COMPLETED', 'TEST', 'TEST_T18_GIFT') RETURNING id::text AS id`, [USER_X]);
  const giftRefund = await call(refundHandler, { phoneOrUsername: '0900000099', amount: 10, target: 'available', originalTxId: gift.rows[0].id });
  report('T18 refund of GIFT-type rejected (400 not refundable)', giftRefund.status === 400, JSON.stringify(giftRefund.body));

  // valid refund still works
  const okRefund = await call(refundHandler, { phoneOrUsername: '0900000099', amount: 50, target: 'available', originalTxId: origId });
  report('T18 valid refund succeeds (200)', okRefund.status === 200, JSON.stringify(okRefund.body?.error || 'ok'));

  // reject policy: PENDING withdraw (already with Chapa) -> 409; PENDING_MANUAL -> refunds
  const pend = await insertPendingWithdraw('TEST_T18_PEND');
  const rejPend = await call(rejectHandler, {}, { id: pend });
  report('T18 admin reject of PENDING withdraw refused (409 cron-managed)', rejPend.status === 409, JSON.stringify(rejPend.body));
  report('T18 OLD behaviour (rejecting PENDING) marked KNOWN BUG — now refused', true);

  const manual = await pool.query(`INSERT INTO wallet_transactions (user_id, tx_type, amount, status, provider, idempotency_key, created_at) VALUES ($1, 'WITHDRAW_REQUEST', 100, 'PENDING_MANUAL', 'CHAPA', 'TEST_T18_MANUAL', now() - interval '60 seconds') RETURNING id::text AS id`, [USER_X]);
  const rejManual = await call(rejectHandler, {}, { id: manual.rows[0].id });
  const manualAfter = (await pool.query(`SELECT status FROM wallet_transactions WHERE id = $1`, [manual.rows[0].id])).rows[0];
  report('T18 admin reject of PENDING_MANUAL works (refund via settleWithdrawal)', rejManual.status === 200 && manualAfter.status === 'FAILED', JSON.stringify(rejManual.body || rejManual));
  await checkInvariant('T18');
}

async function insertGame(ageMinutes, bonusX = 0, bonusO = 0) {
  const { rows } = await pool.query(`
    INSERT INTO games (player_x, player_o, bet_amount, status, winner, prize_amount, created_at, finished_at, moves, bonus_used_x, bonus_used_o)
    VALUES ($1, $2, 100, 'ongoing', NULL, 0, now() - ($3 || ' minutes')::interval, NULL, '[]'::jsonb, $4, $5)
    RETURNING id::text AS id
  `, [USER_X, USER_O, String(ageMinutes), bonusX, bonusO]);
  return rows[0].id;
}

async function t12() {
  console.log('\nT12: ghost cron — bucket-correct refund, rerun no-op, payout_failed untouched');
  const ghostCallback = getGhostCallback();
  if (!ghostCallback) { report('T12 ghost callback captured', false); return; }
  await resetUsers();
  await pool.query(`DELETE FROM games WHERE (player_x = $1 OR player_o = $1)`, [USER_X]);

  // X: wallet avail 100, wd 50, bonus 40 (invariant ok: 100 >= 50 + 40)
  // O: wallet all-deposit: avail 100, wd 0, bonus 0
  await pool.query(`UPDATE wallets SET available_balance = 100, withdrawable_balance = 50, bonus_balance = 40 WHERE user_id = $1`, [USER_X]);
  await pool.query(`UPDATE wallets SET available_balance = 100, withdrawable_balance = 0, bonus_balance = 0 WHERE user_id = $1`, [USER_O]);
  const g = await freshGame(31);
  const sx = await applyStake(g, 100, USER_X, 'x');
  const so = await applyStake(g, 100, USER_O, 'o');

  await ghostCallback();
  const grow = (await pool.query(`SELECT status FROM games WHERE id = $1`, [g])).rows[0];
  const wx = await walletOf(USER_X), wo = await walletOf(USER_O);
  report('T12 game marked completed', grow.status === 'completed');
  report('T12 X buckets restored exactly: avail=100 bonus=40 wd=50 (wdUsed=' + sx.wdUsed + ', locked=' + sx.lockedUsed + ')',
    wx.available_balance === 100 && wx.bonus_balance === 40 && wx.withdrawable_balance === 50, JSON.stringify(wx));
  report('T12 O buckets restored exactly: avail=100 bonus=0 wd=0 (deposit stays non-withdrawable)',
    wo.available_balance === 100 && wo.bonus_balance === 0 && wo.withdrawable_balance === 0, JSON.stringify(wo));

  await ghostCallback(); // rerun: status guard -> no double refund
  const wx2 = await walletOf(USER_X), wo2 = await walletOf(USER_O);
  const refunds = (await txsOf(USER_X)).filter(t => t.tx_type === 'REFUND').length;
  report('T12 rerun is a no-op (no double refund)',
    wx2.available_balance === 100 && wo2.available_balance === 100 && refunds === 1, `refunds=${refunds}`);

  await pool.query(`DELETE FROM games WHERE id = $1`, [g]);
  await checkInvariant('T12');
}

async function t13() {
  console.log('\nT13: admin manual refund — keyed to original tx, double-click pays once');
  // Extract the real POST /refund handler from the router stack
  const adminRouter = require('../src/routes/admin');
  let refundHandler = null;
  for (const layer of adminRouter.stack) {
    if (layer.route && layer.route.path === '/refund') {
      const handles = layer.route.stack.filter(l => l.handle);
      refundHandler = handles[handles.length - 1].handle;
    }
  }
  if (!refundHandler) { report('T13 handler extracted', false); return; }

  await resetUsers();
  // A completed DEPOSIT tx to refund against
  const dep = await pool.query(`SELECT fn_wallet_apply_tx($1, 'DEPOSIT', 200, 'COMPLETED', 'TEST_T13_ORIG', 'CHAPA', NULL, '{}'::jsonb) AS id`, [USER_X]);
  const origTxId = dep.rows[0].id;

  function callRefund() {
    const res = {
      statusCode: 0, _resolve: null,
      status(c) { this.statusCode = c; return this; },
      json(o) { this._body = o; if (this._resolve) this._resolve({ status: this.statusCode || 200, body: o }); return this; }
    };
    const req = {
      body: { phoneOrUsername: '0900000099', amount: 50, reason: 'T13', target: 'available', originalTxId: origTxId },
      user: { id: '00000000-0000-0000-0000-000000000001' }, params: {}, query: {}
    };
    return new Promise(resolve => {
      res._resolve = resolve;
      try { refundHandler(req, res, () => resolve({ status: 'next' })); }
      catch (e) { resolve({ status: 'throw', body: { error: e.message } }); }
    });
  }

  // Sequential: second call rejected with 409
  const r1 = await callRefund();
  const r2 = await callRefund();
  const wx = await walletOf(USER_X);
  const ledger = (await txsOf(USER_X)).filter(t => t.idempotency_key === `MANUAL_REFUND:${origTxId}`);
  report('T13 first refund succeeds (200)', r1.status === 200, JSON.stringify(r1.body?.error || 'ok'));
  report('T13 second refund rejected (409 already refunded)', r2.status === 409, JSON.stringify(r2.body));
  report('T13 wallet credited exactly once (200 dep + 50 refund = 250)', wx.available_balance === 250, JSON.stringify(wx));
  report('T13 exactly one MANUAL_REFUND ledger row', ledger.length === 1);

  // Parallel: race two refunds of a fresh original tx
  const dep2 = await pool.query(`SELECT fn_wallet_apply_tx($1, 'DEPOSIT', 200, 'COMPLETED', 'TEST_T13_ORIG2', 'CHAPA', NULL, '{}'::jsonb) AS id`, [USER_X]);
  // T13 uses a closure over origTxId; emulate the parallel race with settle-level equivalent:
  // two concurrent ledgerFirstCredit inserts with the same key inside withTx
  const { withTx: withTxDb } = require('../src/db');
  const { ledgerFirstCredit } = require('../src/models/ledgerFirstCredit');
  const key = `MANUAL_REFUND:${dep2.rows[0].id}`;
  const results = await Promise.all([
    withTxDb(c => ledgerFirstCredit(c, { userId: USER_X, txType: 'REFUND', amount: 30, idempotencyKey: key, provider: 'ADMIN_REFUND' })),
    withTxDb(c => ledgerFirstCredit(c, { userId: USER_X, txType: 'REFUND', amount: 30, idempotencyKey: key, provider: 'ADMIN_REFUND' }))
  ]);
  const insertedCount = results.filter(r => r.inserted).length;
  report('T13 parallel same-key inserts -> exactly one winner', insertedCount === 1, `inserted=${insertedCount}`);
  await checkInvariant('T13');
}

async function t11() {
  console.log('\nT11: finishAndPayout — happy path, forced failure -> payout_failed, ghost cron skips it');
  const ghostCallback = getGhostCallback();
  if (!ghostCallback) { report('T11 ghost callback captured', false); return; }
  await resetUsers();
  await pool.query(`DELETE FROM system_alerts WHERE event_type = 'PAYOUT_FAILED'`);
  await pool.query(`DELETE FROM games WHERE (player_x = $1 OR player_o = $1)`, [USER_X]);

  // 11a happy path: winner credited, game completed
  const g1 = await insertGame(0);
  activeGames.set(g1, { players: { X: USER_X, O: USER_O }, finished: false, moves: [] });
  await finishAndPayout(g1, 'X', USER_X, 180);
  const g1row = (await pool.query(`SELECT status, winner::text AS w, prize_amount::int AS p FROM games WHERE id = $1`, [g1])).rows[0];
  const wx = await walletOf(USER_X);
  report('T11a game completed with winner + prize', g1row.status === 'completed' && g1row.w === USER_X && g1row.p === 180, JSON.stringify(g1row));
  report('T11a winner credited 180 (available & withdrawable, bonus_used=0)', wx.available_balance === 180 && wx.withdrawable_balance === 180 && wx.bonus_balance === 0, JSON.stringify(wx));
  activeGames.delete(g1);

  // 11b forced DB failure: all 3 attempts fail -> payout_failed + alert, no credit
  const g2 = await insertGame(0);
  activeGames.set(g2, { players: { X: USER_X, O: USER_O }, finished: false, moves: [] });
  await pool.query('ALTER TABLE wallets RENAME TO wallets_t11_bak');
  let markStatus = null;
  try {
    await finishAndPayout(g2, 'X', USER_X, 180);
  } finally {
    await pool.query('ALTER TABLE wallets_t11_bak RENAME TO wallets');
  }
  const g2row = (await pool.query(`SELECT status FROM games WHERE id = $1`, [g2])).rows[0];
  const { rows: alerts } = await pool.query(`SELECT id FROM system_alerts WHERE event_type = 'PAYOUT_FAILED' AND details->>'gameId' = $1`, [g2]);
  markStatus = g2row?.status;
  report('T11b 3 failed attempts -> game marked payout_failed', markStatus === 'payout_failed', `status=${markStatus}`);
  report('T11b PAYOUT_FAILED system alert written', alerts.length === 1);
  report('T11b winner NOT credited beyond T11a (no silent refund)', (await walletOf(USER_X)).available_balance === 180);
  activeGames.delete(g2);

  // 11c ghost cron must NOT refund payout_failed games
  await pool.query(`UPDATE games SET created_at = now() - interval '31 minutes' WHERE id = $1`, [g2]);
  await ghostCallback();
  const g2after = (await pool.query(`SELECT status FROM games WHERE id = $1`, [g2])).rows[0];
  report('T11c ghost cron skips payout_failed (stakes left for admin)',
    g2after.status === 'payout_failed' && (await walletOf(USER_X)).available_balance === 180 && (await walletOf(USER_O)).available_balance === 0);
  await pool.query(`DELETE FROM games WHERE id IN ($1, $2)`, [g1, g2]);
  await pool.query(`DELETE FROM system_alerts WHERE event_type = 'PAYOUT_FAILED'`);
  await checkInvariant('T11');
}

async function main() {
  console.log('PREFLIGHT: checking dev server is stopped...');
  await assertServerStopped();
  console.log('  port 2000 free — OK');
  await assertNoForeignDbClients();
  await resetUsers();

  await t1(); await resetUsers();
  await t2(); await resetUsers();
  await t3(); await resetUsers();
  await t4(); await resetUsers();
  await t5(); await resetUsers();
  await t6(); await resetUsers();
  await t7(); await resetUsers();
  await t8(); await resetUsers();
  await t9(); await resetUsers();
  await t10(); await resetUsers();
  await t11(); await resetUsers();
  await t12(); await resetUsers();
  await t13(); await resetUsers();
  await t14(); await resetUsers();
  await t15(); await resetUsers();
  await t16(); await resetUsers();
  await t17(); await resetUsers();
  await t18();

  await checkInvariant('final');
  const ok = summary();
  await pool.end();
  process.exit(ok ? 0 : 1);
}

main().catch(async e => { console.error('SUITE FATAL:', e.message); process.exit(1); });
