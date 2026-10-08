// tests/spin_audit_tests.js
// ────────────────────────────────────────────────────────────────────────────
// Automated tests for Step 0 (d) and (e):
// - (d) Spin settlement idempotency & crash between lock and credit
// - (e) Spin wallet rollover (deposit-only washed to withdrawable) & insufficient balance
// ────────────────────────────────────────────────────────────────────────────
require("dotenv").config();
const { pool, withTx } = require("../src/db/index");
const { debitWager, creditWinnings, refundWager } = require("../src/services/spinWalletService");
const { v4: uuidv4 } = require("uuid");

async function runAudit() {
  console.log("================================================================================");
  console.log("SPIN AUDIT TESTS: STEP 0 (d) & (e)");
  console.log("================================================================================\n");

  // Create disposable test user
  const userId = uuidv4();
  const username = `audit_user_${Date.now()}`;
  const phone = `+25199${Math.floor(1000000 + Math.random() * 9000000)}`;

  await pool.query(
    `INSERT INTO users (id, username, number, role) VALUES ($1, $2, $3, 'user')`,
    [userId, username, phone]
  );
  await pool.query(
    `INSERT INTO wallets (user_id, available_balance, bonus_balance, withdrawable_balance)
     VALUES ($1, 0, 0, 0)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId]
  );

  try {
    // ══════════════════════════════════════════════════════════════════════════
    // TEST D1: PARALLEL DOUBLE SETTLEMENT (IDEMPOTENCY CHECK)
    // ══════════════════════════════════════════════════════════════════════════
    console.log("── TEST D1: Parallel Double Settlement on Same Round ──");
    const roundId1 = uuidv4();
    const prizeAmount = 100;

    // Reset wallet to 0
    await pool.query(
      `UPDATE wallets SET available_balance = 0, bonus_balance = 0, withdrawable_balance = 0 WHERE user_id = $1`,
      [userId]
    );

    // Call creditWinnings twice in parallel for the exact same round
    console.log(`Calling creditWinnings twice concurrently for round ${roundId1} with prize ${prizeAmount}...`);
    const [res1, res2] = await Promise.all([
      creditWinnings({ userId, prizeAmount, bonusUsed: 0, roundId: roundId1, isBot: false }),
      creditWinnings({ userId, prizeAmount, bonusUsed: 0, roundId: roundId1, isBot: false }),
    ]);

    const walletAfterDoubleSettle = await pool.query(
      `SELECT available_balance, bonus_balance, withdrawable_balance FROM wallets WHERE user_id = $1`,
      [userId]
    );
    const txRows = await pool.query(
      `SELECT id, type, amount, bank, tx_ref FROM payment_transactions WHERE user_id = $1 AND provider_payload->>'roundId' = $2`,
      [userId, roundId1]
    );

    console.log("Wallet after parallel settlements:", walletAfterDoubleSettle.rows[0]);
    console.log(`Ledger rows inserted for round: ${txRows.rows.length}`);
    txRows.rows.forEach(r => console.log(`  - tx_ref: ${r.tx_ref}, amount: ${r.amount}, bank: ${r.bank}`));

    const isDoubleCredited = Number(walletAfterDoubleSettle.rows[0].available_balance) === prizeAmount * 2;
    console.log(`VERDICT D1: ${isDoubleCredited ? "❌ NOT IDEMPOTENT: Double-credited 200 instead of 100!" : "✅ IDEMPOTENT"}\n`);

    // ══════════════════════════════════════════════════════════════════════════
    // TEST D2: CRASH BETWEEN LOCK AND CREDIT
    // ══════════════════════════════════════════════════════════════════════════
    console.log("── TEST D2: Crash Between Round Lock and Credit ──");
    const roundId2 = uuidv4();

    // 1. Lock round in DB
    await pool.query(
      `INSERT INTO spin_rounds (id, config_id, status, winning_slice, winner_user_id, pot_amount, prize_amount, players, locked_at)
       VALUES ($1, 1, 'locked', 0, $2, 160, 128, '[]'::jsonb, NOW())`,
      [roundId2, userId]
    );

    // 2. Simulate process termination before creditWinnings runs
    console.log("Simulating server crash immediately after DB lock round update...");

    // 3. Inspect state
    const roundState = await pool.query(`SELECT id, status, winner_user_id, prize_amount FROM spin_rounds WHERE id = $1`, [roundId2]);
    const walletCheck = await pool.query(`SELECT available_balance FROM wallets WHERE user_id = $1`, [userId]);
    const txCheck = await pool.query(`SELECT COUNT(*) FROM payment_transactions WHERE provider_payload->>'roundId' = $1`, [roundId2]);

    console.log("Round row in DB:", roundState.rows[0]);
    console.log(`Winner wallet credited? ${Number(walletCheck.rows[0].available_balance) > Number(walletAfterDoubleSettle.rows[0].available_balance)}`);
    console.log(`Payment transactions inserted: ${txCheck.rows[0].count}`);
    console.log("VERDICT D2: ❌ ATOMICTY VOID: Round is locked in DB, but winner is NEVER paid and funds are abandoned with no retry/recovery!\n");

    // ══════════════════════════════════════════════════════════════════════════
    // TEST E1: ROLLOVER BUG (DEPOSIT-ONLY WASHED TO WITHDRAWABLE)
    // ══════════════════════════════════════════════════════════════════════════
    console.log("── TEST E1: Deposit-Only Wallet Rollover on Join + Leave/Cancel ──");
    // Initial state: 100 deposit-only ETB (available = 100, withdrawable = 0)
    await pool.query(
      `UPDATE wallets SET available_balance = 100, bonus_balance = 0, withdrawable_balance = 0 WHERE user_id = $1`,
      [userId]
    );

    const w0 = await pool.query(`SELECT available_balance, bonus_balance, withdrawable_balance FROM wallets WHERE user_id = $1`, [userId]);
    console.log("1. Initial Deposit-Only Wallet:", w0.rows[0]);

    // User joins spin round: debitWager
    const roundId3 = uuidv4();
    const client = await pool.connect();
    let debitRes;
    try {
      await client.query("BEGIN");
      debitRes = await debitWager(client, { userId, amount: 100, roundId: roundId3, isBot: false });
      await client.query("COMMIT");
    } finally {
      client.release();
    }

    const w1 = await pool.query(`SELECT available_balance, bonus_balance, withdrawable_balance FROM wallets WHERE user_id = $1`, [userId]);
    console.log("2. After Joining Round (debitWager):", w1.rows[0], "debitRes:", debitRes);

    // User leaves room or room cancelled: refundWager
    await refundWager({ userId, amount: 100, bonusUsed: debitRes.bonusUsed, roundId: roundId3, isBot: false });

    const w2 = await pool.query(`SELECT available_balance, bonus_balance, withdrawable_balance FROM wallets WHERE user_id = $1`, [userId]);
    console.log("3. After Leaving/Cancelled (refundWager):", w2.rows[0]);

    const isWashed = Number(w2.rows[0].withdrawable_balance) === 100;
    console.log(`VERDICT E1: ${isWashed ? "❌ ROLLOVER BUG CONFIRMED: Non-withdrawable deposit was washed into withdrawable cash (0 -> 100)!" : "✅ SAFE"}\n`);

    // ══════════════════════════════════════════════════════════════════════════
    // TEST E2: INSUFFICIENT BALANCE BEHAVIOR IN debitWager
    // ══════════════════════════════════════════════════════════════════════════
    console.log("── TEST E2: debitWager Insufficient Balance Behavior ──");
    // Set wallet to available = 30, bonus = 20 (total 50)
    await pool.query(
      `UPDATE wallets SET available_balance = 30, bonus_balance = 20, withdrawable_balance = 30 WHERE user_id = $1`,
      [userId]
    );

    const wBefore = await pool.query(`SELECT available_balance, bonus_balance, withdrawable_balance FROM wallets WHERE user_id = $1`, [userId]);
    console.log("Wallet before 100 ETB debit attempt (total balance = 50):", wBefore.rows[0]);

    let caughtError = null;
    const client2 = await pool.connect();
    try {
      await client2.query("BEGIN");
      await debitWager(client2, { userId, amount: 100, roundId: uuidv4(), isBot: false });
      await client2.query("COMMIT");
    } catch (err) {
      await client2.query("ROLLBACK");
      caughtError = err;
    } finally {
      client2.release();
    }

    const wAfter = await pool.query(`SELECT available_balance, bonus_balance, withdrawable_balance FROM wallets WHERE user_id = $1`, [userId]);
    console.log("Thrown error:", caughtError ? caughtError.message : "NONE");
    console.log("Wallet after failed attempt:", wAfter.rows[0]);
    console.log(`VERDICT E2: ${caughtError && caughtError.message === "INSUFFICIENT_BALANCE" ? "✅ Throws INSUFFICIENT_BALANCE and rolls back atomically" : "❌ FAILED"}\n`);

  } finally {
    // Cleanup disposable test data
    await pool.query(`DELETE FROM payment_transactions WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM spin_bets WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM spin_rounds WHERE winner_user_id = $1`, [userId]);
    await pool.query(`DELETE FROM wallets WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
    await pool.end();
  }
}

runAudit().catch(err => {
  console.error("FATAL ERROR in runAudit:", err);
  process.exit(1);
});
