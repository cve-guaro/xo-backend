const { pool } = require('../db/index');
const { sendSMS } = require('../utils/sms');

function getPrevWeekBounds() {
  const now = new Date();
  // Go back 7 days to get a date in the previous week
  const prev = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const day = prev.getUTCDay(); // 0=Sun, 1=Mon, ...
  
  const sunday = new Date(prev);
  sunday.setUTCDate(prev.getUTCDate() - day);
  sunday.setUTCHours(0, 0, 0, 0);
  
  const saturday = new Date(sunday);
  saturday.setUTCDate(sunday.getUTCDate() + 6);
  saturday.setUTCHours(23, 59, 59, 999);
  
  return { weekStart: sunday, weekEnd: saturday };
}

async function runWeeklyLeaderboardSnapshot() {
  console.log('[LEADERBOARD CRON] Starting weekly snapshot process...');
  const { weekStart, weekEnd } = getPrevWeekBounds();
  const weekStartStr = weekStart.toISOString().slice(0, 10);
  const weekEndStr = weekEnd.toISOString().slice(0, 10);

  console.log(`[LEADERBOARD CRON] Targeting week: ${weekStartStr} to ${weekEndStr}`);

  // Check if snapshot already exists for this week start date
  const { rows: existing } = await pool.query(
    `SELECT id FROM leaderboard_snapshots WHERE week_start = $1 LIMIT 1`,
    [weekStartStr]
  );
  if (existing.length > 0) {
    console.log('[LEADERBOARD CRON] Snapshot for this week already exists. Skipping.');
    return;
  }

  // Get autoApprove setting
  const { rows: settingRes } = await pool.query(
    `SELECT value FROM global_settings WHERE key = 'leaderboard_auto_approve'`
  );
  const autoApprove = settingRes.length > 0 ? (settingRes[0].value === true || settingRes[0].value === 'true') : false;
  console.log(`[LEADERBOARD CRON] Auto-approve setting is: ${autoApprove}`);

  // Get top 3 winners of the previous week
  const { rows: winners } = await pool.query(`
    SELECT 
      u.id, u.username, u.number,
      COUNT(*) AS wins
    FROM games g
    JOIN users u ON u.id = g.winner
    WHERE g.status IN ('completed', 'finished')
      AND g.winner IS NOT NULL
      AND g.created_at >= $1 AND g.created_at <= $2
    GROUP BY u.id, u.username, u.number
    ORDER BY wins DESC
    LIMIT 3
  `, [weekStart.toISOString(), weekEnd.toISOString()]);

  if (winners.length === 0) {
    console.log('[LEADERBOARD CRON] No games played this week. No snapshot created.');
    return;
  }

  const prizes = [500, 300, 200];
  const status = autoApprove ? 'approved' : 'pending';

  // Get custom SMS template if any
  const { rows: smsRes } = await pool.query(
    `SELECT value FROM global_settings WHERE key = 'leaderboard_sms_template'`
  );
  const smsTemplate = smsRes.length > 0 ? smsRes[0].value : '🏆 Congratulations {username}! You ranked #{rank} on the XO ET weekly leaderboard and won {prize} ETB! Your prize has been credited. Keep playing!';

  for (let i = 0; i < winners.length; i++) {
    const user = winners[i];
    const prizeAmount = prizes[i] || 0;

    console.log(`[LEADERBOARD CRON] Rank #${i + 1}: ${user.username} with ${user.wins} wins. Prize: ${prizeAmount} ETB.`);

    // Insert snapshot
    await pool.query(`
      INSERT INTO leaderboard_snapshots (week_start, week_end, user_id, username, wins, rank, prize_amount, prize_status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [weekStartStr, weekEndStr, user.id, user.username, Number(user.wins), i + 1, prizeAmount, status]);

    // If auto-approve is active, credit wallet, log bonus, and send SMS
    if (autoApprove && prizeAmount > 0) {
      // 1) Credit wallet (as integer whole numbers)
      await pool.query(
        `UPDATE wallets SET bonus_balance = bonus_balance + $1, available_balance = available_balance + $1 WHERE user_id = $2`,
        [prizeAmount, user.id]
      );
      
      // 2) Log bonus
      await pool.query(
        `INSERT INTO bonus_logs (user_id, amount, reason) VALUES ($1, $2, $3)`,
        [user.id, prizeAmount, `Weekly Leaderboard #${i + 1} Prize`]
      );
      
      // 3) Create in-app leaderboard award notification
      const rankLabels = ['🥇 1st Place Champion', '🥈 2nd Place', '🥉 3rd Place'];
      await pool.query(`
        INSERT INTO notifications (user_id, type, title, message, meta)
        VALUES ($1, 'leaderboard_award', $2, $3, $4::jsonb)
      `, [
        user.id,
        rankLabels[i] || `#${i + 1} Weekly Award`,
        `🏆 Congratulations! You ranked #${i + 1} on this week's leaderboard with ${user.wins} wins and earned ${prizeAmount} ETB! The prize has been added to your balance.`,
        JSON.stringify({ rank: i + 1, prize: prizeAmount, wins: Number(user.wins), weekStart: weekStartStr, weekEnd: weekEndStr })
      ]).catch(err => console.error('[LEADERBOARD CRON] notification insert failed (non-fatal):', err));

      // 4) Send congratulations SMS
      if (user.number) {
        const smsMsg = smsTemplate
          .replace('{username}', user.username || '')
          .replace('{rank}', String(i + 1))
          .replace('{prize}', String(prizeAmount));
        
        try {
          console.log(`[LEADERBOARD CRON] Sending SMS to ${user.username} (${user.number})...`);
          const success = await sendSMS(user.number, smsMsg).catch(() => false);
          console.log(`[LEADERBOARD CRON] SMS status: ${success ? 'sent' : 'failed'}`);
        } catch (e) {
          console.error(`[LEADERBOARD CRON] SMS error for ${user.username}:`, e.message);
        }
      }
    }
  }

  console.log('[LEADERBOARD CRON] Weekly snapshot process completed successfully.');
}

module.exports = { runWeeklyLeaderboardSnapshot };
