/**
 * FIX #3 STEP 0c — race re-run with the REAL requestWithdraw (Chapa stubbed to an
 * ambiguous error → row stays PENDING) and the REAL deductStake; plus a deadlock
 * test: two concurrent games sharing the same player pair in OPPOSITE seat order.
 * Run with the dev server STOPPED.
 */
process.env.LOCAL_CORS = 'http://localhost:9999';

// Stub Chapa BEFORE requiring payments.service
const chapaModule = require('../src/models/Chapa');
chapaModule.initChapaPayout = async () => {
  const err = new Error('Chapa gateway timeout');
  err.status = 503;
  throw err;
};

const { assertServerStopped, pool, USER_X, USER_O } = require('./helpers');
const { requestWithdraw } = require('../src/models/payments.service');
const { deductStake } = require('../src/models/stake');

async function plainTx(fn) {
  const c = await pool.connect();
  try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; }
  catch (e) { try { await c.query('ROLLBACK'); } catch (_) {} throw e; }
  finally { c.release(); }
}

async function realStake(roundTag, xId = USER_X, oId = USER_O, bet = 100) {
  return plainTx(async (client) => {
    const stakes = await deductStake(client, { playerXId: xId, playerOId: oId, betAmount: bet });
    const g = await client.query(
      `INSERT INTO games (player_x, player_o, bet_amount, status, moves, bonus_used_x, bonus_used_o, withdrawable_used_x, withdrawable_used_o, locked_used_x, locked_used_o)
       VALUES ($1, $2, $3, 'ongoing', '[]'::jsonb, $4, $5, $6, $7, $8, $9) RETURNING id::text AS id`,
      [xId, oId, bet,
        stakes[xId].bonusUsed, stakes[oId].bonusUsed,
        stakes[xId].wdUsed, stakes[oId].wdUsed,
        stakes[xId].lockedUsed, stakes[oId].lockedUsed]
    );
    return g.rows[0].id;
  });
}

async function walletOf(userId) {
  const w = await pool.query(`SELECT available_balance::int AS avail, withdrawable_balance::int AS wd, bonus_balance::int AS bonus FROM wallets WHERE user_id = $1`, [userId]);
  return w.rows[0];
}

async function resetRaceWallet() {
  await pool.query(`UPDATE wallets SET available_balance = 300, withdrawable_balance = 100, bonus_balance = 0 WHERE user_id = $1`, [USER_X]);
  await pool.query(`UPDATE wallets SET available_balance = 1000, withdrawable_balance = 0, bonus_balance = 0 WHERE user_id = $1`, [USER_O]);
  await pool.query(`DELETE FROM wallet_transactions WHERE user_id IN ($1, $2)`, [USER_X, USER_O]);
  await pool.query(`DELETE FROM withdraw_requests WHERE user_id IN ($1, $2)`, [USER_X, USER_O]);
  await pool.query(`DELETE FROM games WHERE player_x IN ($1, $2) OR player_o IN ($1, $2)`, [USER_X, USER_O]);
  // The withdrawal gate requires at least one played game — leave one behind
  await pool.query(`
    INSERT INTO games (player_x, player_o, bet_amount, status, winner, prize_amount, created_at, finished_at)
    VALUES ($1, $2, 10, 'completed', $1, 0, now() - interval '1 hour', now() - interval '30 minutes')
  `, [USER_X, USER_O]);
}

async function main() {
  await assertServerStopped();
  console.log('preflight: dev server stopped — OK\n');

  // ══ RACE: real requestWithdraw (Chapa stubbed) vs real deductStake ══
  console.log('═══ RACE: real requestWithdraw vs real deductStake — 50 iterations ══\n');
  let outcomes = { bothOk: 0, wdOnly: 0, stakeOnly: 0, neither: 0 };
  let negatives = 0, createdMoney = 0;
  let first = null;

  for (let i = 1; i <= 50; i++) {
    await resetRaceWallet();
    const before = await walletOf(USER_X);

    const [wdRes, stRes] = await Promise.allSettled([
      requestWithdraw({ userId: USER_X, phoneNumber: '0900000099', amount: 100, payoutMethod: 'TELEBIRR', payoutDestination: '0900000099' }),
      realStake('race_' + i)
    ]);
    const wdOk = wdRes.status === 'fulfilled';
    const stOk = stRes.status === 'fulfilled';
    if (wdOk && stOk) outcomes.bothOk++;
    else if (wdOk) outcomes.wdOnly++;
    else if (stOk) outcomes.stakeOnly++;
    else outcomes.neither++;

    const after = await walletOf(USER_X);
    if (after.avail < 0 || after.wd < 0 || after.bonus < 0) negatives++;
    // Money removed, computed from the RECORDED split on the games row:
    //   withdrawal reservation removes amount from available AND withdrawable (200 total)
    //   stake removes bet (available) + bonus_used (bonus) + withdrawable_used (withdrawable)
    let left = 0;
    if (wdOk) left += 200;
    if (stOk) {
      const split = await pool.query(`SELECT bonus_used_x, withdrawable_used_x FROM games WHERE player_x = $1 ORDER BY created_at DESC LIMIT 1`, [USER_X]);
      if (split.rows.length) left += 100 + Number(split.rows[0].bonus_used_x) + Number(split.rows[0].withdrawable_used_x);
    }
    const drift = (before.avail + before.wd + before.bonus) - (after.avail + after.wd + after.bonus) - left;
    if (drift !== 0) createdMoney += drift;

    if (i === 1) {
      first = { before, after, wdOk, stOk, wdErr: wdRes.status === 'rejected' ? wdRes.reason.message : null, stErr: stRes.status === 'rejected' ? stRes.reason.message : null };
      console.log('  ITERATION 1 RAW:');
      console.log(`    before: ${JSON.stringify(first.before)}`);
      console.log(`    withdraw: ${wdOk ? 'RESERVED (PENDING row created)' : 'REJECTED: ' + first.wdErr}`);
      console.log(`    stake:    ${stOk ? 'DEDUCTED' : 'REJECTED: ' + first.stErr}`);
      if (!stOk) console.log(`    stake stack: ${(stRes.reason.stack || '').split('\n').slice(0, 4).join(' | ')}`);
      console.log(`    after:  ${JSON.stringify(first.after)}`);
    }
  }
  console.log(`\n  outcome table: both=${outcomes.bothOk}, withdrawOnly=${outcomes.wdOnly}, stakeOnly=${outcomes.stakeOnly}, neither=${outcomes.neither}`);
  console.log(`  negative wallet events: ${negatives}/50`);
  console.log(`  total money created across 50 iterations: ${createdMoney} (expected 0)`);
  console.log(`  >>> ${negatives === 0 && createdMoney === 0 ? 'RACE CLEAN — both paths check under FOR UPDATE lock' : 'RACE LEAKS'}`);

  // ══ DEADLOCK: same pair, opposite seat order, 50 iterations ══
  console.log('\n═══ DEADLOCK: two games, same pair, OPPOSITE seat order — 50 iterations ══\n');
  let deadlocks = 0, otherErrors = 0, bothOk = 0;
  for (let i = 1; i <= 50; i++) {
    await resetRaceWallet();
    const [r1, r2] = await Promise.allSettled([
      realStake('dl_' + i, USER_X, USER_O),  // game A: X=u1, O=u2
      realStake('dl_' + i, USER_O, USER_X),  // game B: X=u2, O=u1 (opposite)
    ]);
    const ok1 = r1.status === 'fulfilled', ok2 = r2.status === 'fulfilled';
    if (ok1 && ok2) bothOk++;
    else {
      const errs = [r1, r2].filter(r => r.status === 'rejected').map(r => r.reason.message).join(' | ');
      if (errs.includes('40P01') || errs.toLowerCase().includes('deadlock')) deadlocks++;
      else otherErrors++;
      if (i <= 3) console.log(`  iter ${i}: ${errs.slice(0, 140)}`);
    }
  }
  console.log(`  both games succeeded: ${bothOk}/50, deadlocks: ${deadlocks}, other errors: ${otherErrors}`);
  console.log(`  >>> ${deadlocks === 0 ? 'NO DEADLOCKS — deductStake locks in sorted user-id order' : 'DEADLOCKS DETECTED'}`);

  await resetRaceWallet();
  await pool.end();
  process.exit(0);
}
main().catch(e => { console.error('FATAL:', e.message, e.stack); process.exit(1); });
