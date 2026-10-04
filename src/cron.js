const cron = require('node-cron');
const { pool, withTx } = require('./db');
const { verifyPendingPayouts } = require('./cron/verifyPendingPayouts');
const { verifyPendingDeposits } = require('./cron/verifyPendingDeposits');
const { ledgerFirstCredit } = require('./models/ledgerFirstCredit');

function initCron() {
  console.log('[CRON] Initializing background scheduler...');

  // 1) 🧹 Ghost Game & Matchmaking Cleanup (Runs every 10 minutes)
  cron.schedule('*/10 * * * *', async () => {
    try {
      console.log('[CRON] Running Ghost Game Cleanup...');

      // Candidates first (no lock held across games); each game then gets its own
      // short transaction with a status guard inside, so one bad row cannot roll
      // back the others — the failure mode that previously froze ALL refunds.
      const { rows: candidates } = await pool.query(`
        SELECT id FROM games
        WHERE status IN ('ongoing', 'live', 'countdown')
          AND created_at < NOW() - INTERVAL '30 MINUTES'
        ORDER BY created_at
        LIMIT 100
      `);

      let cleaned = 0;
      for (const { id } of candidates) {
        try {
          const refunded = await withTx(async (client) => {
            // Status-guarded claim: only transitions a still-active game. This is
            // also the double-claim guard — a second run updates 0 rows.
            const { rows } = await client.query(`
              UPDATE games
              SET status = 'completed', winner = NULL, finished_at = NOW()
              WHERE id = $1 AND status IN ('ongoing', 'live', 'countdown')
              RETURNING id, player_x, player_o, bet_amount, bonus_used_x, bonus_used_o, withdrawable_used_x, withdrawable_used_o
            `, [id]);
            if (!rows.length) return false;
            const game = rows[0];

            const betAmount = Number(game.bet_amount || 0);
            if (betAmount <= 0) return true;

            const players = [
              { userId: game.player_x, bonus: Number(game.bonus_used_x || 0), wdUsed: Number(game.withdrawable_used_x || 0), key: `GHOST_REFUND_${game.id}_X` },
              { userId: game.player_o, bonus: Number(game.bonus_used_o || 0), wdUsed: Number(game.withdrawable_used_o || 0), key: `GHOST_REFUND_${game.id}_O` }
            ];
            for (const p of players) {
              if (!p.userId) continue;
              // Ledger-first: the refund row gates the credit (replay-safe)
              const { inserted } = await ledgerFirstCredit(client, {
                userId: p.userId, txType: 'REFUND', amount: betAmount,
                idempotencyKey: p.key, provider: 'GHOST_CLEANUP',
                meta: { gameId: game.id, reason: 'Ghost game cleanup' }
              });
              if (!inserted) continue;
              // Restore the EXACT buckets the stake came from: bonus part back to
              // bonus_balance, withdrawable money back to withdrawable, deposit-only
              // "locked" money stays available-only. Crediting the full real stake to
              // withdrawable would bypass the AML 1x rollover rule.
              await client.query(`
                UPDATE wallets
                SET available_balance = available_balance + $1,
                    bonus_balance = bonus_balance + $2,
                    withdrawable_balance = withdrawable_balance + $3,
                    updated_at = NOW()
                WHERE user_id = $4
              `, [betAmount, p.bonus, p.wdUsed, p.userId]);
            }
            return true;
          });
          if (refunded) cleaned++;
        } catch (gameErr) {
          console.error(`[CRON] Ghost cleanup failed for game ${id} (other games unaffected):`, gameErr.message);
        }
      }

      if (cleaned > 0) {
        console.log(`[CRON] Cleaned up & refunded ${cleaned} stuck game(s).`);
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
