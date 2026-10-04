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
  await t10();

  await checkInvariant('final');
  const ok = summary();
  await pool.end();
  process.exit(ok ? 0 : 1);
}

main().catch(async e => { console.error('SUITE FATAL:', e.message); process.exit(1); });
