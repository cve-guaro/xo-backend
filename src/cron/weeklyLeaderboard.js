const { pool, withTx } = require('../db/index');
const { sendSMS } = require('../utils/sms');
const { ledgerFirstCredit } = require('../models/ledgerFirstCredit');

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

  // Check if leaderboard feature is enabled globally
  const { rows: enabledRes } = await pool.query(
    `SELECT value FROM global_settings WHERE key = 'leaderboard_enabled'`
  );
  const leaderboardEnabled = enabledRes.length > 0 ? (enabledRes[0].value === true || enabledRes[0].value === 'true') : true;
  if (!leaderboardEnabled) {
    console.log('[LEADERBOARD CRON] Leaderboard is globally disabled (leaderboard_enabled=false). Skipping payouts.');
    return;
  }

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
      AND COALESCE(u.is_bot, false) = false
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
    const status = autoApprove ? 'approved' : 'pending';

    console.log(`[LEADERBOARD CRON] Rank #${i + 1}: ${user.username} with ${user.wins} wins. Prize: ${prizeAmount} ETB.`);

    // One transaction per winner: snapshot + credit + ledger + bonus_log together.
    // The UNIQUE (week_start, rank) index (migration 009) is the hard guard against
    // concurrent duplicate snapshots; the ledger row is the double-credit guard.
    const outcome = await withTx(async (client) => {
      const { rows: existing } = await client.query(
        `SELECT 1 FROM leaderboard_snapshots WHERE week_start = $1 AND rank = $2`,
        [weekStartStr, i + 1]
      );
      if (existing.length > 0) return { created: false, credited: false };

      await client.query(`
        INSERT INTO leaderboard_snapshots (week_start, week_end, user_id, username, wins, rank, prize_amount, prize_status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `, [weekStartStr, weekEndStr, user.id, user.username, Number(user.wins), i + 1, prizeAmount, status]);

      let credited = false;
      if (autoApprove && prizeAmount > 0) {
        const { inserted } = await ledgerFirstCredit(client, {
          userId: user.id, txType: 'PRIZE', amount: prizeAmount,
          idempotencyKey: `LEADERBOARD_PRIZE_${weekStartStr}_${i + 1}`, provider: 'LEADERBOARD_PRIZE',
          meta: { rank: i + 1, weekStart: weekStartStr }
        });
        if (inserted) {
          await client.query(
            `UPDATE wallets SET bonus_balance = bonus_balance + $1, available_balance = available_balance + $1 WHERE user_id = $2`,
            [prizeAmount, user.id]
          );
          await client.query(
            `INSERT INTO bonus_logs (user_id, amount, reason) VALUES ($1, $2, $3)`,
            [user.id, prizeAmount, `Weekly Leaderboard #${i + 1} Prize`]
          );
          credited = true;
        }
      }
      return { created: true, credited };
    });

    if (!outcome.created) {
      console.log(`[LEADERBOARD CRON] Snapshot for rank #${i + 1} already exists — skipping.`);
      continue;
    }
    if (!outcome.credited) continue; // pending approval or already-credited — nothing else to do

    // 2b) Record accomplishment
    try {
      const weekStartMD = formatMonthDay(weekStartStr);
      const accomplishmentStr = `Week of ${weekStartMD}: Ranked #${i + 1} - Awarded ${prizeAmount} ETB`;
      await pool.query(`
        UPDATE users
        SET raw_user_meta_data = jsonb_set(
          COALESCE(raw_user_meta_data, '{}'::jsonb),
          '{accomplishments}',
          (COALESCE(raw_user_meta_data->'accomplishments', '[]'::jsonb) || jsonb_build_array($1::text))
        )
        WHERE id = $2
      `, [accomplishmentStr, user.id]);
    } catch (err) {
      console.error('[LEADERBOARD CRON] accomplishment update failed:', err);
    }

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

  console.log('[LEADERBOARD CRON] Weekly snapshot process completed successfully.');
}

function formatMonthDay(dateInput) {
  const date = typeof dateInput === 'string' ? new Date(dateInput + 'T00:00:00Z') : dateInput;
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const month = months[date.getUTCMonth()];
  const day = date.getUTCDate();
  return `${month} ${day}`;
}

module.exports = { runWeeklyLeaderboardSnapshot };
