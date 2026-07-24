const cron = require('node-cron');
const { pool } = require('./db'); // Assuming pool is exported from db/index.js
const { verifyPendingPayouts } = require('./cron/verifyPendingPayouts');
const { verifyPendingDeposits } = require('./cron/verifyPendingDeposits');

function initCron() {
  console.log('[CRON] Initializing background scheduler...');

  // 1) 🧹 Ghost Game & Matchmaking Cleanup (Runs every 10 minutes)
  cron.schedule('*/10 * * * *', async () => {
    try {
      console.log('[CRON] Running Ghost Game Cleanup...');
      
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        
        const { rows: stuckGames } = await client.query(`
          UPDATE games 
          SET status = 'completed', winner = NULL, finished_at = NOW() 
          WHERE status IN ('ongoing', 'live', 'countdown') 
            AND created_at < NOW() - INTERVAL '30 MINUTES'
          RETURNING id, player_x, player_o, bet_amount
        `);

        for (const game of stuckGames) {
          const betAmount = Number(game.bet_amount || 0);
          if (betAmount > 0) {
            if (game.player_x) {
              await client.query(`
                UPDATE wallets 
                SET available_balance = available_balance + $1,
                    withdrawable_balance = withdrawable_balance + $1,
                    updated_at = NOW()
                WHERE user_id = $2
              `, [betAmount, game.player_x]);
              await client.query(`
                INSERT INTO wallet_transactions (user_id, tx_type, amount, status, provider, meta, idempotency_key)
                VALUES ($1, 'REFUND', $2, 'COMPLETED', 'GHOST_CLEANUP', $3, $4)
                ON CONFLICT (user_id, idempotency_key) DO NOTHING
              `, [game.player_x, betAmount, JSON.stringify({ gameId: game.id, reason: 'Ghost game cleanup' }), `GHOST_REFUND_${game.id}_X`]);
            }
            if (game.player_o) {
              await client.query(`
                UPDATE wallets 
                SET available_balance = available_balance + $1,
                    withdrawable_balance = withdrawable_balance + $1,
                    updated_at = NOW()
                WHERE user_id = $2
              `, [betAmount, game.player_o]);
              await client.query(`
                INSERT INTO wallet_transactions (user_id, tx_type, amount, status, provider, meta, idempotency_key)
                VALUES ($1, 'REFUND', $2, 'COMPLETED', 'GHOST_CLEANUP', $3, $4)
                ON CONFLICT (user_id, idempotency_key) DO NOTHING
              `, [game.player_o, betAmount, JSON.stringify({ gameId: game.id, reason: 'Ghost game cleanup' }), `GHOST_REFUND_${game.id}_O`]);
            }
          }
        }

        
        if (stuckGames.length > 0) {
          console.log(`[CRON] Cleaned up & refunded ${stuckGames.length} stuck games.`);
        }
        
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        console.error('[CRON] Task 1 DB Error:', err.message);
      } finally {
        client.release();
      }

    } catch (err) {
      console.error('[CRON] Task 1 Error:', err.message);
    }
  });

  // 2) 🔐 OTP Database Sweeping (Runs every hour at minute 0)
  cron.schedule('0 * * * *', async () => {
    try {
      console.log('[CRON] Sweeping expired OTPs...');
      const { rowCount } = await pool.query(`
        DELETE FROM otps 
        WHERE expires_at < NOW() - INTERVAL '1 HOUR'
      `);
      if (rowCount > 0) {
         console.log(`[CRON] Swept ${rowCount} expired OTP tokens out of the database.`);
      }
    } catch (err) {
      console.error('[CRON] Task 2 Error:', err.message);
    }
  });

  // 3) 💸 Sweep Expired Giveaways (Runs Daily at Midnight)
  cron.schedule('0 0 * * *', async () => {
     try {
       console.log('[CRON] Sweeping expired Giveaways...');
       await pool.query(`
         UPDATE giveaways 
         SET status = 'EXPIRED' 
         WHERE status = 'ACTIVE' 
           AND ends_at IS NOT NULL 
           AND ends_at < NOW()
       `);
     } catch (err) {
       console.error('[CRON] Task 3 Error:', err.message);
     }
  });

  // 4) 💳 Verify Pending Payouts (Runs every 2 minutes — reduced from 30s to avoid Redis rate-limiting)
  cron.schedule('*/2 * * * *', async () => {
    try {
      await verifyPendingPayouts();
    } catch (err) {
      console.error('[CRON] Task 4 (verifyPendingPayouts) Error:', err.message);
    }
  });

  // 5) 💰 Verify Pending Deposits (Runs every 5 minutes — secondary safety net)
  // Checks Chapa payment status for deposits that missed the webhook
  cron.schedule('*/5 * * * *', async () => {
    try {
      await verifyPendingDeposits();
    } catch (err) {
      console.error('[CRON] Task 5 (verifyPendingDeposits) Error:', err.message);
    }
  });

  // 6) 🏆 Weekly Leaderboard Snapshot & Payouts (Runs every Sunday at midnight)
  cron.schedule('0 0 * * 0', async () => {
    try {
      console.log('[CRON] Running Weekly Leaderboard Snapshot...');
      const { runWeeklyLeaderboardSnapshot } = require('./cron/weeklyLeaderboard');
      await runWeeklyLeaderboardSnapshot();
    } catch (err) {
      console.error('[CRON] Weekly Leaderboard Cron Error:', err.message);
    }
  });

  console.log('[CRON] Scheduler active.');
}

module.exports = { initCron };
