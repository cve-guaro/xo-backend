/**
 * FIX #3 STEP 0a — stake race / insufficient balance / clamped-stake refund.
 * Everything runs against the REAL deductStake (src/models/stake.js) and the
 * REAL withdrawal reservation primitive (fn_wallet_apply_tx + the reservation
 * UPDATE from payments.service.js requestWithdraw, quoted verbatim below).
 */
process.env.LOCAL_CORS = 'http://localhost:9999';
const { assertServerStopped, pool, USER_X, USER_O } = require('./helpers');
const { deductStake } = require('../src/models/stake');

const BET = 100;

// READ-COMMITTED tx wrapper — identical to game.js's tx() helper
async function plainTx(fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally { c.release(); }
}

// The REAL withdrawal reservation, verbatim from requestWithdraw
// (payments.service.js:206-257): getWalletForUpdate (FOR UPDATE) + withdrawable
// check + fn_wallet_apply_tx (also locks) + the reservation UPDATE (no clamp).
async function reserveWithdraw(userId, amount, key) {
  return plainTx(async (client) => {
    // payments.service.js:208-215 — balance check under FOR UPDATE
    const walletCheck = await client.query(
      `SELECT user_id, available_balance, withdrawable_balance FROM wallets WHERE user_id = $1::uuid FOR UPDATE`,
      [userId]
    );
    const withdrawable = Number(walletCheck.rows[0]?.withdrawable_balance || 0);
    if (withdrawable < amount) {
      const err = new Error("Insufficient withdrawable balance.");
      err.status = 400;
      throw err;
    }
    // payments.service.js:238-247 — fn_wallet_apply_tx (locks the wallet row again)
    const txRes = await client.query(
      `SELECT fn_wallet_apply_tx($1, 'WITHDRAW_REQUEST', $2, 'PENDING', $3, 'CHAPA', NULL, '{}'::jsonb) AS tx_id`,
      [userId, amount, key]
    );
    // payments.service.js:252-257 — reservation UPDATE (no clamp)
    await client.query(
      `UPDATE wallets
       SET available_balance = available_balance - $1,
           withdrawable_balance = withdrawable_balance - $1
       WHERE user_id = $2`,
      [amount, userId]
    );
    return txRes.rows[0].tx_id;
  });
}

// Real stake on behalf of both players (fresh games row each iteration)
async function stake(gameTag) {
  return plainTx(async (client) => {
    const stakes = await deductStake(client, { playerXId: USER_X, playerOId: USER_O, betAmount: BET });
    const g = await client.query(
      `INSERT INTO games (player_x, player_o, bet_amount, status, moves, bonus_used_x, bonus_used_o, withdrawable_used_x, withdrawable_used_o, locked_used_x, locked_used_o)
       VALUES ($1, $2, $3, 'ongoing', '[]'::jsonb, $4, $5, $6, $7, $8, $9) RETURNING id::text AS id`,
      [USER_X, USER_O, BET,
        stakes[USER_X].bonusUsed, stakes[USER_O].bonusUsed,
        stakes[USER_X].wdUsed, stakes[USER_O].wdUsed,
        stakes[USER_X].lockedUsed, stakes[USER_O].lockedUsed]
    );
    return g.rows[0].id;
  }).catch(e => ({ error: e.message }));
}

async function walletOf(userId) {
  const w = await pool.query(
    `SELECT available_balance::int AS avail, withdrawable_balance::int AS wd, bonus_balance::int AS bonus FROM wallets WHERE user_id = $1`, [userId]);
  return w.rows[0];
}

async function totalOf(userId) {
  const w = await walletOf(userId);
  return w.avail + w.wd + w.bonus;
}

async function main() {
  await assertServerStopped();
  console.log('preflight: dev server stopped — OK\n');

  // ══ (i) withdraw + stake in parallel, 50 iterations ══
  console.log('═══ (i) withdraw reservation vs stake — 50 parallel iterations ══');
  await pool.query(`DELETE FROM games WHERE player_x = $1`, [USER_X]);
  await pool.query(`DELETE FROM wallet_transactions WHERE user_id IN ($1,$2)`, [USER_X, USER_O]);
  // USER_X starts with available 200 / withdrawable 100 / bonus 0 (total 300)
  // USER_O is a deep-pocketed control (total 1000, untouched by the race wallet maths)
  await pool.query(`UPDATE wallets SET available_balance = 200, withdrawable_balance = 100, bonus_balance = 0 WHERE user_id = $1`, [USER_X]);
  await pool.query(`UPDATE wallets SET available_balance = 1000, withdrawable_balance = 0, bonus_balance = 0 WHERE user_id = $1`, [USER_O]);
  const startX = await totalOf(USER_X);

  let races = [], insufficient = 0, staked = 0, reserved = 0, negatives = 0;
  for (let i = 1; i <= 50; i++) {
    const [wdRes, stRes] = await Promise.allSettled([
      reserveWithdraw(USER_X, BET, 'RACE_WD_' + i),
      stake('race_' + i)
    ]);
    const wdOk = wdRes.status === 'fulfilled' && !wdRes.value.error;
    const stOk = stRes.status === 'fulfilled' && !stRes.value.error;
    if (wdOk) reserved++;
    if (stOk) { staked++; } else if (String(stRes.value?.error || stRes.reason?.message || '').includes('INSUFFICIENT')) insufficient++;
    const w = await walletOf(USER_X);
    if (w.avail < 0 || w.wd < 0 || w.bonus < 0) { negatives++; console.log(`  iter ${i}: NEGATIVE wallet ${JSON.stringify(w)}`); }
    races.push({ i, wdOk, stOk, wallet: w });
  }
  const endX = await totalOf(USER_X);
  const expectedX = startX - reserved * BET - staked * BET;
  console.log(`  reservations succeeded: ${reserved}/50, stakes succeeded: ${staked}/50, INSUFFICIENT_BALANCE rejections: ${insufficient}`);
  console.log(`  negative wallet events: ${negatives}`);
  console.log(`  USER_X total: start=${startX} end=${endX} expected=${expectedX} (reserved ${reserved} x ${BET} + staked ${staked} x ${BET})`);
  const moneyCreated = endX - expectedX;
  console.log(`  >>> ${moneyCreated === 0 ? 'NO MONEY CREATED — ledger maths exact' : 'MONEY CREATED/LOST: ' + moneyCreated}`);
  console.log(`  last iteration state: ${JSON.stringify(races[races.length - 1].wallet)}`);

  // conservation after refunding every stake via the ghost semantics
  await pool.query(`UPDATE games SET status='completed', winner=NULL, finished_at=now() WHERE player_x=$1`, [USER_X]);
  // refund using each game's recorded split (what the ghost cron does)
  const games = await pool.query(`SELECT id, bet_amount, bonus_used_x, withdrawable_used_x FROM games WHERE player_x = $1 AND status='completed'`, [USER_X]);
  for (const g of games.rows) {
    await plainTx(async (c) => {
      await c.query(`UPDATE wallets SET available_balance = available_balance + $1, bonus_balance = bonus_balance + $2, withdrawable_balance = withdrawable_balance + $3 WHERE user_id = $4`,
        [Number(g.bet_amount), Number(g.bonus_used_x), Number(g.withdrawable_used_x), USER_X]);
    });
  }
  const afterRefundX = await totalOf(USER_X);
  const expectedAfterRefund = startX - reserved * BET;
  console.log(`  after refunding all ${games.rows.length} staked games: total=${afterRefundX} expected=${expectedAfterRefund} -> ${afterRefundX === expectedAfterRefund ? 'EXACT' : 'DRIFT ' + (afterRefundX - expectedAfterRefund)}`);

  // ══ (ii) stake with insufficient balance ══
  console.log('\n═══ (ii) stake with insufficient balance (available 50, bet 100) ══');
  await pool.query(`DELETE FROM games WHERE player_x = $1`, [USER_X]);
  await pool.query(`DELETE FROM wallet_transactions WHERE user_id IN ($1,$2)`, [USER_X, USER_O]);
  await pool.query(`UPDATE wallets SET available_balance = 50, withdrawable_balance = 0, bonus_balance = 0 WHERE user_id = $1`, [USER_X]);
  await pool.query(`UPDATE wallets SET available_balance = 1000, withdrawable_balance = 0, bonus_balance = 0 WHERE user_id = $1`, [USER_O]);
  let threw = null;
  try {
    await plainTx(async (client) => {
      await deductStake(client, { playerXId: USER_X, playerOId: USER_O, betAmount: BET });
    });
  } catch (e) { threw = e.message; }
  const w2 = await walletOf(USER_X);
  console.log(`  threw: ${threw} | wallet after: ${JSON.stringify(w2)}`);
  console.log(`  >>> ${threw === 'INSUFFICIENT_BALANCE' && w2.avail === 50 ? 'FAILS LOUDLY, no partial deduction' : 'PROBLEM: not loud or wallet mutated'}`);

  // ══ (iii) refund after a clamped stake ══
  console.log('\n═══ (iii) refund after clamped stake (available 100, withdrawable 30, bet 100) ══');
  await pool.query(`UPDATE wallets SET available_balance = 100, withdrawable_balance = 30, bonus_balance = 0 WHERE user_id = $1`, [USER_X]);
  await pool.query(`UPDATE wallets SET available_balance = 1000, withdrawable_balance = 0, bonus_balance = 0 WHERE user_id = $1`, [USER_O]);
  const startTotal = await totalOf(USER_X); // 130
  const g3 = await stake('clamp');
  if (g3.error) { console.log('  stake error:', g3.error); process.exit(1); }
  const afterStake = await walletOf(USER_X);
  const rec = await pool.query(`SELECT bonus_used_x, withdrawable_used_x, locked_used_x FROM games WHERE id = $1`, [g3.id || g3]);
  console.log(`  after stake: ${JSON.stringify(afterStake)} | recorded split: ${JSON.stringify(rec.rows[0])}`);
  // refund with the recorded split (ghost semantics)
  await plainTx(async (c) => {
    await c.query(`UPDATE wallets SET available_balance = available_balance + 100, bonus_balance = bonus_balance + $1, withdrawable_balance = withdrawable_balance + $2 WHERE user_id = $3`,
      [Number(rec.rows[0].bonus_used_x), Number(rec.rows[0].withdrawable_used_x), USER_X]);
  });
  const afterRefund = await walletOf(USER_X);
  const endTotal = await totalOf(USER_X);
  console.log(`  after refund: ${JSON.stringify(afterRefund)} | total start=${startTotal} end=${endTotal}`);
  console.log(`  >>> ${endTotal === startTotal ? 'CONSERVED — no money created by the clamp' : 'DRIFT: ' + (endTotal - startTotal)}`);

  await pool.query(`DELETE FROM games WHERE player_x = $1`, [USER_X]);
  await pool.query(`DELETE FROM wallet_transactions WHERE user_id IN ($1,$2)`, [USER_X, USER_O]);
  await pool.query(`UPDATE wallets SET available_balance = 0, withdrawable_balance = 0, bonus_balance = 0 WHERE user_id IN ($1,$2)`, [USER_X, USER_O]);
  await pool.end();
  process.exit(0);
}
main().catch(e => { console.error('FATAL:', e.message, e.stack); process.exit(1); });
