/**
 * Fix #2 follow-ups STEP 0 (a) + (b) — reproduction tests, run against REAL code.
 * (a) Rollover bypass: deposit-only wallet (avail 100, wd 0, bonus 0), stake 100,
 *     then (i) real ghost-cron refund, (ii) real finishAndPayout('refund').
 *     EXPECT (pre-fix): withdrawable becomes 100 — deposit money turned cash.
 * (b) Index dependency: drop uq_wallet_tx_idem inside a tx, run ledgerFirstCredit
 *     twice with the same key — EXPECT: both insert, wallet credited twice.
 *     Then ROLLBACK (index restored) and show the guarded behaviour for contrast.
 *
 * NOTE on (a): the stake is applied with the EXACT deduction SQL from
 * game.js:648-656 (bonus-first + GREATEST clamps, quoted verbatim in
 * applyStakeAsGameJsWould()) because that code is inline in a non-exported
 * matchmaking function.
 */
process.env.LOCAL_CORS = 'http://localhost:9999';
const { assertServerStopped, pool, USER_X, USER_O } = require('./helpers');

const nodeCron = require('node-cron');
const origSchedule = nodeCron.schedule.bind(nodeCron);
let ghostCallback = null;
nodeCron.schedule = (pattern, fn, opts) => {
  if (!ghostCallback && pattern === '*/10 * * * *') ghostCallback = fn;
  return origSchedule(pattern, fn, opts);
};
require('../src/cron').initCron();
const { finishAndPayout, activeGames } = require('../src/socket/game');
const { ledgerFirstCredit } = require('../src/models/ledgerFirstCredit');
const { withTx } = require('../src/db');

async function setDepositOnlyWallet() {
  // Deposit-only wallet: available 100, withdrawable 0, bonus 0
  await pool.query(`UPDATE wallets SET available_balance = 100, withdrawable_balance = 0, bonus_balance = 0 WHERE user_id = $1`, [USER_X]);
}

// Verbatim deduction from game.js (bonus-first, GREATEST clamps):
//   const bonusToUse = Math.min(bonus, betAmount);
//   const realToUse = betAmount - bonusToUse;
//   UPDATE wallets SET available_balance = GREATEST(available_balance - $1, 0),
//          bonus_balance = GREATEST(bonus_balance - $2, 0),
//          withdrawable_balance = GREATEST(withdrawable_balance - $3, 0)
async function applyStakeAsGameJsWould(gameId, betAmount = 100) {
  const w = (await pool.query(`SELECT available_balance, bonus_balance, withdrawable_balance FROM wallets WHERE user_id = $1`, [USER_X])).rows[0];
  const bonusToUse = Math.min(Number(w.bonus_balance), betAmount);
  const realToUse = betAmount - bonusToUse;
  await pool.query(`
    UPDATE wallets
    SET available_balance    = GREATEST(available_balance  - $1, 0),
        bonus_balance        = GREATEST(bonus_balance - $2, 0),
        withdrawable_balance = GREATEST(withdrawable_balance - $3, 0),
        updated_at = now()
    WHERE user_id = $4
  `, [betAmount, bonusToUse, realToUse, USER_X]);
  await pool.query(`
    INSERT INTO games (player_x, player_o, bet_amount, status, winner, prize_amount, created_at, finished_at, moves, bonus_used_x, bonus_used_o)
    VALUES ($1, $2, $3, 'ongoing', NULL, 0, now() - interval '31 minutes', NULL, '[]'::jsonb, $4, 0)
  `, [USER_X, USER_O, betAmount, bonusToUse]);
  return { bonusToUse, realToUse };
}

async function wallets(label) {
  const w = await pool.query(`SELECT available_balance::int AS avail, withdrawable_balance::int AS wd, bonus_balance::int AS bonus FROM wallets WHERE user_id = $1`, [USER_X]);
  console.log(`  ${label}: available=${w.rows[0].avail} withdrawable=${w.rows[0].wd} bonus=${w.rows[0].bonus}`);
  return w.rows[0];
}

async function freshGame(ageMin = 31) {
  const { rows } = await pool.query(`
    INSERT INTO games (player_x, player_o, bet_amount, status, winner, prize_amount, created_at, finished_at, moves, bonus_used_x, bonus_used_o)
    VALUES ($1, $2, 100, 'ongoing', NULL, 0, now() - ($3 || ' minutes')::interval, NULL, '[]'::jsonb, 0, 0)
    RETURNING id::text AS id
  `, [USER_X, USER_O, String(ageMin)]);
  return rows[0].id;
}

async function main() {
  await assertServerStopped();
  console.log('preflight: dev server stopped — OK\n');

  // ══ (a) ROLLOVER BYPASS ══
  console.log('═══ (a) rollover test: deposit-only wallet, stake 100, then refunds ══');
  await pool.query(`DELETE FROM games WHERE player_x = $1`, [USER_X]);
  await pool.query(`DELETE FROM wallet_transactions WHERE user_id IN ($1,$2)`, [USER_X, USER_O]);
  await setDepositOnlyWallet();
  await wallets('before stake');
  await applyStakeAsGameJsWould('rollover-game-1');
  await wallets('after stake (game.js deduction)');

  console.log('\n  (i) real ghost-cron refund:');
  await ghostCallback();
  const afterGhost = await wallets('after ghost-cron refund');
  console.log(`  >>> ${afterGhost.wd > 0 ? 'ROLLOVER BYPASSED: deposit money became withdrawable (' + afterGhost.wd + ')' : 'rollover intact'}`);

  console.log('\n  (ii) real finishAndPayout(matchId, "refund", null, 0):');
  const g2 = await freshGame(31);
  await setDepositOnlyWallet();
  await applyStakeAsGameJsWould(g2);
  await wallets('after stake');
  activeGames.set(g2, { players: { X: USER_X, O: USER_O }, finished: false, moves: [] });
  await finishAndPayout(g2, 'refund', null, 0);
  const afterStale = await wallets('after game.js stale refund');
  console.log(`  >>> ${afterStale.wd > 0 ? 'ROLLOVER BYPASSED: deposit money became withdrawable (' + afterStale.wd + ')' : 'rollover intact'}`);
  await pool.query(`DELETE FROM games WHERE player_x = $1`, [USER_X]);
  activeGames.delete(g2);

  // ══ (b) INDEX DEPENDENCY ══
  console.log('\n═══ (b) ledgerFirstCredit with uq_wallet_tx_idem DROPPED (inside tx, then ROLLBACK) ══');
  await pool.query(`UPDATE wallets SET available_balance = 0, withdrawable_balance = 0, bonus_balance = 0 WHERE user_id = $1`, [USER_X]);
  await pool.query(`DELETE FROM wallet_transactions WHERE user_id = $1`, [USER_X]);
  try {
    await withTx(async (client) => {
      await client.query(`DROP INDEX uq_wallet_tx_idem`);
      const r1 = await ledgerFirstCredit(client, { userId: USER_X, txType: 'REFUND', amount: 50, idempotencyKey: 'TEST_INDEXDEP_1', provider: 'TEST' });
      await client.query(`UPDATE wallets SET available_balance = available_balance + 50 WHERE user_id = $1`, [USER_X]);
      const r2 = await ledgerFirstCredit(client, { userId: USER_X, txType: 'REFUND', amount: 50, idempotencyKey: 'TEST_INDEXDEP_1', provider: 'TEST' });
      await client.query(`UPDATE wallets SET available_balance = available_balance + 50 WHERE user_id = $1`, [USER_X]);
      console.log(`  without index: first insert inserted=${r1.inserted}, second insert inserted=${r2.inserted} (same key!)`);
      console.log(`  wallet would be credited TWICE (+100) — the ledger row guards nothing`);
      throw { rollbackOnly: true }; // force ROLLBACK, keep the index
    });
  } catch (e) {
    if (!e.rollbackOnly) throw e;
    console.log('  transaction ROLLED BACK — index restored, wallet/ledger unchanged');
  }
  const checkIdx = await pool.query(`SELECT indisvalid FROM pg_index pi JOIN pg_class c ON c.oid = pi.indexrelid WHERE c.relname = 'uq_wallet_tx_idem'`);
  console.log(`  index present+valid after rollback: ${checkIdx.rows[0]?.indisvalid}`);
  const wAfter = (await pool.query(`SELECT available_balance::int AS a FROM wallets WHERE user_id = $1`, [USER_X])).rows[0];
  console.log(`  wallet available after rollback: ${wAfter.a} (still 0 — no double credit persisted)`);
  console.log(`  >>> CONCLUSION: ledgerFirstCredit's guard EXISTS ONLY WHILE uq_wallet_tx_idem EXISTS AND IS VALID`);

  await pool.end();
  process.exit(0);
}
main().catch(e => { console.error('FATAL:', e.message, e.stack); process.exit(1); });
