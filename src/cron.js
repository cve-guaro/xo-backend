const cron = require('node-cron');
const { pool } = require('./db'); // Assuming pool is exported from db/index.js

function initCron() {
  console.log('[CRON] Initializing background scheduler...');

  // 1) 🧹 Ghost Game & Matchmaking Cleanup (Runs every 10 minutes)
  cron.schedule('*/10 * * * *', async () => {
    try {
      console.log('[CRON] Running Ghost Game Cleanup...');
      
      // Cleanup games stuck in 'ongoing', 'seeking', or 'countdown' for over 30 mins
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        
        // Find stuck games
        const { rows: stuckGames } = await client.query(`
          UPDATE games 
          SET status = 'abandoned', finished_at = NOW() 
          WHERE status IN ('ongoing', 'live', 'countdown') 
            AND created_at < NOW() - INTERVAL '30 MINUTES'
          RETURNING id, player_x, player_o, bet_amount
        `);

        for (const game of stuckGames) {
          const betAmount = Number(game.bet_amount || 0);
          if (betAmount > 0) {
            // Refund BOTH players safely
            if (game.player_x) {
              await client.query(`
                UPDATE wallets 
                SET available_balance = available_balance + $1,
                    withdrawable_balance = withdrawable_balance + $1,
                    updated_at = NOW()
                WHERE user_id = $2
              `, [betAmount, game.player_x]);
            }
            if (game.player_o) {
              await client.query(`
                UPDATE wallets 
                SET available_balance = available_balance + $1,
                    withdrawable_balance = withdrawable_balance + $1,
                    updated_at = NOW()
                WHERE user_id = $2
              `, [betAmount, game.player_o]);
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

  console.log('[CRON] Scheduler active.');
}

module.exports = { initCron };
