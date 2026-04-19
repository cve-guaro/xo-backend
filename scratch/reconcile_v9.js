/**
 * V9 Reconciliation Script — FINAL (connection-resilient)
 * 
 * Creates its own pool with keepalive to prevent Supabase timeout.
 * Processes in batches of 25 with per-user error handling.
 */

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 3,
  idleTimeoutMillis: 120000,
  connectionTimeoutMillis: 10000,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
});

pool.on('error', (err) => {
  console.error('[V9-POOL] idle error:', err.message);
});

async function reconcileV9() {
  console.log("=== V9 RECONCILIATION START ===");

  const BATCH = 25;
  let offset = 0;
  let totalProcessed = 0;

  try {
    const { rows: countRows } = await pool.query(`SELECT COUNT(*) AS c FROM wallets`);
    const totalWallets = Number(countRows[0].c);
    console.log(`Total wallets to process: ${totalWallets}`);

    while (offset < totalWallets) {
      const { rows: batch } = await pool.query(
        `SELECT user_id, bonus_balance FROM wallets ORDER BY user_id LIMIT $1 OFFSET $2`,
        [BATCH, offset]
      );
      if (batch.length === 0) break;

      for (const u of batch) {
        const uid = u.user_id;
        const currBonus = Number(u.bonus_balance || 0);

        try {
          // 1. Wallet transaction inflows
          const { rows: inflowRows } = await pool.query(`
            SELECT 
              COALESCE(SUM(CASE WHEN tx_type = 'DEPOSIT' AND status = 'COMPLETED' THEN amount ELSE 0 END), 0) AS deposits,
              COALESCE(SUM(CASE WHEN tx_type IN ('GIFT','BONUS','ADMIN_EDIT','ADJUSTMENT','REFUND') AND status = 'COMPLETED' THEN amount ELSE 0 END), 0) AS gifts
            FROM wallet_transactions WHERE user_id = $1
          `, [uid]);

          // 2. Wallet transaction outflows
          const { rows: outflowRows } = await pool.query(`
            SELECT COALESCE(SUM(amount), 0) AS withdrawals
            FROM wallet_transactions 
            WHERE user_id = $1 
              AND tx_type IN ('WITHDRAW_SETTLED', 'WITHDRAW_REQUEST') 
              AND status IN ('COMPLETED', 'PENDING', 'PENDING_MANUAL')
          `, [uid]);

          // 3. Bonus logs
          const { rows: bonusRows } = await pool.query(`
            SELECT COALESCE(SUM(amount), 0) AS bonus_total FROM bonus_logs WHERE user_id = $1
          `, [uid]);

          // 4. Game wins
          const { rows: winRows } = await pool.query(`
            SELECT COALESCE(SUM(bet_amount * 1.6), 0) AS game_wins
            FROM games WHERE winner = $1 AND status = 'completed'
          `, [uid]);

          // 5. Game bets
          const { rows: betRows } = await pool.query(`
            SELECT COALESCE(SUM(bet_amount), 0) AS game_bets
            FROM games 
            WHERE (player_x = $1 OR player_o = $1) 
              AND status IN ('completed', 'ongoing', 'abandoned')
          `, [uid]);

          const deposits    = Number(inflowRows[0].deposits);
          const gifts       = Number(inflowRows[0].gifts);
          const bonusLogs   = Number(bonusRows[0].bonus_total);
          const withdrawals = Number(outflowRows[0].withdrawals);
          const gameWins    = Number(winRows[0].game_wins);
          const gameBets    = Number(betRows[0].game_bets);

          const totalIn  = deposits + gifts + bonusLogs + gameWins;
          const totalOut = withdrawals + gameBets;
          let newAvailable = Math.max(0, totalIn - totalOut);
          let newWithdrawable = Math.max(0, newAvailable - currBonus);

          await pool.query(
            `UPDATE wallets SET available_balance = $1, withdrawable_balance = $2 WHERE user_id = $3`,
            [newAvailable, newWithdrawable, uid]
          );
        } catch (userErr) {
          console.error(`  [SKIP] Error for user ${uid}: ${userErr.message}`);
        }

        totalProcessed++;
      }

      console.log(`  Processed ${totalProcessed}/${totalWallets}...`);
      offset += BATCH;
    }

    console.log(`=== V9 RECONCILIATION COMPLETE — ${totalProcessed} wallets updated ===`);
  } catch (err) {
    console.error("V9 Reconcile Error:", err);
  } finally {
    await pool.end();
  }
}

reconcileV9();
