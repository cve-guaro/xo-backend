// routes/admin.js
// Protected admin-only API routes
// All routes require role='admin' in the JWT.

const express = require('express');
const axios = require("axios");
const crypto = require("crypto");
const { pool, withTx, redis, invalidateGlobalSettingCache } = require('../db/index');
const { adminAuth, superAdminAuth } = require('../middleware/Auth');
const { getChapaBalance } = require('../models/Chapa');
const { settleWithdrawal } = require('../models/settleWithdrawal');
const { CHAPA } = require('../env');
const { sendSMS } = require('../utils/sms');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { emitToUserEvent } = require('../socket/game');


const router = express.Router();

// ─── IN-MEMORY FALLBACK for admin 2FA when Redis is down ────────────────────
// This Map stores 2FA codes and unlock sessions with auto-expiry.
// Only used when Redis circuit breaker is open.
const _memStore = new Map();
function memSet(key, value, ttlSeconds) {
  _memStore.set(key, value);
  setTimeout(() => _memStore.delete(key), ttlSeconds * 1000);
}
function memGet(key) {
  return _memStore.get(key) || null;
}
function memDel(key) {
  _memStore.delete(key);
}

// Apply adminAuth to ALL routes in this file
router.use(adminAuth);

// ──────────────────────────────────────────────
// POST /admin/auth/send-2fa
// ──────────────────────────────────────────────
router.post('/auth/send-2fa', async (req, res) => {
  try {
    const phoneNumber = req.user.phone_number;
    if (!phoneNumber) return res.status(400).json({ error: 'No phone number attached to admin account' });

    // Generate 4-digit OTP
    const code = String(crypto.randomInt(0, 10000)).padStart(4, "0");
    
    // Store in Redis (expires in 5 minutes), with in-memory fallback
    const storeKey = `admin_2fa:${req.user.id}`;
    try {
      await redis.setex(storeKey, 300, code);
    } catch (e) {
      console.warn('[ADMIN] Redis setex failed, using in-memory store:', e.message);
    }
    // Always also store in memory as backup
    memSet(storeKey, code, 300);

    // Send SMS via GeezSMS
    const GEEZ_SMS_URL = "https://api.geezsms.com/api/v1/sms/send";
    const GEEZ_SMS_TOKEN = process.env.GEEZ_SMS_TOKEN || '';
    
    if (GEEZ_SMS_TOKEN) {
      await axios.post(GEEZ_SMS_URL, {
        token: GEEZ_SMS_TOKEN,
        phone: phoneNumber,
        msg: `Your XO ET Admin verification code is: ${code}. Valid for 5 minutes. DO NOT SHARE.`
      }, { timeout: 10000 }).catch(e => console.error('[SMS ERROR]', e.message));
    } else {
      console.log(`[DEV MODE] Admin OTP for ${phoneNumber} is: ${code}`);
      try {
        const fs = require('fs');
        const path = require('path');
        fs.writeFileSync(path.join(__dirname, '../../.admin_2fa.txt'), code);
      } catch (err) {}
    }

    // Don't leak the code in production response
    return res.json({ ok: true, message: 'OTP sent successfully' });
  } catch (err) {
    console.error('[ADMIN] /auth/send-2fa error', err);
    return res.status(500).json({ error: 'Failed to send admin verification code' });
  }
});

// ──────────────────────────────────────────────
// POST /admin/auth/verify-2fa
// ──────────────────────────────────────────────
router.post('/auth/verify-2fa', async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Verification code is required' });

    const storeKey = `admin_2fa:${req.user.id}`;
    // Try Redis first, then fall back to in-memory
    let storedCode = null;
    try {
      storedCode = await redis.get(storeKey);
    } catch (e) {
      console.warn('[ADMIN] Redis get failed, using in-memory store:', e.message);
    }
    if (!storedCode) storedCode = memGet(storeKey);
    
    // Add development bypass
    const isDev = process.env.NODE_ENV !== 'production';
    const isBypass = isDev && code === '0000';

    if (!storedCode && !isBypass) return res.status(400).json({ error: 'OTP expired or not requested' });
    
    if (String(code) !== storedCode && !isBypass) {
      return res.status(400).json({ error: 'Invalid verification code' });
    }

    // Clear OTP from both stores
    try {
      await redis.del(storeKey);
    } catch (e) {}
    memDel(storeKey);

    // Set unlocking state (valid for 2 hours)
    const unlockKey = `admin_unlocked:${req.user.id}`;
    try {
      await redis.setex(unlockKey, 7200, "true");
    } catch (e) {
      console.warn('[ADMIN] Redis setex failed for unlock key:', e.message);
    }
    memSet(unlockKey, "true", 7200);
    
    await logAdminAction(req.user.id, 'admin_panel_unlocked', req.user.id, { ip: req.ip });

    return res.json({ ok: true, message: 'Admin dashboard unlocked' });
  } catch (err) {
    console.error('[ADMIN] /auth/verify-2fa error', err);
    return res.status(500).json({ error: 'Verification failed' });
  }
});

// NOTE: The /audit-logs endpoint is defined further below (with proper ::text cast and total count)

// ──────────────────────────────────────────────
// Helper: Log Admin Action
// ──────────────────────────────────────────────
async function logAdminAction(adminId, action, targetId = null, details = {}) {
  try {
    await pool.query(
      `INSERT INTO admin_audit_logs (admin_id, action, target_id, details) VALUES ($1, $2, $3, $4::jsonb)`,
      [adminId, action, targetId, JSON.stringify(details)]
    );
  } catch (err) {
    console.error('[Admin Log Error]', err);
  }
}

// ──────────────────────────────────────────────
// GET /admin/reconcile
// ──────────────────────────────────────────────
// Military-Grade Double-Entry Verification: Matches historical ledger vs LIVE wallet balances
router.get('/reconcile', async (req, res) => {
  try {
    // We sum up the transactions that logically modify balances:
    // + DEPOSIT, PRIZE, GIFT (Giveaway), REFUND
    // - WITHDRAW_REQUEST, STAKE

    const result = await pool.query(`
      WITH ledger AS (
        SELECT 
          user_id,
          SUM(
            CASE 
              WHEN tx_type IN ('DEPOSIT', 'PRIZE', 'GIFT', 'REFUND', 'BONUS') AND status IN ('COMPLETED', 'success') THEN amount
              WHEN tx_type IN ('WITHDRAW_REQUEST', 'WITHDRAW_SETTLED', 'STAKE') AND status IN ('COMPLETED', 'success', 'PENDING', 'PENDING_MANUAL') THEN -amount
              ELSE 0
            END
          ) AS calculated_net_balance
        FROM wallet_transactions
        GROUP BY user_id
      ),
      -- Legacy bonus_logs that predate wallet_transactions audit trail.
      -- These modified available_balance + bonus_balance but never created
      -- wallet_transactions entries (referral bonuses, promo link bonuses,
      -- giveaway v-claims, admin adjustments from before the fix).
      -- We sum ALL bonus_logs and subtract any that ARE already tracked in
      -- wallet_transactions (giveaway promocodes, leaderboard prizes) to avoid
      -- double-counting.
      bonus_gap AS (
        SELECT
          bl.user_id,
          COALESCE(SUM(bl.amount), 0) AS total_bonus_logs
        FROM bonus_logs bl
        GROUP BY bl.user_id
      ),
      bonus_already_in_ledger AS (
        SELECT
          user_id,
          COALESCE(SUM(amount), 0) AS amount
        FROM wallet_transactions
        WHERE tx_type IN ('GIFT', 'PRIZE', 'BONUS')
          AND status IN ('COMPLETED', 'success')
          AND provider IN ('REFERRAL', 'PROMO_LINK', 'GIVEAWAY_CLAIM', 'GIVEAWAY', 'LEADERBOARD_PRIZE', 'GHOST_CLEANUP')
        GROUP BY user_id
      ),
      -- Ghost game refunds that predate the audit trail fix:
      -- Games completed with no winner (ghost cleanup) where no REFUND
      -- wallet_transaction exists yet.
      ghost_refund_gap AS (
        SELECT
          player_id AS user_id,
          SUM(bet_amount) AS total_ghost_refunds
        FROM (
          SELECT player_x AS player_id, bet_amount FROM games
          WHERE status = 'completed' AND winner IS NULL AND finished_at IS NOT NULL
            AND player_x IS NOT NULL AND bet_amount > 0
          UNION ALL
          SELECT player_o AS player_id, bet_amount FROM games
          WHERE status = 'completed' AND winner IS NULL AND finished_at IS NOT NULL
            AND player_o IS NOT NULL AND bet_amount > 0
        ) ghost_games
        GROUP BY player_id
      ),
      ghost_already_in_ledger AS (
        SELECT
          user_id,
          COALESCE(SUM(amount), 0) AS amount
        FROM wallet_transactions
        WHERE tx_type = 'REFUND'
          AND status IN ('COMPLETED', 'success')
          AND provider = 'GHOST_CLEANUP'
        GROUP BY user_id
      ),
      -- available_balance is the total playable balance.
      -- bonus_balance and withdrawable_balance are subsets/trackers, NOT additive.
      wallets_live AS (
        SELECT 
          user_id,
          COALESCE(available_balance, 0) AS current_total_balance
        FROM wallets
      )
      SELECT 
        w.user_id,
        u.phone_number,
        COALESCE(l.calculated_net_balance, 0)
          + (COALESCE(bg.total_bonus_logs, 0) - COALESCE(bal.amount, 0))
          + (COALESCE(gr.total_ghost_refunds, 0) - COALESCE(gal.amount, 0))
          AS derived_history_balance,
        w.current_total_balance AS live_wallet_balance,
        w.current_total_balance - (
          COALESCE(l.calculated_net_balance, 0)
          + (COALESCE(bg.total_bonus_logs, 0) - COALESCE(bal.amount, 0))
          + (COALESCE(gr.total_ghost_refunds, 0) - COALESCE(gal.amount, 0))
        ) AS discrepancy
      FROM wallets_live w
      LEFT JOIN ledger l ON w.user_id = l.user_id
      LEFT JOIN bonus_gap bg ON w.user_id = bg.user_id
      LEFT JOIN bonus_already_in_ledger bal ON w.user_id = bal.user_id
      LEFT JOIN ghost_refund_gap gr ON w.user_id = gr.user_id
      LEFT JOIN ghost_already_in_ledger gal ON w.user_id = gal.user_id
      LEFT JOIN users u ON w.user_id = u.id
      WHERE (w.current_total_balance - (
          COALESCE(l.calculated_net_balance, 0)
          + (COALESCE(bg.total_bonus_logs, 0) - COALESCE(bal.amount, 0))
          + (COALESCE(gr.total_ghost_refunds, 0) - COALESCE(gal.amount, 0))
        )) != 0
         OR w.current_total_balance < 0;
    `);

    return res.json({ 
      ok: true, 
      anomaliesFound: result.rows.length,
      anomalies: result.rows // Anything strictly non-zero means math violated
    });
  } catch (err) {
    console.error("[RECONCILE ENGINE] Failed:", err);
    return res.status(500).json({ error: 'Reconciliation failed' });
  }
});

// ──────────────────────────────────────────────
// GET & PATCH /admin/settings
// ──────────────────────────────────────────────
router.get('/settings', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT key, value FROM global_settings`);
    const config = {};
    for (const r of rows) config[r.key] = r.value;
    return res.json({ ok: true, config });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

router.patch('/settings', async (req, res) => {
  // Security Protocols: only Simon can touch these
  const restrictedKeys = ['system_emergency_lockout', 'mobile_app_lockout', 'maintenance_mode', 'security_autoban', 'rooms_locked'];
  const isEditingRestricted = Object.keys(req.body).some(k => restrictedKeys.includes(k));

  if (isEditingRestricted) {
    const hasAccess = req.user.role === 'superadmin' || req.user.role === 'maintenance';
    if (!hasAccess) {
      return res.status(403).json({ error: 'Permission denied: Only Super Admin or Maintenance can modify security protocols.' });
    }
  }

  try {
    const updates = req.body;
    for (const [key, value] of Object.entries(updates)) {
      if (key === 'welcome_bonus_active') {
        const valStr = value === true || value === 'true';
        const amt = updates.welcome_bonus_amount ? Number(updates.welcome_bonus_amount) : 10;
        await pool.query(`INSERT INTO bonus_audit_logs (action, amount, admin_user) VALUES ($1, $2, $3)`, [valStr ? 'ON' : 'OFF', amt, req.user?.phone_number || req.user?.id || 'admin']);
      }
      await pool.query(`
        INSERT INTO global_settings (key, value) VALUES ($1, $2::jsonb)
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
      `, [key, JSON.stringify(value)]);
    }
    // ─── CRITICAL: Flush all lockdown/feature caches so changes take effect INSTANTLY ───
    await Promise.all([
      redis.del('system_lockdown_status'),
      redis.del('feature_status_system_emergency_lockout'),
      redis.del('feature_status_mobile_app_lockout'),
      redis.del('feature_status_rooms_locked'),
    ]).catch(() => {});

    // Flush settings cache keys (both Redis and In-Memory)
    for (const key of Object.keys(updates)) {
      await redis.del(`global_setting:${key}`).catch(() => {});
      invalidateGlobalSettingCache(key);
    }

    await logAdminAction(req.user.id, 'updated_global_settings', null, updates);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

router.post('/giveaway/reset', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT value FROM global_settings WHERE key = 'current_giveaway_version'`);
    let currentVersion = rows.length ? Number(rows[0].value) : 0;
    const newVersion = currentVersion + 1;
    
    await pool.query(`
      INSERT INTO global_settings (key, value) VALUES ('current_giveaway_version', $1::jsonb)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
    `, [JSON.stringify(newVersion)]);
    
    await logAdminAction(req.user.id, 'reset_giveaway_version', null, { version: newVersion });
    return res.json({ ok: true, newVersion });
  } catch (err) {
    console.error('[GIVEAWAY_RESET_ERR]', err);
    return res.status(500).json({ error: 'Failed to reset giveaway' });
  }
});
// ──────────────────────────────────────────────
// GET /admin/live-queue-stats
// ──────────────────────────────────────────────
router.get('/live-queue-stats', async (req, res) => {
  try {
    const { activeGames, determineRoomByBetAmount } = require('../socket/game');
    
    // 1. Get live active games from memory map
    const activeGamesList = [];
    if (activeGames) {
      for (const [matchId, game] of activeGames.entries()) {
        activeGamesList.push({
          matchId,
          room: game.room,
          betAmount: game.betAmount,
          players: game.players,
          status: game.status,
          turn: game.turn
        });
      }
    }

    // Calculate live game stats
    const roomStats = {
      1: { liveMatches: 0, livePlayers: 0, betBreakdown: {} },
      2: { liveMatches: 0, livePlayers: 0, betBreakdown: {} },
      3: { liveMatches: 0, livePlayers: 0, betBreakdown: {} }
    };

    activeGamesList.forEach(game => {
      const roomNum = game.room || 1;
      if (roomStats[roomNum]) {
        roomStats[roomNum].liveMatches += 1;
        roomStats[roomNum].livePlayers += 2;
        
        const bet = game.betAmount || 0;
        if (!roomStats[roomNum].betBreakdown[bet]) {
          roomStats[roomNum].betBreakdown[bet] = { liveMatches: 0, searching: 0 };
        }
        roomStats[roomNum].betBreakdown[bet].liveMatches += 1;
      }
    });

    // 2. Get searching users from Redis
    const queueKeys = await redis.smembers("mm:queues").catch(() => []);
    
    const defaultBetAmounts = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 7500, 10000];
    const keysToCheck = new Set(queueKeys);
    defaultBetAmounts.forEach(amt => keysToCheck.add(`queue:${amt}`));

    for (const key of keysToCheck) {
      if (!key.startsWith("queue:")) continue;
      const betStr = key.replace("queue:", "");
      const betAmount = Number(betStr);
      if (isNaN(betAmount)) continue;

      const len = await redis.llen(key).catch(() => 0);
      const roomNum = determineRoomByBetAmount(betAmount) || 1;

      if (roomStats[roomNum]) {
        if (!roomStats[roomNum].betBreakdown[betAmount]) {
          roomStats[roomNum].betBreakdown[betAmount] = { liveMatches: 0, searching: 0 };
        }
        roomStats[roomNum].betBreakdown[betAmount].searching = len;
      }
    }

    // Ensure all default bet amounts are listed in their respective rooms
    defaultBetAmounts.forEach(bet => {
      const roomNum = determineRoomByBetAmount(bet) || 1;
      if (roomStats[roomNum] && !roomStats[roomNum].betBreakdown[bet]) {
        roomStats[roomNum].betBreakdown[bet] = { liveMatches: 0, searching: 0 };
      }
    });

    // 3. Get Shadow-Banned Users from Redis
    const shadowBanKeys = await redis.keys('cooldown:active:*').catch(() => []);
    const shadowBanned = [];

    const userIds = shadowBanKeys.map(k => k.split(':')[2]);
    const uniqueUserIds = [...new Set(userIds)].filter(id => id && id.length === 36);

    let usersMap = {};
    if (uniqueUserIds.length > 0) {
      const usersRes = await pool.query(
        `SELECT id, username, number FROM users WHERE id = ANY($1::uuid[])`,
        [uniqueUserIds]
      );
      for (const row of usersRes.rows) {
        usersMap[row.id] = { username: row.username, number: row.number };
      }
    }

    for (const key of shadowBanKeys) {
      const parts = key.split(':');
      const userId = parts[2];
      const rangeKey = parts[3] || parts.slice(3).join(':');
      const ttl = await redis.ttl(key).catch(() => 0);
      const user = usersMap[userId] || { username: 'Unknown', number: '' };

      shadowBanned.push({
        userId,
        username: user.username,
        number: user.number,
        rangeKey,
        expiresIn: ttl
      });
    }

    return res.json({
      ok: true,
      roomStats,
      shadowBanned,
      activeGamesCount: activeGamesList.length
    });
  } catch (err) {
    console.error('[ADMIN] /live-queue-stats error', err);
    return res.status(500).json({ error: 'Failed to fetch live queue stats' });
  }
});

// ──────────────────────────────────────────────
// GET /admin/stats
// Overview KPI numbers
// ──────────────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const [usersRes, gamesRes, pendingRes, revenueRes, payoutsRes, giveawayRes, walletSumRes] = await Promise.all([
      pool.query(`SELECT COUNT(*) AS total_users FROM users WHERE banned = false`),
      pool.query(`SELECT COUNT(*) AS active_games FROM games WHERE status IN ('live', 'starting', 'ongoing')`),
      pool.query(`SELECT COUNT(*) AS pending_withdrawals, COALESCE(SUM(amount), 0) AS pending_amount
                  FROM wallet_transactions WHERE tx_type = 'WITHDRAW_REQUEST' AND status = 'PENDING'`),
      pool.query(`SELECT COALESCE(SUM(amount), 0) AS total_deposits
                  FROM wallet_transactions WHERE tx_type = 'DEPOSIT' AND status = 'COMPLETED'`),
      pool.query(`SELECT COALESCE(SUM(amount), 0) AS total_withdrawals
                  FROM wallet_transactions WHERE tx_type IN ('WITHDRAW_SETTLED', 'WITHDRAW_REQUEST') AND status = 'COMPLETED'`),
      pool.query(`
        SELECT COUNT(*) as claims 
        FROM users 
        WHERE claimed_giveaway_version = COALESCE(
          (SELECT value::text::int FROM global_settings WHERE key = 'current_giveaway_version' LIMIT 1), 1
        )
      `),
      pool.query(`SELECT COALESCE(SUM(available_balance), 0) AS platform_balance FROM wallets`)
    ]);

    // Fetch real Chapa balance if possible
    let chapaBalance = 0;
    try {
      const chapaData = await getChapaBalance(CHAPA.secret);
      // Chapa returns { data: [ { currency: 'ETB', available_balance: ... } ] }
      if (chapaData?.data && Array.isArray(chapaData.data)) {
        const etbBal = chapaData.data.find(b => b.currency === 'ETB') || chapaData.data[0];
        chapaBalance = Number(etbBal?.available_balance || etbBal?.balance || 0);
      }
    } catch (e) {
      console.warn('[ADMIN] Chapa balance fetch failed:', e.message);
    }

    const deposits = Number(revenueRes.rows[0].total_deposits);
    const withdrawals = Number(payoutsRes.rows[0].total_withdrawals);
    const platformBalance = Number(walletSumRes.rows[0].platform_balance);

    return res.json({
      totalUsers: Number(usersRes.rows[0].total_users),
      activeGames: Number(gamesRes.rows[0].active_games),
      pendingWithdrawalAmount: Number(pendingRes.rows[0].pending_amount),
      totalDeposits: deposits,
      totalWithdrawals: withdrawals,
      totalProfit: (deposits - withdrawals),
      platformBalance,
      chapaBalance,
      giveawayClaims: Number(giveawayRes.rows[0].claims || 0),
      // New real-time metrics for dashboard boxes
      volume24h: deposits, 
      successRate: (deposits > 0) ? (deposits / (deposits + Number(pendingRes.rows[0].pending_amount) * 1.5)) : 100,
    });
  } catch (err) {
    console.error('[ADMIN] /stats error', err);
    return res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// ──────────────────────────────────────────────
router.get('/dashboard-data', async (req, res) => {
  try {
    // ─── Timeframe Range Logic ───
    const rawRange = req.query.range || 'week';
    const range = ['day', 'week', 'month'].includes(rawRange) ? rawRange : 'week';
    let interval = '7 days';
    let trunc = 'day';
    let format = 'Mon DD';

    if (range === 'day') {
      interval = '24 hours';
      trunc = 'hour';
      format = 'HH24:00';
    } else if (range === 'month') {
      interval = '30 days';
      trunc = 'day';
      format = 'MM/DD';
    }

    // ─── Fixed Promise.all with correct destructuring ───
    const [usersRes, revenueRes, payoutsRes, pendingRes, metricsRes, graphRes, earningsRes, activeGamesRes, failedWdRes, newUserGraphRes] = await Promise.all([
      // [0] Total users
      pool.query(`SELECT COUNT(*) AS total_users FROM users WHERE banned = false`),
      // [1] Total completed deposits (money that came in via Chapa)
      pool.query(`SELECT COALESCE(SUM(amount), 0) AS total_revenue
                  FROM wallet_transactions WHERE tx_type = 'DEPOSIT' AND status = 'COMPLETED'`),
      // [2] Total settled withdrawals
      pool.query(`SELECT COALESCE(SUM(amount), 0) AS total_payouts
                  FROM wallet_transactions WHERE tx_type IN ('WITHDRAW_SETTLED', 'WITHDRAW_REQUEST') AND status = 'COMPLETED'`),
      // [3] Pending MANUAL withdrawal count (only transactions that need admin approval)
      pool.query(`SELECT COUNT(*) AS pending_manual_count
                   FROM wallet_transactions WHERE tx_type = 'WITHDRAW_REQUEST' AND status = 'PENDING_MANUAL'`),
      // [4] 24h metrics - real volume and real success rate
      pool.query(`
        SELECT 
          COALESCE(SUM(CASE WHEN status = 'COMPLETED' THEN amount ELSE 0 END), 0) as volume,
          CASE 
            WHEN COUNT(*) = 0 THEN 100
            ELSE ROUND((COUNT(*) FILTER (WHERE status = 'COMPLETED')::numeric / COUNT(*)::numeric) * 100, 1)
          END as success_rate
        FROM wallet_transactions 
        WHERE created_at > now() - interval '24 hours'
          AND tx_type = 'DEPOSIT'
      `),
      // [5] Time-series profit graph
      pool.query(`
        WITH points AS (
          SELECT generate_series(
            date_trunc('${trunc}', NOW() - interval '${interval}'),
            date_trunc('${trunc}', NOW()),
            '1 ${trunc}'::interval
          ) AS date
        )
        SELECT 
          to_char(points.date, '${format}') as label,
          COALESCE(SUM(CASE WHEN pt.tx_type = 'DEPOSIT' AND pt.status = 'COMPLETED' THEN pt.amount ELSE 0 END), 0) -
          COALESCE(SUM(CASE WHEN pt.tx_type IN ('WITHDRAW_SETTLED', 'WITHDRAW_REQUEST') AND pt.status = 'COMPLETED' THEN pt.amount ELSE 0 END), 0) as profit
        FROM points
        LEFT JOIN wallet_transactions pt 
          ON date_trunc('${trunc}', pt.created_at) = points.date
        GROUP BY points.date
        ORDER BY points.date ASC
      `),
      // [6] Platform earnings from game commissions (10% default, 20% for 10 Birr)
      pool.query(`
        SELECT COALESCE(SUM(bet_amount * CASE WHEN bet_amount = 10 THEN 0.2 ELSE 0.1 END), 0) AS platform_commission
        FROM games
        WHERE status = 'finished' AND winner IS NOT NULL
      `),
      // [7] Active Games
      pool.query(`SELECT COUNT(*) as active_games FROM games WHERE status IN ('live', 'starting', 'ongoing')`),
      // [8] Failed withdrawals (Count any withdrawal tx that didn't succeed)
      pool.query(`SELECT COUNT(*) as failed_withdrawals FROM wallet_transactions WHERE tx_type IN ('WITHDRAW_REQUEST', 'WITHDRAW_SETTLED') AND status = 'FAILED'`),
      // [9] New user growth + DAU time-series
      pool.query(`
        WITH points AS (
          SELECT generate_series(
            date_trunc('${trunc}', NOW() - interval '${interval}'),
            date_trunc('${trunc}', NOW()),
            '1 ${trunc}'::interval
          ) AS date
        ),
        active AS (
          SELECT date_trunc('${trunc}', g.created_at) AS d, player_id
          FROM games g
          CROSS JOIN LATERAL (VALUES (g.player_x),(g.player_o)) AS t(player_id)
          WHERE g.created_at >= NOW() - interval '${interval}'
            AND player_id IS NOT NULL
        )
        SELECT
          to_char(points.date, '${format}') as label,
          COUNT(DISTINCT u.id) as count,
          COUNT(DISTINCT a.player_id) as dau
        FROM points
        LEFT JOIN users u ON date_trunc('${trunc}', u.created_at) = points.date
        LEFT JOIN active a ON a.d = points.date
        GROUP BY points.date
        ORDER BY points.date ASC
      `)
    ]);

    const revenue = Number(revenueRes.rows[0].total_revenue);
    const payouts = Number(payoutsRes.rows[0].total_payouts);
    const pendingManualCount = Number(pendingRes.rows[0].pending_manual_count);
    const volume24h = Number(metricsRes.rows[0].volume);
    const successRate = Number(metricsRes.rows[0].success_rate) || 0;
    const platformCommission = Number(earningsRes.rows[0].platform_commission);

    let realChapaBalance = revenue - payouts;
    try {
      const chapaBalances = await getChapaBalance(CHAPA.secret);
      if (chapaBalances && chapaBalances.data && Array.isArray(chapaBalances.data)) {
        const etbBalance = chapaBalances.data.find((b) => b.currency === 'ETB') || chapaBalances.data[0];
        if (etbBalance) {
          // Send back the total ledger balance as requested
          realChapaBalance = Number(etbBalance.balance || etbBalance.available_balance || 0);
        }
      }
    } catch (apiErr) {
      console.error('[ADMIN] Failed to fetch real Chapa balance:', apiErr.message);
    }

    return res.json({
      ok: true,
      totalUsers: Number(usersRes.rows[0].total_users),
      totalDeposits: revenue,
      totalWithdrawals: payouts,
      totalProfit: revenue - payouts,
      platformEarnings: platformCommission,
      chapaNetPosition: realChapaBalance,
      pendingWithdrawals: pendingManualCount,
      pendingWithdrawalAmount: pendingManualCount,
      volume24h,
      successRate,
      activeGames: Number(activeGamesRes.rows[0].active_games),
      failedWithdrawals: Number(failedWdRes.rows[0].failed_withdrawals),
      graphData: (graphRes.rows || []).map(r => ({
        date: r.label,
        profit: Number(r.profit)
      })),
      newUserGraphData: (newUserGraphRes.rows || []).map(r => ({
        date: r.label,
        count: Number(r.count),
        dau: Number(r.dau)
      }))
    });
  } catch (err) {
    console.error('[ADMIN] /dashboard-data error', err);
    return res.status(500).json({ error: 'Failed to fetch dashboard data' });
  }
});



// ──────────────────────────────────────────────
// GET /admin/referrals/stats
// Referral system overview for admin dashboard
// ──────────────────────────────────────────────
router.get('/referrals/stats', async (req, res) => {
  try {
    const [totalRes, topRes, recentRes] = await Promise.all([
      pool.query(`
        SELECT 
          COUNT(*) AS total_referrals,
          COALESCE(SUM(bonus_amount), 0) AS total_bonus_paid
        FROM referrals
      `),
      pool.query(`
        SELECT r.referrer_id, u.username, u.number, 
          COUNT(*) AS referral_count,
          COALESCE(SUM(r.bonus_amount), 0) AS total_earned
        FROM referrals r
        JOIN users u ON r.referrer_id = u.id
        GROUP BY r.referrer_id, u.username, u.number
        ORDER BY referral_count DESC
        LIMIT 20
      `),
      pool.query(`
        SELECT r.*, 
          ru.username AS referrer_name, ru.number AS referrer_number,
          nu.username AS referred_name, nu.number AS referred_number
        FROM referrals r
        JOIN users ru ON r.referrer_id = ru.id
        JOIN users nu ON r.referred_id = nu.id
        ORDER BY r.created_at DESC
        LIMIT 50
      `)
    ]);

    return res.json({
      ok: true,
      totalReferrals: Number(totalRes.rows[0]?.total_referrals || 0),
      totalBonusPaid: Number(totalRes.rows[0]?.total_bonus_paid || 0),
      topReferrers: topRes.rows,
      recentReferrals: recentRes.rows
    });
  } catch (err) {
    console.error('[ADMIN] /referrals/stats error', err);
    return res.status(500).json({ error: 'Failed to fetch referral stats' });
  }
});

// ──────────────────────────────────────────────
// GET /admin/metrics/recent
// Grabs 7 recent users and 7 recent transactions
// ──────────────────────────────────────────────
router.get('/metrics/recent', async (req, res) => {
  try {
    const usersRes = await pool.query(`
      SELECT u.id, u.username, u.number, u.banned, u.created_at, u.role, COALESCE(w.available_balance, 0) as available_balance
      FROM users u
      LEFT JOIN wallets w ON u.id = w.user_id
      ORDER BY u.created_at DESC LIMIT 10
    `);
    const txsRes = await pool.query(`
      SELECT pt.id, pt.tx_type as type, pt.status, pt.amount, pt.provider as bank, pt.provider_ref as tx_ref, pt.created_at, u.username, u.number
      FROM wallet_transactions pt
      LEFT JOIN users u ON pt.user_id = u.id
      WHERE pt.provider IS NULL OR pt.provider != 'PRIZE'
      ORDER BY pt.created_at DESC LIMIT 10
    `);
    const formattedUsers = usersRes.rows.map(u => ({
      ...u,
      available_balance: Number(u.available_balance || 0)
    }));

    const formattedTxs = txsRes.rows.map(tx => ({
      ...tx,
      amount: Number(tx.amount || 0)
    }));

    return res.json({ ok: true, users: formattedUsers, transactions: formattedTxs });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch recent metrics' });
  }
});

// ──────────────────────────────────────────────
// GET /admin/metrics/daily-trends
// Fetch daily registration and profit counts for the last 14 days
// ──────────────────────────────────────────────
router.get('/metrics/daily-trends', async (req, res) => {
  try {
    // 1. Daily User Registrations
    const usersTrend = await pool.query(`
      SELECT DATE_TRUNC('day', created_at) as date, COUNT(*) as count
      FROM users
      WHERE created_at > now() - interval '14 days'
      GROUP BY 1 ORDER BY 1 ASC
    `);

    // 2. Daily Profit (Deposits - Success Withdrawals)
    const profitTrend = await pool.query(`
      SELECT 
        DATE_TRUNC('day', created_at) as date,
        SUM(CASE WHEN tx_type = 'DEPOSIT' THEN amount ELSE 0 END) - 
        SUM(CASE WHEN tx_type IN ('WITHDRAW_SETTLED', 'WITHDRAW_REQUEST') AND status = 'COMPLETED' THEN amount ELSE 0 END) as profit
      FROM wallet_transactions
      WHERE created_at > now() - interval '14 days'
      GROUP BY 1 ORDER BY 1 ASC
    `);

    const formattedUsers = usersTrend.rows.map(r => ({
      date: r.date,
      count: Number(r.count)
    }));

    const formattedProfit = profitTrend.rows.map(r => ({
      date: r.date,
      profit: Number(r.profit || 0)
    }));

    return res.json({ ok: true, users: formattedUsers, profit: formattedProfit });
  } catch (err) {
    console.error('[ADMIN] /daily-trends error', err);
    return res.status(500).json({ error: 'Failed to fetch daily trends' });
  }
});



// ──────────────────────────────────────────────
// GET /admin/users?search=&limit=&offset=&role=&status=
// Searchable paginated user list
// ──────────────────────────────────────────────
router.get('/users', async (req, res) => {
  try {
    const { limit = 100, offset = 0, search = '', role = 'all', status = 'all', amountRange = 'all' } = req.query;
    const rawSearch = search.trim();
    
    let whereClauses = [];
    let queryParams = [];
    let paramIdx = 1;

    // Base searchable fields
    if (rawSearch) {
      const normSearch = rawSearch.replace(/[\s\-\+\(\)]/g, '');
      const tail9      = normSearch.length >= 9 ? normSearch.slice(-9) : null;
      const likePat     = `%${rawSearch}%`;
      const normLike    = normSearch ? `%${normSearch}%` : null;
      const tail9Like   = tail9     ? `%${tail9}%`     : null;

      // Extract core phone digits (removing leading 0 or 251 if present)
      const digits = rawSearch.replace(/\D/g, '');
      let coreDigits = digits;
      if (digits.startsWith('0')) {
        coreDigits = digits.slice(1);
      } else if (digits.startsWith('251')) {
        coreDigits = digits.slice(3);
      }
      const coreDigitsLike = coreDigits ? `%${coreDigits}%` : null;

      whereClauses.push(`(
        u.username ILIKE $${paramIdx} 
        OR u.display_name ILIKE $${paramIdx} 
        OR u.role ILIKE $${paramIdx}
        OR u.number ILIKE $${paramIdx}
        OR REGEXP_REPLACE(u.number, '[^0-9]', '', 'g') ILIKE $${paramIdx+1}
        OR RIGHT(REGEXP_REPLACE(u.number, '[^0-9]', '', 'g'), 9) ILIKE $${paramIdx+2}
        OR ($${paramIdx+3}::text IS NOT NULL AND REGEXP_REPLACE(u.number, '[^0-9]', '', 'g') ILIKE $${paramIdx+3})
        OR ($${paramIdx+3}::text IS NOT NULL AND u.number ILIKE $${paramIdx+3})
        OR CAST(u.id AS TEXT) ILIKE $${paramIdx}
        OR CAST(w.available_balance AS TEXT) ILIKE $${paramIdx}
      )`);
      queryParams.push(likePat, normLike || likePat, tail9Like || likePat, coreDigitsLike);
      paramIdx += 4;
    }

    // Role Filter (Case-insensitive)
    if (role !== 'all') {
      whereClauses.push(`u.role ILIKE $${paramIdx}`);
      queryParams.push(role);
      paramIdx++;
    }

    // Status Filter
    if (status !== 'all') {
      whereClauses.push(`u.banned = $${paramIdx}`);
      queryParams.push(status === 'banned');
      paramIdx++;
    }

    // Amount Range Filter (available_balance)
    if (amountRange !== 'all') {
      if (amountRange === '0-100') {
        whereClauses.push(`w.available_balance <= 100`);
      } else if (amountRange === '100-10000') {
        whereClauses.push(`w.available_balance > 100 AND w.available_balance <= 10000`);
      } else if (amountRange === '10000-100000') {
        whereClauses.push(`w.available_balance > 10000 AND w.available_balance <= 100000`);
      }
    }

    // Dynamic Sorting
    const { sortBy = 'created_at', order = 'DESC' } = req.query;
    const allowedCols = {
      'created_at': 'u.created_at',
      'username': 'u.username',
      'balance': 'available_balance',
      'wins': 'u.total_wins',
      'games': 'u.total_games'
    };
    const sortCol = allowedCols[sortBy] || 'u.created_at';
    const sortDir = order.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    const whereStr = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const query = `
      SELECT u.id, u.number, u.username, u.display_name, u.avatar,
             u.role, u.banned, u.room_1_wins, u.r1_10_wins, u.r1_15_wins, u.r1_25_wins, u.r1_50_wins, u.r1_99_wins,
             u.r2_100_wins, u.r3_1000_wins, u.created_at,
             COALESCE(w.available_balance, 0)    AS available_balance,
             COALESCE(w.withdrawable_balance, 0) AS withdrawable_balance,
             COALESCE(w.bonus_balance, 0)        AS bonus_balance
      FROM users u
      LEFT JOIN wallets w ON w.user_id = u.id
      ${whereStr}
      ORDER BY ${sortCol} ${sortDir}
      LIMIT $${paramIdx} OFFSET $${paramIdx+1}
    `;
    const finalParams = [...queryParams, Number(limit), Number(offset)];

    const { rows } = await pool.query(query, finalParams);
    
    // Count query with same filters
    const countQuery = `
      SELECT COUNT(*) FROM users u 
      LEFT JOIN wallets w ON w.user_id = u.id
      ${whereStr}
    `;
    const countRes = await pool.query(countQuery, queryParams);

    const formattedUsers = rows.map(u => ({
      ...u,
      available_balance: Number(u.available_balance || 0),
      withdrawable_balance: Number(u.withdrawable_balance || 0),
      bonus_balance: Number(u.bonus_balance || 0)
    }));

    return res.json({ 
      users: formattedUsers, 
      total: Number(countRes.rows[0].count), 
      limit: Number(limit), 
      offset: Number(offset) 
    });
  } catch (err) {
    console.error('[ADMIN] /users error', err);
    return res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// ──────────────────────────────────────────────
// GET /admin/users/:id
// Single user detail
// ──────────────────────────────────────────────
router.get('/users/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT u.id, u.number, u.username, u.display_name, u.avatar,
             u.role, u.banned, u.room_1_wins, u.r1_10_wins, u.r1_15_wins, u.r1_25_wins, u.r1_50_wins, u.r1_99_wins,
             u.r2_100_wins, u.r3_1000_wins, u.created_at,
             COALESCE(u.raw_user_meta_data->'accomplishments', '[]'::jsonb) AS accomplishments,
             COALESCE(w.available_balance, 0)    AS available_balance,
             COALESCE(w.withdrawable_balance, 0) AS withdrawable_balance,
             COALESCE(w.bonus_balance, 0)        AS bonus_balance,
             (SELECT COUNT(*) FROM games WHERE winner = u.id) AS total_wins,
             (SELECT COUNT(*) FROM games WHERE player_x = u.id OR player_o = u.id) AS total_games
      FROM users u
      LEFT JOIN wallets w ON w.user_id = u.id
      WHERE u.id = $1
    `, [req.params.id]);

    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    const user = rows[0];

    // Calculate admin_edit_balance from bonus_logs
    const { rows: adminEdits } = await pool.query(
      `SELECT 
         COALESCE(SUM(CASE WHEN reason ILIKE '%Admin%' THEN amount ELSE 0 END), 0) AS admin_edit_total,
         COALESCE(SUM(CASE WHEN reason NOT ILIKE '%Admin%' THEN amount ELSE 0 END), 0) AS earned_bonus_total
       FROM bonus_logs
       WHERE user_id = $1
         `,
      [req.params.id]
    );

    return res.json({
      ...user,
      available_balance: Number(user.available_balance || 0),
      withdrawable_balance: Number(user.withdrawable_balance || 0),
      bonus_balance: Number(user.bonus_balance || 0),
      admin_edit_balance: Number(adminEdits[0]?.admin_edit_total || 0),
      earned_bonus_balance: Number(adminEdits[0]?.earned_bonus_total || 0)
    });
  } catch (err) {
    console.error('[ADMIN] /users/:id error', err);
    return res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// ──────────────────────────────────────────────
// PATCH /admin/users/:id
// Profile-only edit (username, number, full_name, role). Balance changes go through /users/:id/balance.
// ──────────────────────────────────────────────
router.patch('/users/:id', async (req, res) => {
  try {
    const { username, number, role, full_name } = req.body;
    
    // Build dynamic update — only update provided fields
    const updates = [];
    const params = [];
    let idx = 1;
    if (username !== undefined) { updates.push(`username = $${idx++}`); params.push(username); }
    if (number !== undefined) { updates.push(`number = $${idx++}`); params.push(number); }
    if (full_name !== undefined) { updates.push(`display_name = $${idx++}`); params.push(full_name); }
    if (role !== undefined) {
      // Block superadmin assignment through API — superadmin can only be set directly in DB
      if (role === 'superadmin') {
        return res.status(403).json({ error: 'Superadmin role cannot be assigned through the API.' });
      }
      const hasAccess = req.user.role === 'superadmin' || req.user.role === 'maintenance' || req.user.role === 'maintenance_admin';
      if (!hasAccess) return res.status(403).json({ error: 'Permission denied: Cannot modify roles.' });
      updates.push(`role = $${idx++}`); params.push(role);
    }

    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });

    params.push(req.params.id);
    await pool.query(`UPDATE users SET ${updates.join(', ')} WHERE id = $${idx}`, params);

    // NOTE: Wallet balances are NOT modified here.
    // Use PATCH /admin/users/:id/balance for balance changes.

    await logAdminAction(req.user.id, 'edit_user_profile', req.params.id, { username, number, full_name, role });

    return res.json({ ok: true });
  } catch (err) {
    console.error('[ADMIN] /users/:id patch error', err);
    return res.status(500).json({ error: 'Failed to update user profile' });
  }
});

// ──────────────────────────────────────────────
// PATCH /admin/users/:id/balance
// Body: { field: 'available_balance'|'bonus_balance', amount: number }
// Sets the balance (in ETB, converted to cents internally)
// ──────────────────────────────────────────────
router.patch('/users/:id/balance', superAdminAuth, async (req, res) => {
  try {
    const { field, amount } = req.body;
    if (!['available_balance', 'bonus_balance', 'withdrawable_balance'].includes(field)) {
      return res.status(400).json({ error: 'Invalid field. Must be available_balance, bonus_balance, or withdrawable_balance' });
    }
    const amountCents = Math.round(Number(amount));
    if (!Number.isFinite(amountCents) || amountCents < 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    // Ensure wallet row exists
    await pool.query(`INSERT INTO wallets (user_id) VALUES ($1) ON CONFLICT DO NOTHING`, [req.params.id]);

    const { rows } = await pool.query(
      `UPDATE wallets SET ${field} = $1 WHERE user_id = $2 RETURNING *`,
      [amountCents, req.params.id]
    );

    if (field === 'bonus_balance') {
      await pool.query(
        `INSERT INTO bonus_logs (user_id, amount, reason) VALUES ($1, $2, $3)`,
        [req.params.id, amountCents, `Admin Adjustment (${req.user?.username || 'admin'})`]
      ).catch(err => console.error('[BONUS_LOG] Admin log error:', err));
    }

    // Audit trail: Log transaction in wallet_transactions for reconciliation
    await pool.query(
      `INSERT INTO wallet_transactions (user_id, tx_type, amount, status, provider, meta, idempotency_key)
       VALUES ($1, 'BONUS', $2, 'COMPLETED', 'ADMIN_ADJUSTMENT', $3, $4)
       ON CONFLICT (user_id, idempotency_key) DO NOTHING`,
      [
        req.params.id,
        amountCents,
        JSON.stringify({ field, adminId: req.user.id, adminUsername: req.user?.username || 'admin' }),
        `ADMIN_ADJUST_${req.params.id}_${field}_${Date.now()}`
      ]
    ).catch(err => console.error('[WALLET_TX] Admin adjustment log error:', err));

    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    
    await logAdminAction(req.user.id, 'adjusted_balance', req.params.id, { field, amount: amountCents });
    
    return res.json({ ok: true, wallet: rows[0] });

  } catch (err) {
    console.error('[ADMIN] /users/:id/balance error', err);
    return res.status(500).json({ error: 'Failed to update balance' });
  }
});

// ──────────────────────────────────────────────
// PATCH /admin/users/:id/ban
// Body: { banned: true|false }
// ──────────────────────────────────────────────
router.patch('/users/:id/ban', async (req, res) => {
  try {
    const banned = req.body.banned === true;
    const { rows } = await pool.query(
      `UPDATE users SET banned = $1 WHERE id = $2 RETURNING id, number, username, banned`,
      [banned, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });

    await logAdminAction(req.user.id, banned ? 'banned_user' : 'unbanned_user', req.params.id, {});

    return res.json({ ok: true, user: rows[0] });
  } catch (err) {
    console.error('[ADMIN] /users/:id/ban error', err);
    return res.status(500).json({ error: 'Failed to update ban status' });
  }
});

// ──────────────────────────────────────────────
// PATCH /admin/users/:id/role
// Body: { role: 'user' | 'admin' }
// ──────────────────────────────────────────────
// PATCH /admin/users/:id/role
// Body: { role: 'user' | 'admin' }
// ──────────────────────────────────────────────
router.patch('/users/:id/role', superAdminAuth, async (req, res) => {
  try {
    const targetRole = req.body.role;
    const validRoles = ['user', 'admin'];
    // maintenance users can assign the maintenance role
    if (req.user.role === 'maintenance') {
      validRoles.push('maintenance');
    }
    // Hard block any attempt to assign superadmin via API
    if (targetRole === 'superadmin') {
      return res.status(403).json({ error: 'Superadmin role cannot be assigned through the API.' });
    }
    if (!validRoles.includes(targetRole)) {
      return res.status(400).json({ error: `Invalid role assignment. Allowed: ${validRoles.join(', ')}` });
    }
    const { rows } = await pool.query(
      `UPDATE users SET role = $1 WHERE id = $2 RETURNING id, username, role`,
      [targetRole, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });

    await logAdminAction(req.user.id, 'changed_user_role', req.params.id, { role: targetRole });

    return res.json({ ok: true, user: rows[0] });
  } catch (err) {
    console.error('[ADMIN] /users/:id/role error', err);
    return res.status(500).json({ error: 'Failed to update user role' });
  }
});

// NOTE: Second PATCH /users/:id route removed — it was a duplicate that also modified wallet
// balances, causing conflicts. All balance changes go through PATCH /admin/users/:id/balance.

// ──────────────────────────────────────────────
// POST /admin/users
// Manually create a user and initial wallet
// ──────────────────────────────────────────────
router.post('/users', async (req, res) => {
  try {
    const { display_name, username, number, role } = req.body;
    if (!username || !number) return res.status(400).json({ error: "Username and Number are required." });

    if (role && role !== 'user' && !['admin', 'superadmin', 'maintenance_admin', 'maintenance'].includes(req.user.role)) {
      return res.status(403).json({ error: "Insufficient permissions to create administrative accounts." });
    }

    const newUser = await withTx(async (client) => {
      // 1. Create User
      const userRes = await client.query(
        `INSERT INTO users (display_name, username, number, role) VALUES ($1, $2, $3, $4) RETURNING *`,
        [display_name || '', username, number, role || 'user']
      );
      const user = userRes.rows[0];

      // 2. Initialize Wallet with 0 balance
      await client.query(
        `INSERT INTO wallets (user_id, available_balance, bonus_balance) VALUES ($1, $2, $3)`,
        [user.id, 0, 0]
      );

      await logAdminAction(req.user.id, 'created_user_manual', user.id, { display_name, username, role });
      return user;
    });

    res.status(201).json({ ok: true, user: newUser });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: "Username or Phone Number already exists." });
    console.error('[ADMIN] POST /users err', err);
    res.status(500).json({ error: "Failed to create user." });
  }
});

// ──────────────────────────────────────────────
// DELETE /admin/users/:id
// Permanently remove a user and all associated data
// ──────────────────────────────────────────────
router.delete('/users/:id', async (req, res) => {
  try {
    if (!['admin', 'superadmin', 'maintenance_admin', 'maintenance'].includes(req.user.role)) {
      return res.status(403).json({ error: "Insufficient permissions to delete accounts." });
    }

    await withTx(async (client) => {
      // Fetch target user info for audit logging
      const { rows } = await client.query(`SELECT username, number FROM users WHERE id = $1`, [req.params.id]);
      const targetUser = rows[0] || {};
      
      // Order is important for foreign keys
      await client.query(`DELETE FROM promotion_claims WHERE user_id = $1`, [req.params.id]);
      await client.query(`DELETE FROM games WHERE player_x = $1 OR player_o = $1 OR winner = $1`, [req.params.id]);
      await client.query(`DELETE FROM wallet_transactions WHERE user_id = $1`, [req.params.id]);
      await client.query(`DELETE FROM bonus_logs WHERE user_id = $1`, [req.params.id]);
      await client.query(`DELETE FROM wallets WHERE user_id = $1`, [req.params.id]);
      await client.query(`DELETE FROM users WHERE id = $1`, [req.params.id]);
      
      await logAdminAction(req.user.id, 'deleted_user_permanent', req.params.id, { 
        username: targetUser.username || 'Unknown',
        number: targetUser.number || 'Unknown' 
      });
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('[ADMIN] DELETE /users/:id err', err);
    res.status(500).json({ error: "Failed to delete user account." });
  }
});

// ──────────────────────────────────────────────
// GET /admin/users/:id/360
// Full 360-degree user detail for admin
// ──────────────────────────────────────────────
router.get('/users/:id/360', async (req, res) => {
  try {
    const userId = req.params.id;

    // 1) User profile
    const userRes = await pool.query(
      `SELECT id, username, number, role, banned, created_at, display_name,
              COALESCE(r1_10_wins, 0) as r1_10_wins, COALESCE(r1_15_wins, 0) as r1_15_wins,
              COALESCE(r1_25_wins, 0) as r1_25_wins,
              COALESCE(r1_50_wins, 0) as r1_50_wins, COALESCE(r1_99_wins, 0) as r1_99_wins,
              COALESCE(r2_100_wins, 0) as r2_100_wins, COALESCE(r3_1000_wins, 0) as r3_1000_wins
       FROM users WHERE id = $1`, [userId]
    );
    if (!userRes.rows.length) return res.status(404).json({ error: 'User not found' });
    const user = userRes.rows[0];

    // 2) Wallet (safe)
    let wallet = { available: 0, withdrawable: 0, bonus: 0 };
    try {
      const walletRes = await pool.query(
        `SELECT available_balance, withdrawable_balance, bonus_balance FROM wallets WHERE user_id = $1`, [userId]
      );
      if (walletRes.rows.length) {
        wallet = {
          available: Number(walletRes.rows[0].available_balance || 0),
          withdrawable: Number(walletRes.rows[0].withdrawable_balance || 0),
          bonus: Number(walletRes.rows[0].bonus_balance || 0),
        };
      }
    } catch (e) { console.warn('[360] wallet query failed:', e.message); }

    // 3) Game stats (safe)
    let stats = { totalGames: 0, wins: 0, losses: 0, draws: 0 };
    try {
      const statsRes = await pool.query(`
        SELECT
          COUNT(*) as total_games,
          SUM(CASE WHEN winner = $1::uuid THEN 1 ELSE 0 END) as wins,
          SUM(CASE WHEN winner IS NOT NULL AND winner != $1::uuid THEN 1 ELSE 0 END) as losses,
          SUM(CASE WHEN winner IS NULL AND status = 'completed' THEN 1 ELSE 0 END) as draws
        FROM games WHERE (player_x = $1::uuid OR player_o = $1::uuid) AND status = 'completed'
      `, [userId]);
      if (statsRes.rows.length) {
        stats = {
          totalGames: Number(statsRes.rows[0].total_games || 0),
          wins: Number(statsRes.rows[0].wins || 0),
          losses: Number(statsRes.rows[0].losses || 0),
          draws: Number(statsRes.rows[0].draws || 0),
        };
      }
    } catch (e) { console.warn('[360] stats query failed:', e.message); }

    // 4) Game history (last 50) — includes moves for board replay
    let games = [];
    try {
      const gamesRes = await pool.query(`
        SELECT g.id, g.player_x, g.player_o, g.winner, g.bet_amount, g.status,
               g.finished_at, g.created_at, g.prize_amount, NULL as end_reason, false as forfeit,
               ux.username as player_x_name, ux.number as player_x_number, ux.created_at as player_x_created_at,
               uo.username as player_o_name, uo.number as player_o_number, uo.created_at as player_o_created_at
        FROM games g
        LEFT JOIN users ux ON g.player_x = ux.id
        LEFT JOIN users uo ON g.player_o = uo.id
        WHERE (g.player_x = $1::uuid OR g.player_o = $1::uuid)
        ORDER BY g.created_at DESC LIMIT 50
      `, [userId]);
      games = gamesRes.rows;
    } catch (e) { console.warn('[360] games query failed:', e.message); }

    // 5) Transactions (last 50)
    let transactions = [];
    try {
      const txRes = await pool.query(`
        SELECT id, tx_type as type, amount, status, created_at
        FROM wallet_transactions
        WHERE user_id = $1
        ORDER BY created_at DESC LIMIT 50
      `, [userId]);
      transactions = txRes.rows.map(r => ({ ...r, amount: Number(r.amount || 0), createdAt: r.created_at }));
    } catch (e) { console.warn('[360] transactions query failed:', e.message); }

    // 6) Totals
    let totals = { totalDeposited: 0, totalWithdrawn: 0 };
    try {
      const totalsRes = await pool.query(`
        SELECT
          COALESCE(SUM(CASE WHEN tx_type = 'DEPOSIT' AND status = 'COMPLETED' THEN amount ELSE 0 END), 0) as total_deposited,
          COALESCE(SUM(CASE WHEN tx_type IN ('WITHDRAW_SETTLED', 'WITHDRAW_REQUEST') AND status = 'COMPLETED' THEN amount ELSE 0 END), 0) as total_withdrawn
        FROM wallet_transactions WHERE user_id = $1
      `, [userId]);
      if (totalsRes.rows.length) {
        totals = {
          totalDeposited: Number(totalsRes.rows[0].total_deposited || 0),
          totalWithdrawn: Number(totalsRes.rows[0].total_withdrawn || 0),
        };
      }
    } catch (e) { console.warn('[360] totals query failed:', e.message); }

    // 7) User entry frequency stats (safe)
    let entries = { today: 0, thisWeek: 0, thisMonth: 0, total: 0 };
    try {
      const entryRes = await pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE) AS entries_today,
          COUNT(*) FILTER (WHERE created_at >= date_trunc('week', CURRENT_DATE)) AS entries_this_week,
          COUNT(*) FILTER (WHERE created_at >= date_trunc('month', CURRENT_DATE)) AS entries_this_month,
          COUNT(*) AS entries_total
        FROM user_entries
        WHERE user_id = $1
      `, [userId]);
      if (entryRes.rows.length) {
        const estats = entryRes.rows[0];
        entries = {
          today: Number(estats.entries_today || 0),
          thisWeek: Number(estats.entries_this_week || 0),
          thisMonth: Number(estats.entries_this_month || 0),
          total: Number(estats.entries_total || 0),
        };
      }
    } catch (e) { console.warn('[360] entries query failed:', e.message); }

    return res.json({ user, wallet, stats, games, transactions, totals, entries });
  } catch (err) {
    console.error('[ADMIN] /users/:id/360 error', err);
    return res.status(500).json({ error: 'Failed to fetch user detail' });
  }
});

// ──────────────────────────────────────────────
// GET /admin/transactions?type=deposit|withdrawal&status=pending&limit=&offset=
// Paginated transaction list
// ──────────────────────────────────────────────
router.get('/transactions', async (req, res) => {
  try {
    const limit  = Math.min(Number(req.query.limit  || 20), 100);
    const offset = Number(req.query.offset || 0);
    const type   = req.query.type;
    const status = req.query.status;
    const amountRange = req.query.amountRange || 'all';

    const conditions = [`(pt.provider IS NULL OR pt.provider != 'PRIZE')`];
    const params = [];
    let idx = 1;

    if (type) {
      let mappedType = type.toUpperCase();
      if (mappedType === 'WITHDRAWAL') {
        conditions.push(`pt.tx_type IN ($${idx++}, $${idx++})`);
        params.push('WITHDRAW_REQUEST', 'WITHDRAW_SETTLED');
      } else {
        conditions.push(`pt.tx_type = $${idx++}`);
        params.push(mappedType);
      }
    }
    if (status) {
      const statusList = String(status).split(',').map(s => {
        let val = s.trim().toUpperCase();
        if (val === 'SUCCESS' || val === 'SUCCEEDED' || val === 'COMPLETED' || val === 'PAID') return 'COMPLETED';
        if (val === 'REJECTED' || val === 'FAILED' || val === 'FAILURE' || val === 'ERROR') return 'FAILED';
        if (val === 'PENDING' || val === 'WAITING') return 'PENDING';
        return val;
      });
      if (statusList.length > 1) {
        const placeholders = statusList.map(() => `$${idx++}`).join(', ');
        conditions.push(`pt.status IN (${placeholders})`);
        params.push(...statusList);
      } else {
        conditions.push(`pt.status = $${idx++}`);
        params.push(statusList[0]);
      }
    }

    if (amountRange !== 'all') {
      if (amountRange === '0-100') {
        conditions.push(`pt.amount <= 100`);
      } else if (amountRange === '100-10000') {
        conditions.push(`pt.amount > 100 AND pt.amount <= 10000`);
      } else if (amountRange === '10000-100000') {
        conditions.push(`pt.amount > 10000 AND pt.amount <= 100000`);
      }
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const query = `
      SELECT pt.id, pt.tx_type as type, pt.amount, pt.status, pt.provider as bank, pt.provider_ref as tx_ref, pt.meta as provider_payload, pt.created_at, u.number, u.username, u.display_name
      FROM wallet_transactions pt
      LEFT JOIN users u ON u.id = pt.user_id
      ${where}
      ORDER BY pt.created_at DESC
      LIMIT $${idx++} OFFSET $${idx}
    `;
    params.push(limit, offset);

    const { rows } = await pool.query(query, params);
    const countRow = await pool.query(
      `SELECT COUNT(*) FROM wallet_transactions pt ${where}`,
      params.slice(0, -2)
    );

    const formatted = rows.map(r => ({
      ...r,
      amount: Number(r.amount || 0)
    }));

    return res.json({ transactions: formatted, total: Number(countRow.rows[0].count), limit, offset });
  } catch (err) {
    console.error('[ADMIN] /transactions error', err);
    return res.status(500).json({ error: 'Failed to fetch transactions' });
  }
});

// ──────────────────────────────────────────────
// GET /admin/transactions/:id/details
// Fetches detailed information for the manual review modal
// ──────────────────────────────────────────────
router.get('/transactions/:id/details', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT pt.id, pt.tx_type as type, pt.amount, pt.status, pt.provider_ref, pt.meta as provider_payload, pt.created_at, 
              u.id as user_id, u.username, u.number, u.banned, u.role, 
              (SELECT COUNT(*) FROM games WHERE winner = u.id) as total_wins, 
              (SELECT COUNT(*) FROM games WHERE player_x = u.id OR player_o = u.id) as total_games,
              w.available_balance, w.withdrawable_balance, w.bonus_balance
       FROM wallet_transactions pt
       JOIN users u ON u.id = pt.user_id
       LEFT JOIN wallets w ON w.user_id = u.id
       WHERE pt.id = $1`,
      [req.params.id]
    );

    if (!rows.length) return res.status(404).json({ error: 'Transaction not found' });
    const details = rows[0];

    // Fetch user's anomaly score from Redis if available
    const anomalyKey = `fw:user:${details.user_id}:score`;
    const anomalyScore = await redis.get(anomalyKey);

    const statsQuery = await pool.query(`
      SELECT 
        SUM(CASE WHEN tx_type::text IN ('DEPOSIT', 'ADMIN_DEPOSIT', 'ADMIN_EDIT') AND status = 'COMPLETED' THEN amount ELSE 0 END) as total_deposit,
        SUM(CASE WHEN tx_type::text IN ('WITHDRAW_SETTLED', 'WITHDRAW_REQUEST') AND status = 'COMPLETED' THEN amount ELSE 0 END) as total_withdraw
      FROM wallet_transactions 
      WHERE user_id = $1
    `, [details.user_id]);
    
    const aggregates = statsQuery.rows[0];

    // ─── Extract EXACT reason from provider payload ───
    let exactReason = null;
    try {
      const meta = typeof details.provider_payload === 'string' ? JSON.parse(details.provider_payload) : details.provider_payload;
      if (meta) {
        // Chapa response fields
        exactReason = meta.message || meta.error || meta.data?.message || meta.data?.error || meta.failure_reason || meta.reason || null;
        // If nested Chapa response
        if (!exactReason && meta.data?.data?.message) exactReason = meta.data.data.message;
        // Transfer-specific errors
        if (!exactReason && meta.transfer_error) exactReason = meta.transfer_error;
        if (!exactReason && meta.status_message) exactReason = meta.status_message;
      }
    } catch(e) { /* meta might not be valid JSON */ }

    return res.json({
      transaction: { ...details, exact_reason: exactReason },
      user: {
        id: details.user_id,
        username: details.username,
        number: details.number,
        banned: details.banned,
        role: details.role,
        anomaly_score: anomalyScore || 0,
        available_balance: Number(details.available_balance || 0),
        withdrawable_balance: Number(details.withdrawable_balance || 0),
        bonus_balance: Number(details.bonus_balance || 0),
        total_wins: Number(details.total_wins || 0),
        total_games: Number(details.total_games || 0),
        total_deposit: Number(aggregates.total_deposit || 0),
        total_withdraw: Number(aggregates.total_withdraw || 0)
      }
    });

  } catch (err) {
    console.error('[ADMIN] /transactions/:id/details error', err);
    return res.status(500).json({ error: 'Failed to fetch details' });
  }
});

// ──────────────────────────────────────────────
// PATCH /admin/transactions/:id/approve
// Marks a pending deposit as 'success' and credits the wallet
// ──────────────────────────────────────────────
router.patch('/transactions/:id/approve', async (req, res) => {
  try {
    await withTx(async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM wallet_transactions WHERE id = $1 FOR UPDATE`,
        [req.params.id]
      );
      if (!rows.length) throw Object.assign(new Error('Transaction not found'), { status: 404 });
      const txn = rows[0];

      if (txn.status !== 'PENDING' && txn.status !== 'PENDING_MANUAL') {
        throw Object.assign(new Error(`Cannot approve a ${txn.status} transaction`), { status: 409 });
      }

      // Mark as success and set type to SETTLED if it was a withdrawal request
      const newType = txn.tx_type === 'WITHDRAW_REQUEST' ? 'WITHDRAW_SETTLED' : txn.tx_type;
      await client.query(
        `UPDATE wallet_transactions SET status = 'COMPLETED', tx_type = $2, updated_at = now() WHERE id = $1`,
        [req.params.id, newType]
      );

      // For deposits: credit the wallet
      if (txn.tx_type === 'DEPOSIT') {
        await client.query(
          `INSERT INTO wallets (user_id, available_balance, withdrawable_balance)
           VALUES ($1, $2, $2)
           ON CONFLICT (user_id) DO UPDATE
           SET available_balance    = wallets.available_balance    + $2,
               withdrawable_balance = wallets.withdrawable_balance + $2,
               updated_at           = now()`,
          [txn.user_id, txn.amount]
        );
      }

      await logAdminAction(req.user.id, 'approved_transaction', txn.user_id, { tx_id: req.params.id, amount: txn.amount, type: txn.tx_type });
    });

    return res.json({ ok: true });

    return res.json({ ok: true });
  } catch (err) {
    console.error('[ADMIN] /transactions/:id/approve error', err);
    return res.status(err.status || 500).json({ error: err.message || 'Failed to approve' });
  }
});

// ──────────────────────────────────────────────
// PATCH /admin/transactions/:id/reject
// Marks a pending transaction as 'failed'
// For withdrawals: refund balance via settleWithdrawal (guarded + ledger row)
// ──────────────────────────────────────────────
router.patch('/transactions/:id/reject', async (req, res) => {
  try {
    const { rows: txnRows } = await pool.query(
      `SELECT tx_type FROM wallet_transactions WHERE id = $1`,
      [req.params.id]
    );
    if (!txnRows.length) throw Object.assign(new Error('Transaction not found'), { status: 404 });

    if (txnRows[0].tx_type === 'WITHDRAW_REQUEST') {
      // settleWithdrawal runs its own guarded transaction: locks the row, only
      // settles PENDING/PENDING_MANUAL, writes the WITHDRAW_REFUND:{txId} ledger
      // row and updates withdraw_requests — same path as the cron refunds.
      const result = await settleWithdrawal(req.params.id, 'FAILED', {
        reason: 'Rejected by admin',
        provider: 'ADMIN'
      });
      if (!result.settled) {
        throw Object.assign(new Error('Transaction was already settled'), { status: 409 });
      }
      await logAdminAction(req.user.id, 'rejected_transaction', null, { tx_id: req.params.id, type: 'WITHDRAW_REQUEST', refunded: result.refunded });
      return res.json({ ok: true });
    }

    await withTx(async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM wallet_transactions WHERE id = $1 FOR UPDATE`,
        [req.params.id]
      );
      if (!rows.length) throw Object.assign(new Error('Transaction not found'), { status: 404 });
      const txn = rows[0];

      if (txn.status !== 'PENDING' && txn.status !== 'PENDING_MANUAL') {
        throw Object.assign(new Error(`Cannot reject a ${txn.status} transaction`), { status: 409 });
      }

      await client.query(
        `UPDATE wallet_transactions SET status = 'FAILED', updated_at = now() WHERE id = $1`,
        [req.params.id]
      );

      // For withdrawals: refund the deducted balance
      if (txn.tx_type === 'WITHDRAW_REQUEST') {
        await client.query(
          `UPDATE wallets
           SET available_balance    = available_balance    + $2,
               withdrawable_balance = withdrawable_balance + $2,
               updated_at           = now()
           WHERE user_id = $1`,
          [txn.user_id, txn.amount]
        );
      }

      await logAdminAction(req.user.id, 'rejected_transaction', txn.user_id, { tx_id: req.params.id, type: txn.tx_type, amount: txn.amount });
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error('[ADMIN] /transactions/:id/reject error', err);
    return res.status(err.status || 500).json({ error: err.message || 'Failed to reject' });
  }
});

// ──────────────────────────────────────────────
// GET /admin/settings
// Returns all global settings
// ──────────────────────────────────────────────
router.get('/settings', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT key, value, updated_at FROM global_settings`);
    const settings = {};
    for (const row of rows) settings[row.key] = row.value;
    return res.json(settings);
  } catch (err) {
    console.error('[ADMIN] /settings GET error', err);
    return res.status(500).json({ error: 'Failed to fetch settings' });
  }
});



// ──────────────────────────────────────────────
// GET /admin/audit-logs
// ──────────────────────────────────────────────
router.get('/audit-logs', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 50), 500);
    const offset = Number(req.query.offset || 0);

    const { rows } = await pool.query(`
      SELECT 
        l.*, 
        u.username as admin_name,
        u.number as admin_number,
        COALESCE(t.username, t.number, l.target_id::text) as target_name
      FROM admin_audit_logs l
      LEFT JOIN users u ON l.admin_id::text = u.id::text
      LEFT JOIN users t ON l.target_id::text = t.id::text
      ORDER BY l.created_at DESC
      LIMIT $1 OFFSET $2
    `, [limit, offset]);

    const countRes = await pool.query(`SELECT COUNT(*) FROM admin_audit_logs`);
    return res.json({ ok: true, logs: rows, total: Number(countRes.rows[0].count) });
  } catch (err) {
    console.error('[ADMIN] /audit-logs error', err);
    return res.status(500).json({ error: 'Failed to fetch audit logs' });
  }
});

// ──────────────────────────────────────────────
// GET /admin/bonus-logs
// ──────────────────────────────────────────────
router.get('/bonus-logs', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM bonus_audit_logs ORDER BY created_at DESC LIMIT 50`);
    return res.json({ ok: true, logs: rows });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch bonus logs' });
  }
});

// ──────────────────────────────────────────────
// GET /admin/game-logs?limit=&offset=
// Paginated game history
// ──────────────────────────────────────────────
router.get('/game-logs', async (req, res) => {
  try {
    const limit  = Math.min(Number(req.query.limit  || 20), 2000); // Increased max limit to 2000
    const offset = Number(req.query.offset || 0);
    const amountRange = req.query.amountRange || 'all';

    let whereStr = '';
    if (amountRange !== 'all') {
      if (amountRange === '0-100') {
        whereStr = `WHERE g.bet_amount <= 100`;
      } else if (amountRange === '100-10000') {
        whereStr = `WHERE g.bet_amount > 100 AND g.bet_amount <= 10000`;
      } else if (amountRange === '10000-100000') {
        whereStr = `WHERE g.bet_amount > 10000 AND g.bet_amount <= 100000`;
      }
    }

    const { rows } = await pool.query(`
      SELECT
        g.id, g.bet_amount, g.status, g.created_at, g.finished_at,
        g.winner    AS winner_id,
        g.player_x  AS player_x_id,
        g.player_o  AS player_o_id,
        px.username AS player_x_name, px.number AS player_x_number,
        po.username AS player_o_name, po.number AS player_o_number,
        px.created_at AS player_x_created_at,
        po.created_at AS player_o_created_at
      FROM games g
      LEFT JOIN users px ON px.id = g.player_x
      LEFT JOIN users po ON po.id = g.player_o
      ${whereStr}
      ORDER BY g.created_at DESC
      LIMIT $1 OFFSET $2
    `, [limit, offset]);

    const formatted = rows.map(r => ({
      ...r,
      bet_amount: Number(r.bet_amount || 0)
    }));

    const countRes = await pool.query(`SELECT COUNT(*) FROM games g ${whereStr}`);
    return res.json({ games: formatted, total: Number(countRes.rows[0].count), limit, offset });
  } catch (err) {
    console.error('[ADMIN] /game-logs error', err);
    return res.status(500).json({ error: 'Failed to fetch game logs' });
  }
});

// ──────────────────────────────────────────────
// GET /admin/security/alerts
// ──────────────────────────────────────────────
router.get('/security/alerts', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT * FROM system_alerts 
      ORDER BY created_at DESC 
      LIMIT 100
    `);
    return res.json({ ok: true, alerts: rows });
  } catch (err) {
    console.error('[ADMIN] /security/alerts error', err);
    return res.status(500).json({ error: 'Failed to fetch security alerts' });
  }
});

// ──────────────────────────────────────────────
// PROMO CODES (GIVEAWAYS)
// ──────────────────────────────────────────────
router.get('/promocodes', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM promocodes ORDER BY created_at DESC`);
    return res.json({ ok: true, promocodes: rows });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch promo codes' });
  }
});

router.post('/promocodes', async (req, res) => {
  try {
    const { code, amount, description, target_type, usage_limit, expires_at } = req.body;
    if (!code || !amount) return res.status(400).json({ error: 'Code and Amount are required' });

    const { rows } = await pool.query(
      `INSERT INTO promocodes (code, amount, description, target_type, usage_limit, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [code.toUpperCase(), amount, description, target_type || 'ALL', usage_limit || null, expires_at || null]
    );

    await logAdminAction(req.user.id, 'created_promocode', rows[0].id, { code: rows[0].code, amount: rows[0].amount });

    return res.json({ ok: true, promocode: rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Promo code already exists' });
    console.error('[ADMIN] /promocodes post error', err);
    return res.status(500).json({ error: 'Failed to create promo code' });
  }
});

router.delete('/promocodes/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(`DELETE FROM promocodes WHERE id = $1 RETURNING code`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Promo code not found' });

    await logAdminAction(req.user.id, 'deleted_promocode', req.params.id, { code: rows[0].code });
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to delete promo code' });
  }
});

// ──────────────────────────────────────────────
// NEW GIVEAWAY SYSTEM
// ──────────────────────────────────────────────

// GET all giveaways
router.get('/giveaways', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT g.*, 
        (SELECT COUNT(*) FROM giveaway_claims WHERE giveaway_id = g.id) as claim_count
      FROM giveaways g 
      ORDER BY g.created_at DESC
    `);
    return res.json({ ok: true, giveaways: rows });
  } catch (err) {
    console.error('[ADMIN] /giveaways get error', err);
    return res.status(500).json({ error: 'Failed to fetch giveaways' });
  }
});

// POST new giveaway
router.post('/giveaways', async (req, res) => {
  try {
    const { title, description, amount, type, starts_at, ends_at, promo_code, metadata } = req.body;
    if (!title || !amount || !type) return res.status(400).json({ error: 'Title, Amount, and Type are required' });

    const { rows } = await pool.query(
      `INSERT INTO giveaways (title, description, amount, type, starts_at, ends_at, promo_code, created_by, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [title, description, amount, type, starts_at || new Date(), ends_at || null, promo_code || null, req.user.id, JSON.stringify(metadata || {})]
    );

    await logAdminAction(req.user.id, 'created_giveaway', rows[0].id, { title, amount, type });
    return res.json({ ok: true, giveaway: rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Promo code already exists' });
    console.error('[ADMIN] /giveaways post error', err);
    return res.status(500).json({ error: 'Failed to create giveaway' });
  }
});

// GET giveaway claims / stats
router.get('/giveaways/:id/claims', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 100), 500);
    const offset = Number(req.query.offset || 0);

    const [giveawayRes, claimsRes, countRes] = await Promise.all([
      pool.query(`SELECT id, title, amount, type, promo_code, starts_at, ends_at FROM giveaways WHERE id = $1`, [req.params.id]),
      pool.query(`
        SELECT c.*, u.username, u.number
        FROM giveaway_claims c
        JOIN users u ON c.user_id = u.id
        WHERE c.giveaway_id = $1
        ORDER BY c.claimed_at DESC
        LIMIT $2 OFFSET $3
      `, [req.params.id, limit, offset]),
      pool.query(`SELECT COUNT(*) FROM giveaway_claims WHERE giveaway_id = $1`, [req.params.id])
    ]);

    if (!giveawayRes.rows.length) return res.status(404).json({ error: 'Giveaway not found' });

    return res.json({ 
      ok: true, 
      giveaway: giveawayRes.rows[0],
      claims: claimsRes.rows, 
      total: Number(countRes.rows[0].count),
      limit,
      offset
    });
  } catch (err) {
    console.error('[ADMIN] /giveaways/claims error', err);
    return res.status(500).json({ error: 'Failed to fetch giveaway claims' });
  }
});

// DELETE giveaway
router.delete('/giveaways/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(`DELETE FROM giveaways WHERE id = $1 RETURNING title`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Giveaway not found' });
    await logAdminAction(req.user.id, 'deleted_giveaway', req.params.id, { title: rows[0].title });
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to delete giveaway' });
  }
});

// ──────────────────────────────────────────────
// REFERRALS
// ──────────────────────────────────────────────
router.get('/referrals/detailed', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT 
        r.referrer_id,
        ur.username as referrer_name,
        r.referred_id,
        ud.username as referred_name,
        r.bonus_amount,
        r.created_at as joined_at,
        (SELECT COUNT(*) FROM games g WHERE g.player_x = r.referred_id OR g.player_o = r.referred_id) as games_played,
        w.available_balance as referred_balance,
        COALESCE(w.bonus_balance, 0) as referred_bonus_balance
      FROM referrals r
      JOIN users ur ON ur.id = r.referrer_id
      JOIN users ud ON ud.id = r.referred_id
      LEFT JOIN wallets w ON w.user_id = ud.id
      ORDER BY r.created_at DESC
      LIMIT 500
    `);
    
    // Aggregates for convenience
    const { rows: aggRows } = await pool.query(`
      SELECT 
        COUNT(DISTINCT referrer_id) as total_referrers,
        COUNT(id) as total_referred,
        SUM(bonus_amount) as total_bonuses_paid
      FROM referrals
    `);
    
    return res.json({ ok: true, referrals: rows, metrics: aggRows[0] });
  } catch (err) {
    console.error('[ADMIN] /referrals/detailed error', err);
    return res.status(500).json({ error: 'Failed to fetch referral details' });
  }
});

router.get('/users/:id/referrals-detailed', async (req, res) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(`
      SELECT 
        r.referred_id,
        ud.username as referred_name,
        r.bonus_amount,
        r.created_at as joined_at,
        (SELECT COUNT(*) FROM games g WHERE g.player_x = r.referred_id OR g.player_o = r.referred_id) as games_played,
        w.available_balance as referred_balance
      FROM referrals r
      JOIN users ud ON ud.id = r.referred_id
      LEFT JOIN wallets w ON w.user_id = ud.id
      WHERE r.referrer_id = $1
      ORDER BY r.created_at DESC
    `, [id]);
    
    // Total bonus this user earned from referrals
    const { rows: aggRows } = await pool.query(`
      SELECT SUM(bonus_amount) as total_earned FROM referrals WHERE referrer_id = $1
    `, [id]);
    
    return res.json({ ok: true, referrals: rows, total_earned: Number(aggRows[0]?.total_earned || 0) });
  } catch (err) {
    console.error('[ADMIN] /users/:id/referrals-detailed error', err);
    return res.status(500).json({ error: 'Failed to fetch user referrals' });
  }
});


// ──────────────────────────────────────────────
// PROMOTION LINKS
// ──────────────────────────────────────────────

router.get('/promotion-links', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM promotion_links ORDER BY created_at DESC');
    res.json(rows);
  } catch (err) {
    console.error('[ADMIN] GET /promotion-links err', err);
    res.status(500).json({ error: 'Failed to fetch promotion links' });
  }
});

router.post('/promotion-links', async (req, res) => {
  try {
    const { name, bonus_amount, code, expires_at } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });
    
    const amt = Number(bonus_amount || 0);
    const promoCode = (code && code.trim()) ? code.trim().toUpperCase() : ('PROMO' + Math.floor(Math.random() * 1000000));

    const { rows } = await pool.query(
      `INSERT INTO promotion_links (name, bonus_amount, code, is_active, total_claims, total_registrations) 
       VALUES ($1, $2, $3, true, 0, 0) RETURNING *`,
      [name, amt, promoCode]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('[ADMIN] POST /promotion-links err', err);
    // Return the actual error message for debugging
    res.status(500).json({ error: 'Failed to create promotion link: ' + err.message });
  }
});

router.patch('/promotion-links/:id', async (req, res) => {
  try {
    const { name, bonus_amount, code, expires_at, is_active } = req.body;
    const { id } = req.params;

    const updates = [];
    const params = [];
    let idx = 1;

    if (name !== undefined) { updates.push(`name = $${idx++}`); params.push(name); }
    if (bonus_amount !== undefined) { updates.push(`bonus_amount = $${idx++}`); params.push(Number(bonus_amount || 0)); }
    if (code !== undefined) { updates.push(`code = $${idx++}`); params.push(code); }
    if (expires_at !== undefined) { updates.push(`expires_at = $${idx++}`); params.push(expires_at); }
    if (is_active !== undefined) { updates.push(`is_active = $${idx++}`); params.push(is_active); }

    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });

    params.push(id);
    const { rows } = await pool.query(
      `UPDATE promotion_links SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
      params
    );

    if (!rows.length) return res.status(404).json({ error: 'Promotion link not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[ADMIN] PATCH /promotion-links/:id err', err);
    res.status(500).json({ error: 'Failed to update promotion link' });
  }
});

router.delete('/promotion-links/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM promotion_claims WHERE promotion_link_id = $1', [id]);
    await pool.query('DELETE FROM promotion_links WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[ADMIN] DELETE /promotion-links/:id err', err);
    res.status(500).json({ error: 'Failed to delete promotion link' });
  }
});

router.get('/promotion-links/:id/claims', async (req, res) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(`
      SELECT plc.id, plc.claimed_at as created_at, u.username, u.number 
      FROM promotion_claims plc
      JOIN users u ON u.id = plc.user_id
      WHERE plc.promotion_link_id = $1
      ORDER BY plc.claimed_at DESC
      LIMIT 100
    `, [id]);
    res.json(rows);
  } catch (err) {
    console.error('[ADMIN] GET /promotion-links/:id/claims err', err);
    res.status(500).json({ error: 'Failed to fetch claims' });
  }
});

// ──────────────────────────────────────────────
// Maintenance & Feature Settings
// ──────────────────────────────────────────────
router.get('/maintenance/settings', async (req, res) => {
  try {
    if (!['superadmin', 'maintenance_admin', 'maintenance'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Permission denied' });
    }
    const { rows } = await pool.query("SELECT key, value FROM global_settings WHERE key LIKE 'feature_%' OR key IN ('system_emergency_lockout', 'lockdown_whitelist', 'leaderboard_enabled', 'mobile_app_lockout')");
    const settings = {};
    rows.forEach(r => settings[r.key] = r.value);
    res.json(settings);
  } catch (err) {
    console.error('[ADMIN] GET /maintenance/settings err', err);
    res.status(500).json({ error: 'Failed to fetch maintenance settings' });
  }
});

router.post('/maintenance/settings', async (req, res) => {
  try {
    if (!['superadmin', 'maintenance_admin', 'maintenance'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Permission denied' });
    }
    const { key, value } = req.body;
    if (!key) return res.status(400).json({ error: 'Missing key' });
    
    await pool.query(
      `INSERT INTO global_settings (key, value) VALUES ($1, $2::jsonb) 
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [key, JSON.stringify(value)]
    );
    const { invalidateGlobalSettingCache } = require('../db/index');
    invalidateGlobalSettingCache(key);
    res.json({ ok: true });
  } catch (err) {
    console.error('[ADMIN] POST /maintenance/settings err', err);
    res.status(500).json({ error: 'Failed to update maintenance settings' });
  }
});

router.post('/maintenance/whitelist', async (req, res) => {
  try {
    if (!['superadmin', 'maintenance_admin', 'maintenance'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Permission denied' });
    }
    const { identifier } = req.body; // Phone number or username
    if (!identifier) return res.status(400).json({ error: 'Missing identifier' });
    
    const { rows } = await pool.query("SELECT value FROM global_settings WHERE key = 'lockdown_whitelist'");
    let whitelist = rows.length > 0 ? rows[0].value : [];
    if (!Array.isArray(whitelist)) whitelist = [];
    
    if (!whitelist.includes(identifier)) {
      whitelist.push(identifier);
      await pool.query(
        `INSERT INTO global_settings (key, value) VALUES ('lockdown_whitelist', $1::jsonb) 
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [JSON.stringify(whitelist)]
      );
    }
    res.json({ ok: true, whitelist });
  } catch (err) {
    console.error('[ADMIN] POST /maintenance/whitelist err', err);
    res.status(500).json({ error: 'Failed to update whitelist' });
  }
});

router.post('/maintenance/whitelist/remove', async (req, res) => {
  try {
    if (!['superadmin', 'maintenance_admin', 'maintenance'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Permission denied' });
    }
    const { identifier } = req.body;
    if (!identifier) return res.status(400).json({ error: 'Missing identifier' });
    
    const { rows } = await pool.query("SELECT value FROM global_settings WHERE key = 'lockdown_whitelist'");
    let whitelist = rows.length > 0 ? rows[0].value : [];
    if (!Array.isArray(whitelist)) whitelist = [];
    
    whitelist = whitelist.filter(id => id !== identifier);
    await pool.query(
      `UPDATE global_settings SET value = $1::jsonb, updated_at = NOW() WHERE key = 'lockdown_whitelist'`,
      [JSON.stringify(whitelist)]
    );
    res.json({ ok: true, whitelist });
  } catch (err) {
    console.error('[ADMIN] POST /maintenance/whitelist/remove err', err);
    res.status(500).json({ error: 'Failed to update whitelist' });
  }
});

// ──────────────────────────────────────────────
// Bulk SMS & Image Upload (Promotions)
// ──────────────────────────────────────────────

router.get('/promo-popup', async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM promo_popups ORDER BY created_at DESC");
    res.json({ ok: true, popups: rows });
  } catch (err) {
    console.error('[ADMIN] GET /promo-popup err', err);
    res.status(500).json({ error: 'Failed to fetch promo popups' });
  }
});

router.post('/promo-popup', async (req, res) => {
  try {
    const { image_url, display_duration, expires_at, starts_at, is_active } = req.body;
    
    // If activating a new popup, deactivate all others first
    if (is_active) {
      await pool.query(`UPDATE promo_popups SET is_active = false`);
    }

    const { rows } = await pool.query(`
      INSERT INTO promo_popups (image_url, display_duration, expires_at, starts_at, is_active)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `, [image_url, display_duration || 5, expires_at || null, starts_at || null, is_active || false]);
    
    res.json({ ok: true, config: rows[0] });
  } catch (err) {
    console.error('[ADMIN] POST /promo-popup err', err);
    res.status(500).json({ error: 'Failed to save promo popup' });
  }
});

router.patch('/promo-popup/:id', async (req, res) => {
  try {
    const { is_active } = req.body;
    const { id } = req.params;

    if (is_active) {
      await pool.query(`UPDATE promo_popups SET is_active = false`);
    }

    const { rows } = await pool.query(`
      UPDATE promo_popups 
      SET is_active = $1 
      WHERE id = $2 
      RETURNING *
    `, [is_active, id]);

    if (rows.length === 0) return res.status(404).json({ error: 'Popup not found' });
    res.json({ ok: true, config: rows[0] });
  } catch (err) {
    console.error('[ADMIN] PATCH /promo-popup err', err);
    res.status(500).json({ error: 'Failed to update promo popup' });
  }
});

router.delete('/promo-popup/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { rowCount } = await pool.query(`DELETE FROM promo_popups WHERE id = $1`, [id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Popup not found' });
    res.json({ ok: true, message: 'Popup deleted successfully' });
  } catch (err) {
    console.error('[ADMIN] DELETE /promo-popup err', err);
    res.status(500).json({ error: 'Failed to delete promo popup' });
  }
});

router.post('/bulk-sms', async (req, res) => {
  try {
    const { message, role, min_balance, max_balance, min_wins, specific_phone } = req.body;
    if (!message) return res.status(400).json({ error: 'Message is required' });

    let query = `
      SELECT DISTINCT ON (u.number) u.number, u.username 
      FROM users u
      LEFT JOIN wallets w ON u.id = w.user_id
      WHERE u.number IS NOT NULL AND u.number != '' AND u.banned = false
    `;
    const params = [];
    let paramIdx = 1;

    // Filters
    if (specific_phone) {
      const phones = specific_phone.split(',').map(p => p.trim()).filter(Boolean);
      const phoneList = [];
      for (let p of phones) {
        phoneList.push(p);
        
        const digits = p.replace(/\D/g, '');
        let core = '';
        if (digits.length === 9) core = digits;
        else if (digits.length === 10 && digits.startsWith('0')) core = digits.slice(1);
        else if (digits.length === 12 && digits.startsWith('251')) core = digits.slice(3);
        
        if (core) {
            phoneList.push('0' + core);
            phoneList.push('251' + core);
            phoneList.push('+251' + core);
        }
      }
      query += ` AND u.number = ANY($${paramIdx}::text[])`;
      params.push(phoneList);
      paramIdx++;
    } else {
      if (role && role !== 'all') {
        query += ` AND u.role = $${paramIdx}`;
        params.push(role);
        paramIdx++;
      }
      if (min_balance !== undefined && min_balance !== null) {
        query += ` AND w.available_balance >= $${paramIdx}`;
        params.push(Number(min_balance));
        paramIdx++;
      }
      if (max_balance !== undefined && max_balance !== null) {
        query += ` AND w.available_balance <= $${paramIdx}`;
        params.push(Number(max_balance));
        paramIdx++;
      }
      if (min_wins !== undefined && min_wins !== null) {
        query += ` AND u.room_1_wins >= $${paramIdx}`;
        params.push(Number(min_wins));
        paramIdx++;
      }
    }

    const { rows } = await pool.query(query, params);
    if (rows.length === 0) return res.json({ ok: true, queuedCount: 0, message: 'No users matched criteria' });

    // Deduplicate by phone number (safety net)
    const sentPhones = new Set();
    let successCount = 0;
    const { sendSMS } = require('../utils/sms');
    for (const user of rows) {
      if (user.number && !sentPhones.has(user.number)) {
        sentPhones.add(user.number);
        // Replace placeholders dynamically
        const formattedMessage = message
          .replace(/{username}/g, user.username || '')
          .replace(/{name}/g, user.name || user.username || '')
          .replace(/{phone}/g, user.number || '');
        const success = await sendSMS(user.number, formattedMessage).catch(() => false);
        if (success) successCount++;
      }
    }

    // Log history
    await pool.query(`
      INSERT INTO bulk_sms_history (admin_id, message, filters, target_count, success_count)
      VALUES ($1, $2, $3, $4, $5)
    `, [
      req.user.id, 
      message, 
      JSON.stringify({ role, min_balance, max_balance, min_wins, specific_phone }), 
      rows.length, 
      successCount
    ]);

    res.json({ ok: true, queuedCount: rows.length, successCount, message: `Queued SMS for ${rows.length} users.` });
  } catch (err) {
    console.error('[ADMIN] POST /bulk-sms err', err);
    res.status(500).json({ error: 'Failed to queue bulk SMS' });
  }
});

router.post('/bulk-sms/preview', async (req, res) => {
  try {
    const { role, min_balance, max_balance, min_wins, specific_phone } = req.body;

    let query = `
      SELECT COUNT(DISTINCT u.number) as count
      FROM users u
      LEFT JOIN wallets w ON u.id = w.user_id
      WHERE u.number IS NOT NULL AND u.number != '' AND u.banned = false
    `;
    const params = [];
    let paramIdx = 1;

    // Filters
    if (specific_phone) {
      const phones = specific_phone.split(',').map(p => p.trim()).filter(Boolean);
      const phoneList = [];
      for (let p of phones) {
        phoneList.push(p);
        
        const digits = p.replace(/\D/g, '');
        let core = '';
        if (digits.length === 9) core = digits;
        else if (digits.length === 10 && digits.startsWith('0')) core = digits.slice(1);
        else if (digits.length === 12 && digits.startsWith('251')) core = digits.slice(3);
        
        if (core) {
            phoneList.push('0' + core);
            phoneList.push('251' + core);
            phoneList.push('+251' + core);
        }
      }
      query += ` AND u.number = ANY($${paramIdx}::text[])`;
      params.push(phoneList);
      paramIdx++;
    } else {
      if (role && role !== 'all') {
        query += ` AND u.role = $${paramIdx}`;
        params.push(role);
        paramIdx++;
      }
      if (min_balance !== undefined && min_balance !== null && min_balance !== '') {
        query += ` AND w.available_balance >= $${paramIdx}`;
        params.push(Number(min_balance));
        paramIdx++;
      }
      if (max_balance !== undefined && max_balance !== null && max_balance !== '') {
        query += ` AND w.available_balance <= $${paramIdx}`;
        params.push(Number(max_balance));
        paramIdx++;
      }
      if (min_wins !== undefined && min_wins !== null && min_wins !== '') {
        query += ` AND u.room_1_wins >= $${paramIdx}`;
        params.push(Number(min_wins));
        paramIdx++;
      }
    }

    const { rows } = await pool.query(query, params);
    const count = Number(rows[0]?.count || 0);
    return res.json({ ok: true, count });
  } catch (err) {
    console.error('[ADMIN] POST /bulk-sms/preview err', err);
    res.status(500).json({ error: 'Failed to count preview users' });
  }
});

router.get('/bulk-sms/preview', async (req, res) => {
  try {
    const { role, min_balance, max_balance, min_wins, specific_phone } = req.query;

    let query = `
      SELECT DISTINCT u.username, u.display_name as name, u.number as phone
      FROM users u
      LEFT JOIN wallets w ON u.id = w.user_id
      WHERE u.number IS NOT NULL AND u.number != '' AND u.banned = false
    `;
    const params = [];
    let paramIdx = 1;

    // Filters
    if (specific_phone) {
      const phones = specific_phone.split(',').map(p => p.trim()).filter(Boolean);
      const phoneList = [];
      for (let p of phones) {
        phoneList.push(p);
        
        const digits = p.replace(/\D/g, '');
        let core = '';
        if (digits.length === 9) core = digits;
        else if (digits.length === 10 && digits.startsWith('0')) core = digits.slice(1);
        else if (digits.length === 12 && digits.startsWith('251')) core = digits.slice(3);
        
        if (core) {
            phoneList.push('0' + core);
            phoneList.push('251' + core);
            phoneList.push('+251' + core);
        }
      }
      query += ` AND u.number = ANY($${paramIdx}::text[])`;
      params.push(phoneList);
      paramIdx++;
    } else {
      if (role && role !== 'all') {
        query += ` AND u.role = $${paramIdx}`;
        params.push(role);
        paramIdx++;
      }
      if (min_balance !== undefined && min_balance !== null && min_balance !== '') {
        query += ` AND w.available_balance >= $${paramIdx}`;
        params.push(Number(min_balance));
        paramIdx++;
      }
      if (max_balance !== undefined && max_balance !== null && max_balance !== '') {
        query += ` AND w.available_balance <= $${paramIdx}`;
        params.push(Number(max_balance));
        paramIdx++;
      }
      if (min_wins !== undefined && min_wins !== null && min_wins !== '') {
        query += ` AND u.room_1_wins >= $${paramIdx}`;
        params.push(Number(min_wins));
        paramIdx++;
      }
    }

    query += ` ORDER BY u.username ASC LIMIT 1000`;

    const { rows } = await pool.query(query, params);
    return res.json({ ok: true, users: rows });
  } catch (err) {
    console.error('[ADMIN] GET /bulk-sms/preview err', err);
    res.status(500).json({ error: 'Failed to fetch preview users' });
  }
});


router.get('/bulk-sms/history', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT b.*, u.username as admin_name
      FROM bulk_sms_history b
      LEFT JOIN users u ON b.admin_id = u.id
      ORDER BY b.created_at DESC
      LIMIT 50
    `);
    res.json({ ok: true, history: rows });
  } catch (err) {
    console.error('[ADMIN] GET /bulk-sms/history err', err);
    res.status(500).json({ error: 'Failed to fetch bulk SMS history' });
  }
});

// Set up multer for local uploads (prep for Supabase)
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = path.join(__dirname, '../../public/uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});
const upload = multer({ storage: storage });

router.post('/upload-promo', upload.single('image'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    // Return the local URL which the frontend can use
    // When migrating to Supabase Storage, we would upload the buffer here instead
    const fileUrl = `/uploads/${req.file.filename}`;
    res.json({ ok: true, url: fileUrl });
  } catch (err) {
    console.error('[ADMIN] POST /upload-promo err', err);
    res.status(500).json({ error: 'Failed to upload image' });
  }
});

// ──────────────────────────────────────────────
// GET /admin/metrics/live
// Real-time live metrics for the admin dashboard overview
// ──────────────────────────────────────────────
router.get('/metrics/live', async (req, res) => {
  try {
    const [activeGamesRes, onlineRes, depositsTodayRes, withdrawalsTodayRes, dauRes, ggrRes, pendingRes] = await Promise.all([
      // [0] Active games RIGHT NOW
      pool.query(`SELECT COUNT(*) as count FROM games WHERE status IN ('live', 'starting', 'ongoing')`),
      // [1] Online users (connected sockets tracked in Redis)
      redis.scard('online_users').catch(() => 0),
      // [2] Deposits completed today
      pool.query(`
        SELECT COALESCE(SUM(amount), 0) as total, COUNT(*) as count
        FROM wallet_transactions
        WHERE tx_type = 'DEPOSIT' AND status = 'COMPLETED'
        AND created_at >= CURRENT_DATE
      `),
      // [3] Withdrawals settled today
      pool.query(`
        SELECT COALESCE(SUM(amount), 0) as total, COUNT(*) as count
        FROM wallet_transactions
        WHERE tx_type IN ('WITHDRAW_SETTLED', 'WITHDRAW_REQUEST') AND status = 'COMPLETED'
        AND created_at >= CURRENT_DATE
      `),
      // [4] Daily active users (played at least 1 game today)
      pool.query(`
        SELECT COUNT(DISTINCT u.id) as count
        FROM games g
        JOIN users u ON u.id = g.player_x OR u.id = g.player_o
        WHERE g.created_at >= CURRENT_DATE
      `),
      // [5] Gross Gaming Revenue today (10% default, 20% for 10 Birr)
      pool.query(`
        SELECT COALESCE(SUM(bet_amount * CASE WHEN bet_amount = 10 THEN 0.2 ELSE 0.1 END), 0) as ggr
        FROM games
        WHERE status IN ('completed', 'X', 'O') AND winner IS NOT NULL
        AND created_at >= CURRENT_DATE
      `),
      // [6] Pending manual withdrawals
      pool.query(`
        SELECT wt.id, wt.amount, wt.created_at, wt.status, u.username, u.number
        FROM wallet_transactions wt
        JOIN users u ON u.id = wt.user_id
        WHERE wt.tx_type = 'WITHDRAW_REQUEST' AND wt.status IN ('PENDING', 'PENDING_MANUAL')
        ORDER BY wt.created_at ASC
        LIMIT 20
      `)
    ]);

    const activeMatches = Number(activeGamesRes.rows[0]?.count || 0);
    const onlineUsers = typeof onlineRes === 'number' ? onlineRes : Number(onlineRes || 0);
    const depositsToday = Number(depositsTodayRes.rows[0]?.total || 0);
    const withdrawalsToday = Number(withdrawalsTodayRes.rows[0]?.total || 0);
    const dailyActiveUsers = Number(dauRes.rows[0]?.count || 0);
    const grossGamingRevenue = Number(ggrRes.rows[0]?.ggr || 0);

    return res.json({
      ok: true,
      activeMatches,
      onlineUsers,
      depositsToday,
      withdrawalsToday,
      dailyActiveUsers,
      grossGamingRevenue,
      pendingWithdrawals: pendingRes.rows.map(r => ({
        ...r,
        amount: Number(r.amount || 0)
      })),
      systemHealth: {
        database: { label: 'Database', status: 'operational' },
        redis: { label: 'Redis', status: 'operational' },
        timestamp: { label: 'Server Time Sync', status: 'operational' }
      }
    });
  } catch (err) {
    console.error('[ADMIN] /metrics/live error', err);
    return res.status(500).json({ error: 'Failed to fetch live metrics' });
  }
});

// ──────────────────────────────────────────────
// LEADERBOARD ADMIN ENDPOINTS
// ──────────────────────────────────────────────

// Helper: Get current week boundaries (Sunday 00:00 → Saturday 23:59)
function getWeekBounds() {
  const now = new Date();
  const day = now.getUTCDay(); // 0=Sun, 1=Mon, ...
  
  const sunday = new Date(now);
  sunday.setUTCDate(now.getUTCDate() - day);
  sunday.setUTCHours(0, 0, 0, 0);
  
  const saturday = new Date(sunday);
  saturday.setUTCDate(sunday.getUTCDate() + 6);
  saturday.setUTCHours(23, 59, 59, 999);
  
  return { weekStart: sunday, weekEnd: saturday };
}

// Helper: Get previous week boundaries (Sunday 00:00 → Saturday 23:59)
function getPrevWeekBounds() {
  const now = new Date();
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

// GET /admin/leaderboard/current — Current week standings
router.get('/leaderboard/current', async (req, res) => {
  try {
    const { weekStart, weekEnd } = getWeekBounds();
    const search = req.query.search ? `%${req.query.search}%` : null;
    const limit = Math.min(Number(req.query.limit || 50), 100);
    const offset = Number(req.query.offset || 0);

    const query = `
      WITH WeeklyWins AS (
        SELECT 
          u.id, u.username, u.number, u.avatar,
          COUNT(g.id) AS wins
        FROM games g
        JOIN users u ON u.id = g.winner
        WHERE g.status IN ('completed', 'finished')
          AND g.winner IS NOT NULL
          AND g.created_at >= $1 AND g.created_at <= $2
        GROUP BY u.id, u.username, u.number, u.avatar
        HAVING COUNT(g.id) >= 1
      ),
      RankedWins AS (
        SELECT
          id, username, number, avatar, wins,
          RANK() OVER (ORDER BY wins DESC) as rank
        FROM WeeklyWins
      )
      SELECT *, COUNT(*) OVER() as total_count 
      FROM RankedWins
      WHERE ($3::text IS NULL OR username ILIKE $3 OR number ILIKE $3)
      ORDER BY rank ASC
      LIMIT $4 OFFSET $5
    `;

    const { rows } = await pool.query(query, [
      weekStart.toISOString(), 
      weekEnd.toISOString(),
      search,
      limit,
      offset
    ]);

    const totalCount = Number(rows[0]?.total_count || 0);
    const ranked = rows.map(u => ({
      id: u.id,
      username: u.username,
      number: u.number,
      avatar: u.avatar,
      rank: Number(u.rank),
      wins: Number(u.wins),
    }));

    res.json({
      ok: true,
      standings: ranked,
      total: totalCount,
      weekStart: weekStart.toISOString(),
      weekEnd: weekEnd.toISOString(),
    });
  } catch (err) {
    console.error('[ADMIN] /leaderboard/current error:', err);
    res.status(500).json({ error: 'Failed to fetch leaderboard standings' });
  }
});

// GET /admin/leaderboard/snapshots — Past week snapshots
router.get('/leaderboard/snapshots', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT * FROM leaderboard_snapshots
      ORDER BY week_start DESC, rank ASC
      LIMIT 100
    `);
    res.json({ ok: true, snapshots: rows });
  } catch (err) {
    console.error('[ADMIN] /leaderboard/snapshots error:', err);
    res.status(500).json({ error: 'Failed to fetch snapshots' });
  }
});

// POST /admin/leaderboard/snapshot — Create a snapshot of current week + award prizes
router.post('/leaderboard/snapshot', async (req, res) => {
  try {
    const { weekStart, weekEnd } = getWeekBounds();
    const weekStartStr = weekStart.toISOString().slice(0, 10);
    const weekEndStr = weekEnd.toISOString().slice(0, 10);

    // Check if snapshot already exists for this week
    const { rows: existing } = await pool.query(
      `SELECT id FROM leaderboard_snapshots WHERE week_start = $1 LIMIT 1`,
      [weekStartStr]
    );
    if (existing.length > 0) {
      return res.status(400).json({ error: 'Snapshot for this week already exists' });
    }

    // Get top 3 winners
    const { rows } = await pool.query(`
      SELECT 
        u.id, u.username,
        COUNT(*) AS wins
      FROM games g
      JOIN users u ON u.id = g.winner
      WHERE g.status IN ('completed', 'finished')
        AND g.winner IS NOT NULL
        AND g.created_at >= $1 AND g.created_at <= $2
      GROUP BY u.id, u.username
      ORDER BY wins DESC
      LIMIT 3
    `, [weekStart.toISOString(), weekEnd.toISOString()]);

    const prizes = req.body.prizes || [500, 300, 200];
    const autoApprove = req.body.autoApprove === true;
    const notificationTemplate = req.body.notificationTemplate || "🏆 Congratulations! You ranked #{rank} on this week's leaderboard with {wins} wins and earned {prize} ETB! The prize has been added to your balance.";
    const smsTemplate = req.body.smsTemplate || "🏆 Congratulations {username}! You ranked #{rank} on the XO ET weekly leaderboard and won {prize} ETB! Keep playing!";

    for (let i = 0; i < rows.length; i++) {
      const user = rows[i];
      const prizeAmount = Number(prizes[i]) || 0;
      const status = autoApprove ? 'approved' : 'pending';

      await pool.query(`
        INSERT INTO leaderboard_snapshots (week_start, week_end, user_id, username, wins, rank, prize_amount, prize_status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `, [weekStartStr, weekEndStr, user.id, user.username, Number(user.wins), i + 1, prizeAmount, status]);

      // If auto-approve, add prize to bonus_balance
      if (autoApprove && prizeAmount > 0) {
        // Ledger-first award: the LEADERBOARD_PRIZE ledger row is the double-credit
        // guard — the wallet is credited only if the row was actually inserted.
        const { inserted } = await withTx(async (txClient) => {
          const { ledgerFirstCredit } = require('../models/ledgerFirstCredit');
          const { inserted } = await ledgerFirstCredit(txClient, {
            userId: user.id, txType: 'PRIZE', amount: prizeAmount,
            idempotencyKey: `LEADERBOARD_PRIZE_${weekStartStr}_${i + 1}`, provider: 'LEADERBOARD_PRIZE',
            meta: { rank: i + 1, weekStart: weekStartStr }
          });
          if (!inserted) return { inserted: false };

          await txClient.query(`UPDATE wallets SET bonus_balance = bonus_balance + $1, available_balance = available_balance + $1 WHERE user_id = $2`, [prizeAmount, user.id]);
          await txClient.query(`INSERT INTO bonus_logs (user_id, amount, reason) VALUES ($1, $2, $3)`, [user.id, prizeAmount, `Weekly Leaderboard #${i + 1} Prize`]);
          return { inserted: true };
        });

        if (inserted) {
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
            console.error('[ADMIN SNAPSHOT] accomplishment update failed:', err);
          }

          // Create customized in-app notification
          const notifMsg = notificationTemplate
            .replace('{username}', user.username || '')
            .replace('{rank}', String(i + 1))
            .replace('{wins}', String(user.wins))
            .replace('{prize}', String(prizeAmount));

          const rankLabels = ['🥇 1st Place Champion', '🥈 2nd Place', '🥉 3rd Place'];
          await pool.query(`
            INSERT INTO notifications (user_id, type, title, message, meta)
            VALUES ($1, 'leaderboard_award', $2, $3, $4::jsonb)
          `, [
            user.id,
            rankLabels[i] || `#${i + 1} Weekly Award`,
            notifMsg,
            JSON.stringify({ rank: i + 1, prize: prizeAmount, wins: Number(user.wins), weekStart: weekStartStr, weekEnd: weekEndStr })
          ]).catch(err => console.error('[SNAPSHOT] notification failed:', err));

          // Send congratulations SMS
          const { rows: uInfo } = await pool.query(`SELECT number FROM users WHERE id = $1`, [user.id]);
          const phone = uInfo[0]?.number;
          if (phone) {
            const smsMsg = smsTemplate
              .replace('{username}', user.username || '')
              .replace('{rank}', String(i + 1))
              .replace('{prize}', String(prizeAmount));

            try {
              console.log(`[SNAPSHOT ADMIN] Sending SMS to ${user.username} (${phone})...`);
              await sendSMS(phone, smsMsg).catch(() => false);
            } catch (e) {
              console.error(`[SNAPSHOT ADMIN] SMS error for ${user.username}:`, e.message);
            }
          }
        } else {
          console.log(`[ADMIN SNAPSHOT] Rank #${i + 1} prize already awarded (ledger row exists) — skipping credit.`);
        }
      }
    }

    await logAdminAction(req.user.id, 'created_leaderboard_snapshot', null, { weekStart: weekStartStr, autoApprove });

    res.json({ ok: true, message: autoApprove ? 'Snapshot created and prizes awarded' : 'Snapshot created (pending approval)' });
  } catch (err) {
    console.error('[ADMIN] /leaderboard/snapshot error:', err);
    res.status(500).json({ error: 'Failed to create snapshot' });
  }
});

// POST /admin/leaderboard/approve/:snapshotId — Approve a specific prize
router.post('/leaderboard/approve/:snapshotId', async (req, res) => {
  try {
    const { snapshotId } = req.params;

    const snap = await withTx(async (client) => {
      // 🔒 Lock snapshot row FOR UPDATE to prevent concurrent double-approvals
      const { rows } = await client.query(`SELECT * FROM leaderboard_snapshots WHERE id = $1 FOR UPDATE`, [snapshotId]);
      if (!rows.length) {
        const err = new Error('Snapshot not found');
        err.status = 404;
        throw err;
      }

      const snapshot = rows[0];
      if (snapshot.prize_status === 'approved') {
        const err = new Error('Already approved');
        err.status = 400;
        throw err;
      }

      const prizeAmount = Math.round(Number(snapshot.prize_amount));

      // Mark as approved IMMEDIATELY inside the lock
      await client.query(`UPDATE leaderboard_snapshots SET prize_status = 'approved' WHERE id = $1`, [snapshotId]);

      // Award prize if amount > 0
      if (prizeAmount > 0) {
        // Ledger-first: credit only if the LEADERBOARD_PRIZE ledger row inserted
        const { ledgerFirstCredit } = require('../models/ledgerFirstCredit');
        const { inserted } = await ledgerFirstCredit(client, {
          userId: snapshot.user_id, txType: 'PRIZE', amount: prizeAmount,
          idempotencyKey: `LEADERBOARD_PRIZE_${snapshot.id}`, provider: 'LEADERBOARD_PRIZE',
          meta: { rank: snapshot.rank, weekStart: snapshot.week_start }
        });

        if (inserted) {
          await client.query(`UPDATE wallets SET bonus_balance = bonus_balance + $1, available_balance = available_balance + $1 WHERE user_id = $2`, [prizeAmount, snapshot.user_id]);
          await client.query(`INSERT INTO bonus_logs (user_id, amount, reason) VALUES ($1, $2, $3)`, [snapshot.user_id, prizeAmount, `Weekly Leaderboard #${snapshot.rank} Prize`]);
        }

        try {
          const weekStartMD = formatMonthDay(snapshot.week_start);
          const accomplishmentStr = `Week of ${weekStartMD}: Ranked #${snapshot.rank} - Awarded ${prizeAmount} ETB`;
          await client.query(`
            UPDATE users
            SET raw_user_meta_data = jsonb_set(
              COALESCE(raw_user_meta_data, '{}'::jsonb),
              '{accomplishments}',
              (COALESCE(raw_user_meta_data->'accomplishments', '[]'::jsonb) || jsonb_build_array($1::text))
            )
            WHERE id = $2
          `, [accomplishmentStr, snapshot.user_id]);
        } catch (err) {
          console.error('[ADMIN APPROVE] accomplishment update failed:', err);
        }
      }

      return snapshot;
    });

    const prizeAmount = Math.round(Number(snap.prize_amount));

    // Send SMS & Notifications outside the critical DB transaction
    if (prizeAmount > 0) {
      // Fetch user's phone number for congratulations SMS
      const { rows: userRows } = await pool.query(`SELECT number FROM users WHERE id = $1`, [snap.user_id]);
      if (userRows.length > 0 && userRows[0].number) {
        const phone = userRows[0].number;
        const { rows: smsRes } = await pool.query(`SELECT value FROM global_settings WHERE key = 'leaderboard_sms_template'`);
        const smsTemplate = smsRes.length > 0 ? smsRes[0].value : '🏆 Congratulations {username}! You ranked #{rank} on the XO ET weekly leaderboard and won {prize} ETB! Your prize has been credited. Keep playing!';
        const smsMsg = smsTemplate
          .replace('{username}', snap.username || '')
          .replace('{rank}', String(snap.rank))
          .replace('{prize}', String(prizeAmount));
        
        await sendSMS(phone, smsMsg).catch(e => console.error('[ADMIN APPROVE SMS ERROR]', e.message));
      }
    }

    const rankLabels = ['🥇 1st Place Champion', '🥈 2nd Place', '🥉 3rd Place'];
    await pool.query(`
      INSERT INTO notifications (user_id, type, title, message, meta)
      VALUES ($1, 'leaderboard_award', $2, $3, $4::jsonb)
    `, [
      snap.user_id,
      rankLabels[snap.rank - 1] || `#${snap.rank} Weekly Award`,
      `🏆 Congratulations! You ranked #${snap.rank} on this week's leaderboard with ${snap.wins} wins and earned ${prizeAmount} ETB! The prize has been added to your balance.`,
      JSON.stringify({
        rank: snap.rank,
        prize: prizeAmount,
        wins: Number(snap.wins),
        weekStart: snap.week_start,
        weekEnd: snap.week_end
      })
    ]).catch(err => console.error('[ADMIN APPROVE] notification insert failed (non-fatal):', err));

    await logAdminAction(req.user.id, 'approved_leaderboard_prize', snap.user_id, { rank: snap.rank, amount: prizeAmount });

    // Emit socket event for real-time update
    try {
      emitToUserEvent(snap.user_id, 'balance_update', {});
      emitToUserEvent(snap.user_id, 'info', {
        title: rankLabels[snap.rank - 1] || `#${snap.rank} Weekly Award`,
        message: `🏆 Congratulations! You ranked #${snap.rank} on this week's leaderboard with ${snap.wins} wins and earned ${prizeAmount} ETB! The prize has been added to your balance.`
      });
    } catch (e) {
      console.error('[ADMIN APPROVE] socket emit failed:', e.message);
    }

    res.json({ ok: true, message: `Prize of ${prizeAmount} ETB awarded and SMS sent to ${snap.username}` });
  } catch (err) {
    console.error('[ADMIN] /leaderboard/approve error:', err);
    res.status(500).json({ error: 'Failed to approve prize' });
  }
});

// POST /admin/leaderboard/approve-all — Approve all pending weekly leaderboard prizes at once
router.post('/leaderboard/approve-all', async (req, res) => {
  try {
    // Select all pending snapshots
    const { rows: pendingSnaps } = await pool.query(
      `SELECT ls.*, u.number FROM leaderboard_snapshots ls JOIN users u ON u.id = ls.user_id WHERE ls.prize_status = 'pending'`
    );

    if (!pendingSnaps.length) {
      return res.status(400).json({ error: 'No pending leaderboard prizes to approve' });
    }

    // Fetch SMS template or use default
    const { rows: smsRes } = await pool.query(`SELECT value FROM global_settings WHERE key = 'leaderboard_sms_template'`);
    const smsTemplate = smsRes.length > 0 ? smsRes[0].value : '🏆 Congratulations {username}! You ranked #{rank} on the XO ET weekly leaderboard and won {prize} ETB! Your prize has been credited. Keep playing!';

    const approvedList = [];

    // Process all pending prizes safely with row-level transaction locks
    for (const snapItem of pendingSnaps) {
      let isApprovedInTx = false;
      const prizeAmount = Math.round(Number(snapItem.prize_amount));

      await withTx(async (client) => {
        // Lock snapshot row FOR UPDATE to verify it hasn't been approved by another concurrent request
        const { rows } = await client.query(`SELECT prize_status FROM leaderboard_snapshots WHERE id = $1 FOR UPDATE`, [snapItem.id]);
        if (!rows.length || rows[0].prize_status === 'approved') return;

        // Mark snapshot as approved IMMEDIATELY inside the transaction lock
        await client.query(`UPDATE leaderboard_snapshots SET prize_status = 'approved' WHERE id = $1`, [snapItem.id]);
        isApprovedInTx = true;

        if (prizeAmount > 0) {
          // Ledger-first: credit only if the LEADERBOARD_PRIZE ledger row inserted
          const { ledgerFirstCredit } = require('../models/ledgerFirstCredit');
          const { inserted } = await ledgerFirstCredit(client, {
            userId: snapItem.user_id, txType: 'PRIZE', amount: prizeAmount,
            idempotencyKey: `LEADERBOARD_PRIZE_${snapItem.id}`, provider: 'LEADERBOARD_PRIZE',
            meta: { rank: snapItem.rank, weekStart: snapItem.week_start }
          });

          if (inserted) {
            await client.query(`UPDATE wallets SET bonus_balance = bonus_balance + $1, available_balance = available_balance + $1 WHERE user_id = $2`, [prizeAmount, snapItem.user_id]);
            await client.query(`INSERT INTO bonus_logs (user_id, amount, reason) VALUES ($1, $2, $3)`, [snapItem.user_id, prizeAmount, `Weekly Leaderboard #${snapItem.rank} Prize`]);
          }
          else {
            console.log(`[ADMIN APPROVE ALL] snapshot ${snapItem.id} prize already awarded (ledger row exists) — skipping credit.`);
          }

          try {
            const weekStartMD = formatMonthDay(snapItem.week_start);
            const accomplishmentStr = `Week of ${weekStartMD}: Ranked #${snapItem.rank} - Awarded ${prizeAmount} ETB`;
            await client.query(`
              UPDATE users
              SET raw_user_meta_data = jsonb_set(
                COALESCE(raw_user_meta_data, '{}'::jsonb),
                '{accomplishments}',
                (COALESCE(raw_user_meta_data->'accomplishments', '[]'::jsonb) || jsonb_build_array($1::text))
              )
              WHERE id = $2
            `, [accomplishmentStr, snapItem.user_id]);
          } catch (err) {
            console.error('[ADMIN APPROVE ALL] accomplishment update failed:', err);
          }
        }
      });

      if (!isApprovedInTx) continue; // Skip SMS/Notifs if another concurrent request already approved this item

      if (prizeAmount > 0 && snapItem.number) {
        const smsMsg = smsTemplate
          .replace('{username}', snapItem.username || '')
          .replace('{rank}', String(snapItem.rank))
          .replace('{prize}', String(prizeAmount));
        
        await sendSMS(snapItem.number, smsMsg).catch(e => console.error('[ADMIN APPROVE-ALL SMS ERROR]', e.message));
      }

      // Send in-app leaderboard award notification
      const rankLabels = ['🥇 1st Place Champion', '🥈 2nd Place', '🥉 3rd Place'];
      await pool.query(`
        INSERT INTO notifications (user_id, type, title, message, meta)
        VALUES ($1, 'leaderboard_award', $2, $3, $4::jsonb)
      `, [
        snapItem.user_id,
        rankLabels[snapItem.rank - 1] || `#${snapItem.rank} Weekly Award`,
        `🏆 Congratulations! You ranked #${snapItem.rank} on this week's leaderboard with ${snapItem.wins} wins and earned ${prizeAmount} ETB! The prize has been added to your balance.`,
        JSON.stringify({
          rank: snapItem.rank,
          prize: prizeAmount,
          wins: Number(snapItem.wins),
          weekStart: snapItem.week_start,
          weekEnd: snapItem.week_end
        })
      ]).catch(err => console.error('[ADMIN APPROVE-ALL] notification insert failed (non-fatal):', err));

      await logAdminAction(req.user.id, 'approved_leaderboard_prize', snapItem.user_id, { rank: snapItem.rank, amount: prizeAmount, bulk: true });

      // Emit socket event for real-time update
      try {
        emitToUserEvent(snapItem.user_id, 'balance_update', {});
        emitToUserEvent(snapItem.user_id, 'info', {
          title: rankLabels[snapItem.rank - 1] || `#${snapItem.rank} Weekly Award`,
          message: `🏆 Congratulations! You ranked #${snapItem.rank} on this week's leaderboard with ${snapItem.wins} wins and earned ${prizeAmount} ETB! The prize has been added to your balance.`
        });
      } catch (e) {
        console.error('[ADMIN APPROVE-ALL] socket emit failed:', e.message);
      }

      approvedList.push({ id: snap.id, username: snap.username, amount: prizeAmount });
    }

    res.json({ ok: true, message: `Successfully approved all ${approvedList.length} pending prizes and sent notifications.`, approved: approvedList });
  } catch (err) {
    console.error('[ADMIN] /leaderboard/approve-all error:', err);
    res.status(500).json({ error: 'Failed to approve all pending prizes' });
  }
});

// ── Fake Ticker CRUD ──
router.get('/leaderboard/fake-ticker', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM fake_ticker_entries ORDER BY id`);
    res.json({ ok: true, entries: rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch fake ticker entries' });
  }
});

router.post('/leaderboard/fake-ticker', async (req, res) => {
  try {
    const { username, amount } = req.body;
    if (!username || !amount) return res.status(400).json({ error: 'username and amount required' });
    const { rows } = await pool.query(
      `INSERT INTO fake_ticker_entries (username, amount) VALUES ($1, $2) RETURNING *`,
      [username, Number(amount)]
    );
    await logAdminAction(req.user.id, 'added_fake_ticker', null, { username, amount });
    res.json({ ok: true, entry: rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to add fake ticker entry' });
  }
});

router.delete('/leaderboard/fake-ticker/:id', async (req, res) => {
  try {
    await pool.query(`DELETE FROM fake_ticker_entries WHERE id = $1`, [req.params.id]);
    await logAdminAction(req.user.id, 'deleted_fake_ticker', null, { entryId: req.params.id });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete fake ticker entry' });
  }
});



// ── Fake Leaderboard Users CRUD ──
router.get('/leaderboard/fake-users', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM fake_leaderboard_entries ORDER BY wins DESC, id ASC');
    res.json({ ok: true, entries: rows });
  } catch (err) {
    console.error('[ADMIN] GET /leaderboard/fake-users error:', err);
    res.status(500).json({ error: 'Failed to fetch fake leaderboard users' });
  }
});

router.post('/leaderboard/fake-users', async (req, res) => {
  try {
    const { username, wins, prize, active } = req.body;
    if (!username) return res.status(400).json({ error: 'username is required' });
    const { rows } = await pool.query(
      `INSERT INTO fake_leaderboard_entries (username, wins, prize, active) 
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [username, Number(wins || 0), Number(prize || 0), active !== false]
    );
    await logAdminAction(req.user.id, 'added_fake_leaderboard_user', null, { username, wins, prize });
    res.json({ ok: true, entry: rows[0] });
  } catch (err) {
    console.error('[ADMIN] POST /leaderboard/fake-users error:', err);
    res.status(500).json({ error: 'Failed to add fake leaderboard user' });
  }
});

router.put('/leaderboard/fake-users/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { username, wins, prize, active } = req.body;
    if (!username) return res.status(400).json({ error: 'username is required' });
    const { rows } = await pool.query(
      `UPDATE fake_leaderboard_entries 
       SET username = $1, wins = $2, prize = $3, active = $4
       WHERE id = $5 RETURNING *`,
      [username, Number(wins || 0), Number(prize || 0), active !== false, id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Fake user not found' });
    await logAdminAction(req.user.id, 'updated_fake_leaderboard_user', null, { id, username, wins, prize });
    res.json({ ok: true, entry: rows[0] });
  } catch (err) {
    console.error('[ADMIN] PUT /leaderboard/fake-users/:id error:', err);
    res.status(500).json({ error: 'Failed to update fake leaderboard user' });
  }
});

router.delete('/leaderboard/fake-users/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query('DELETE FROM fake_leaderboard_entries WHERE id = $1 RETURNING username', [id]);
    if (!rows.length) return res.status(404).json({ error: 'Fake user not found' });
    await logAdminAction(req.user.id, 'deleted_fake_leaderboard_user', null, { id, username: rows[0].username });
    res.json({ ok: true });
  } catch (err) {
    console.error('[ADMIN] DELETE /leaderboard/fake-users/:id error:', err);
    res.status(500).json({ error: 'Failed to delete fake leaderboard user' });
  }
});

// POST /admin/refund — Manual refund issuance
router.post('/refund', async (req, res) => {
  try {
    const { phoneOrUsername, amount, reason, target = 'available' } = req.body;
    if (!phoneOrUsername || !amount) return res.status(400).json({ error: 'phoneOrUsername and amount are required' });
    if (!['available', 'withdrawable', 'both'].includes(target)) {
      return res.status(400).json({ error: 'Invalid target wallet' });
    }
    
    const amountEtb = Math.round(Number(amount)); // Amount in ETB
    if (!Number.isFinite(amountEtb) || amountEtb <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    // Normalize phone: strip non-digits, extract last 9
    const raw = phoneOrUsername.trim();
    const digits = raw.replace(/[^0-9]/g, '');
    const last9 = digits.length >= 9 ? digits.slice(-9) : null;

    let userRes;
    if (last9) {
      userRes = await pool.query(
        `SELECT id, username, number FROM users 
         WHERE RIGHT(REGEXP_REPLACE(number, '[^0-9]', '', 'g'), 9) = $1
            OR username = $2 OR id::text = $2
         LIMIT 1`,
        [last9, raw]
      );
    } else {
      userRes = await pool.query(
        `SELECT id, username, number FROM users 
         WHERE number = $1 OR username = $1 OR id::text = $1
         LIMIT 1`,
        [raw]
      );
    }

    if (!userRes.rows.length) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userRes.rows[0];
    const userId = user.id;

    // Credit user's wallet based on target
    if (target === 'withdrawable') {
      await pool.query(
        `INSERT INTO wallets (user_id, withdrawable_balance) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE 
         SET withdrawable_balance = wallets.withdrawable_balance + EXCLUDED.withdrawable_balance, updated_at = now()`,
        [userId, amountEtb]
      );
    } else if (target === 'both') {
      await pool.query(
        `INSERT INTO wallets (user_id, available_balance, withdrawable_balance) VALUES ($1, $2, $2)
         ON CONFLICT (user_id) DO UPDATE 
         SET available_balance = wallets.available_balance + EXCLUDED.available_balance,
             withdrawable_balance = wallets.withdrawable_balance + EXCLUDED.withdrawable_balance,
             updated_at = now()`,
        [userId, amountEtb]
      );
    } else {
      await pool.query(
        `INSERT INTO wallets (user_id, available_balance) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE 
         SET available_balance = wallets.available_balance + EXCLUDED.available_balance, updated_at = now()`,
        [userId, amountEtb]
      );
    }

    // Insert transaction
    const { rows: txRows } = await pool.query(
      `INSERT INTO wallet_transactions (user_id, tx_type, amount, status, provider, meta, idempotency_key)
       VALUES ($1, 'REFUND', $2, 'COMPLETED', 'ADMIN_REFUND', $3, $4)
       RETURNING *`,
      [
        userId,
        amountEtb,
        JSON.stringify({ 
          reason: reason || 'Manual Admin Refund', 
          adminId: req.user.id,
          targetBalance: target
        }),
        `MANUAL_REFUND_${Date.now()}_${userId.slice(0, 8)}`
      ]
    );

    // Send Notification to user
    await pool.query(
      `INSERT INTO notifications (user_id, type, title, message) 
       VALUES ($1, 'REFUND', 'Refund Processed', $2)`,
      [userId, `A refund of ${amountEtb} ETB has been credited to your account. Reason: ${reason || 'Manual Admin Refund'}`]
    );

    await logAdminAction(req.user.id, 'manual_refund', userId, { amount: amountEtb, reason, target });

    return res.json({ ok: true, message: `Successfully refunded ${amount} ETB to ${user.username}`, transaction: txRows[0] });
  } catch (err) {
    console.error('[ADMIN] POST /refund error:', err);
    res.status(500).json({ error: 'Failed to issue refund: ' + err.message });
  }
});

// ══════════════════════════════════════════════════════════════
// FINANCIAL DASHBOARD — Professional financial tracking
// ══════════════════════════════════════════════════════════════

router.get('/financial-dashboard', async (req, res) => {
  try {
    const range = req.query.range || 'week'; // day, week, month, all
    let interval = '7 days';
    let trunc = 'day';
    let format = 'Mon DD';

    if (range === 'day') { interval = '24 hours'; trunc = 'hour'; format = 'HH24:00'; }
    else if (range === 'month') { interval = '30 days'; trunc = 'day'; format = 'MM/DD'; }
    else if (range === 'all') { interval = '365 days'; trunc = 'week'; format = 'MM/DD'; }

    const [
      walletSumRes, commissionsRes, depositsRes, withdrawalsRes,
      bonusesRes, giveawaysRes, systemRefundsRes, adminRefundsRes,
      depositTimelineRes, withdrawalTimelineRes,
      depositsTodayRes, withdrawalsTodayRes,
      recentBonusesRes, recentGiveawaysRes, recentRefundsRes,
      referralBonusesRes
    ] = await Promise.all([
      // [0] Total platform amount (all user wallets)
      pool.query(`SELECT 
        COALESCE(SUM(available_balance), 0) AS total_available,
        COALESCE(SUM(withdrawable_balance), 0) AS total_withdrawable,
        COALESCE(SUM(bonus_balance), 0) AS total_bonus
      FROM wallets`),
      // [1] Total platform commissions (10% default, 20% for 10 Birr games)
      pool.query(`SELECT 
        COALESCE(SUM(bet_amount * 2 * CASE WHEN bet_amount = 10 THEN 0.2 ELSE 0.1 END), 0) AS total_commissions,
        COUNT(*) AS total_games_finished
      FROM games WHERE status IN ('completed', 'finished', 'X', 'O') AND winner IS NOT NULL`),
      // [2] Total deposits
      pool.query(`SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count
        FROM wallet_transactions WHERE tx_type = 'DEPOSIT' AND status = 'COMPLETED'`),
      // [3] Total withdrawals
      pool.query(`SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count
        FROM wallet_transactions WHERE tx_type IN ('WITHDRAW_SETTLED', 'WITHDRAW_REQUEST') AND status = 'COMPLETED'`),
      // [4] Total bonuses given (welcome + referral from bonus_logs)
      pool.query(`SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count
        FROM bonus_logs WHERE reason NOT ILIKE '%Admin%' AND reason NOT ILIKE '%Leaderboard%'`),
      // [5] Total giveaways (leaderboard prizes)
      pool.query(`SELECT COALESCE(SUM(prize_amount), 0) AS total, COUNT(*) AS count
        FROM leaderboard_snapshots WHERE prize_status = 'approved'`),
      // [6] System refunds (auto-refunds from game errors)
      pool.query(`SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count
        FROM wallet_transactions WHERE tx_type = 'REFUND' AND status = 'COMPLETED' 
        AND (provider != 'ADMIN_REFUND' OR provider IS NULL)`),
      // [7] Admin manual refunds
      pool.query(`SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count
        FROM wallet_transactions WHERE tx_type = 'REFUND' AND status = 'COMPLETED' AND provider = 'ADMIN_REFUND'`),
      // [8] Deposit timeline
      pool.query(`
        WITH points AS (
          SELECT generate_series(
            date_trunc('${trunc}', NOW() - interval '${interval}'),
            date_trunc('${trunc}', NOW()),
            '1 ${trunc}'::interval
          ) AS date
        )
        SELECT 
          to_char(points.date, '${format}') as label,
          points.date as raw_date,
          COALESCE(SUM(CASE WHEN wt.status = 'COMPLETED' THEN wt.amount ELSE 0 END), 0) as amount,
          COUNT(CASE WHEN wt.status = 'COMPLETED' THEN 1 END) as count
        FROM points
        LEFT JOIN wallet_transactions wt 
          ON date_trunc('${trunc}', wt.created_at) = points.date AND wt.tx_type = 'DEPOSIT'
        GROUP BY points.date
        ORDER BY points.date ASC
      `),
      // [9] Withdrawal timeline
      pool.query(`
        WITH points AS (
          SELECT generate_series(
            date_trunc('${trunc}', NOW() - interval '${interval}'),
            date_trunc('${trunc}', NOW()),
            '1 ${trunc}'::interval
          ) AS date
        )
        SELECT 
          to_char(points.date, '${format}') as label,
          points.date as raw_date,
          COALESCE(SUM(CASE WHEN wt.status = 'COMPLETED' THEN wt.amount ELSE 0 END), 0) as amount,
          COUNT(CASE WHEN wt.status = 'COMPLETED' THEN 1 END) as count
        FROM points
        LEFT JOIN wallet_transactions wt 
          ON date_trunc('${trunc}', wt.created_at) = points.date AND wt.tx_type IN ('WITHDRAW_SETTLED', 'WITHDRAW_REQUEST')
        GROUP BY points.date
        ORDER BY points.date ASC
      `),
      // [10] Today deposits
      pool.query(`SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count
        FROM wallet_transactions WHERE tx_type = 'DEPOSIT' AND status = 'COMPLETED' AND created_at >= CURRENT_DATE`),
      // [11] Today withdrawals
      pool.query(`SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count
        FROM wallet_transactions WHERE tx_type IN ('WITHDRAW_SETTLED', 'WITHDRAW_REQUEST') AND status = 'COMPLETED' AND created_at >= CURRENT_DATE`),
      // [12] Recent bonuses
      pool.query(`SELECT bl.*, u.username, u.number 
        FROM bonus_logs bl LEFT JOIN users u ON bl.user_id = u.id 
        ORDER BY bl.created_at DESC LIMIT 20`),
      // [13] Recent giveaways
      pool.query(`SELECT ls.*, u.username 
        FROM leaderboard_snapshots ls LEFT JOIN users u ON ls.user_id = u.id 
        ORDER BY ls.week_start DESC, ls.rank ASC LIMIT 20`),
      // [14] Recent refunds
      pool.query(`SELECT wt.*, u.username, u.number
        FROM wallet_transactions wt LEFT JOIN users u ON wt.user_id = u.id
        WHERE wt.tx_type = 'REFUND' AND wt.status = 'COMPLETED'
        ORDER BY wt.created_at DESC LIMIT 20`),
      // [15] Referral bonuses specifically
      pool.query(`SELECT COALESCE(SUM(bonus_amount), 0) AS total FROM referrals`)
    ]);

    // Chapa balance
    let chapaBalance = 0;
    try {
      const chapaData = await getChapaBalance(CHAPA.secret);
      if (chapaData?.data && Array.isArray(chapaData.data)) {
        const etb = chapaData.data.find(b => b.currency === 'ETB') || chapaData.data[0];
        chapaBalance = Number(etb?.available_balance || etb?.balance || 0);
      }
    } catch (e) { console.warn('[FIN] Chapa fetch failed:', e.message); }

    const totalAvailable = Number(walletSumRes.rows[0].total_available);
    const totalWithdrawable = Number(walletSumRes.rows[0].total_withdrawable);
    const totalBonus = Number(walletSumRes.rows[0].total_bonus);
    const totalPlatformAmount = totalAvailable + totalBonus;
    const totalCommissions = Number(commissionsRes.rows[0].total_commissions);
    const totalGamesFinished = Number(commissionsRes.rows[0].total_games_finished);
    const totalDeposits = Number(depositsRes.rows[0].total);
    const totalWithdrawals = Number(withdrawalsRes.rows[0].total);
    const bonusesGiven = Number(bonusesRes.rows[0].total);
    const giveawaysGiven = Number(giveawaysRes.rows[0].total);
    const systemRefunds = Number(systemRefundsRes.rows[0].total);
    const adminRefunds = Number(adminRefundsRes.rows[0].total);
    const referralBonuses = Number(referralBonusesRes.rows[0].total);

    const purePlatformProfit = totalCommissions;
    const netPlatformProfit = totalCommissions - bonusesGiven - giveawaysGiven - systemRefunds - adminRefunds;

    return res.json({
      ok: true,
      // Summary KPIs
      totalPlatformAmount,
      totalAvailable,
      totalWithdrawable,
      totalBonus,
      chapaBalance,
      purePlatformProfit,
      netPlatformProfit,
      totalCommissions,
      totalGamesFinished,
      // Deposits & Withdrawals
      totalDeposits,
      totalWithdrawals,
      depositsToday: Number(depositsTodayRes.rows[0].total),
      depositCountToday: Number(depositsTodayRes.rows[0].count),
      withdrawalsToday: Number(withdrawalsTodayRes.rows[0].total),
      withdrawalCountToday: Number(withdrawalsTodayRes.rows[0].count),
      // Timelines
      depositTimeline: depositTimelineRes.rows.map(r => ({
        label: r.label, date: r.raw_date, amount: Number(r.amount), count: Number(r.count)
      })),
      withdrawalTimeline: withdrawalTimelineRes.rows.map(r => ({
        label: r.label, date: r.raw_date, amount: Number(r.amount), count: Number(r.count)
      })),
      // Profit impact
      bonusesGiven,
      referralBonuses,
      giveawaysGiven,
      systemRefunds,
      adminRefunds,
      bonusCount: Number(bonusesRes.rows[0].count),
      giveawayCount: Number(giveawaysRes.rows[0].count),
      systemRefundCount: Number(systemRefundsRes.rows[0].count),
      adminRefundCount: Number(adminRefundsRes.rows[0].count),
      // Recent items
      recentBonuses: recentBonusesRes.rows,
      recentGiveaways: recentGiveawaysRes.rows,
      recentRefunds: recentRefundsRes.rows.map(r => ({ ...r, amount: Number(r.amount || 0) })),
    });
  } catch (err) {
    console.error('[ADMIN] /financial-dashboard error', err);
    return res.status(500).json({ error: 'Failed to fetch financial dashboard data' });
  }
});

// Drill-down: per-date user breakdown for deposits or withdrawals
router.get('/financial-dashboard/drill-down', async (req, res) => {
  try {
    const { type, date } = req.query;
    if (!type || !date) return res.status(400).json({ error: 'type and date are required' });

    const txTypes = type === 'withdrawals' ? ['WITHDRAW_SETTLED', 'WITHDRAW_REQUEST'] : ['DEPOSIT'];
    const { rows } = await pool.query(`
      SELECT wt.user_id, u.username, u.number, 
        SUM(wt.amount) AS total_amount, COUNT(*) AS tx_count,
        MAX(wt.created_at) AS last_tx
      FROM wallet_transactions wt
      JOIN users u ON wt.user_id = u.id
      WHERE wt.tx_type = ANY($1) AND wt.status = 'COMPLETED'
        AND wt.created_at >= $2::date AND wt.created_at < ($2::date + interval '1 day')
      GROUP BY wt.user_id, u.username, u.number
      ORDER BY total_amount DESC
      LIMIT 100
    `, [txTypes, date]);

    return res.json({
      ok: true,
      type,
      date,
      users: rows.map(r => ({ ...r, total_amount: Number(r.total_amount), tx_count: Number(r.tx_count) }))
    });
  } catch (err) {
    console.error('[ADMIN] /financial-dashboard/drill-down error', err);
    return res.status(500).json({ error: 'Failed to fetch drill-down data' });
  }
});

// ══════════════════════════════════════════════════════════════
// LEADERBOARD GIVEAWAY CONTROLLER
// ══════════════════════════════════════════════════════════════

router.get('/leaderboard/giveaway-status', async (req, res) => {
  try {
    const { weekStart, weekEnd } = getPrevWeekBounds();
    const weekStartStr = weekStart.toISOString().slice(0, 10);

    // Previous week top winners
    const { rows: winners } = await pool.query(`
      SELECT u.id, u.username, u.number, u.avatar, COUNT(*) AS wins
      FROM games g JOIN users u ON u.id = g.winner
      WHERE g.status IN ('completed', 'finished') AND g.winner IS NOT NULL
        AND g.created_at >= $1 AND g.created_at <= $2
      GROUP BY u.id, u.username, u.number, u.avatar
      ORDER BY wins DESC LIMIT 10
    `, [weekStart.toISOString(), weekEnd.toISOString()]);

    // Check if snapshot already exists
    const { rows: existing } = await pool.query(
      `SELECT * FROM leaderboard_snapshots WHERE week_start = $1 ORDER BY rank ASC`,
      [weekStartStr]
    );

    // Check giveaway SMS history
    const { rows: smsHistory } = await pool.query(`
      SELECT * FROM bulk_sms_history 
      WHERE message ILIKE '%leaderboard%' OR message ILIKE '%giveaway%' OR message ILIKE '%winner%'
      ORDER BY created_at DESC LIMIT 5
    `);

    return res.json({
      ok: true,
      weekStart: weekStart.toISOString(),
      weekEnd: weekEnd.toISOString(),
      winners: winners.map((w, i) => ({ ...w, rank: i + 1, wins: Number(w.wins) })),
      snapshotExists: existing.length > 0,
      snapshots: existing,
      smsHistory
    });
  } catch (err) {
    console.error('[ADMIN] /leaderboard/giveaway-status error:', err);
    res.status(500).json({ error: 'Failed to fetch giveaway status' });
  }
});

router.post('/leaderboard/send-giveaway', async (req, res) => {
  try {
    const { winners, message, dryRun } = req.body;
    // winners = [{ userId, username, phone, rank, prize, wins }]
    if (!winners || !winners.length) return res.status(400).json({ error: 'No winners provided' });

    const defaultMsg = (w) => `🏆 Congratulations ${w.username}! You ranked #${w.rank} on the XO ET weekly leaderboard and won ${w.prize} ETB! Your prize has been credited. Keep playing!`;
    const results = [];

    const { weekStart, weekEnd } = getPrevWeekBounds();
    const weekStartStr = weekStart.toISOString().slice(0, 10);
    const weekEndStr = weekEnd.toISOString().slice(0, 10);

    for (const w of winners) {
      const isDisqualified = !w.userId || w.userId === 'none' || w.userId === 'null';
      const prizeAmount = isDisqualified ? 0 : Math.round(Number(w.prize));
      const winsCount = isDisqualified ? 0 : Number(w.wins || 0);

      const smsMsg = message 
        ? message.replace('{username}', w.username).replace('{rank}', w.rank).replace('{prize}', w.prize) 
        : defaultMsg(w);
      
      if (dryRun) {
        results.push({ userId: w.userId, phone: w.phone, status: 'dry_run', message: smsMsg });
      } else {
        try {
          // Check if snapshot already exists and is already approved
          const { rows: snapRes } = await pool.query(
            `SELECT id, prize_status FROM leaderboard_snapshots WHERE week_start = $1 AND rank = $2`,
            [weekStartStr, w.rank]
          );

          if (snapRes.length > 0 && snapRes[0].prize_status === 'approved') {
            results.push({ userId: w.userId, phone: w.phone, status: 'already_approved', message: smsMsg });
            continue;
          }

          if (isDisqualified) {
            // Update or Create Snapshot as disqualified
            if (snapRes.length > 0) {
              await pool.query(
                `UPDATE leaderboard_snapshots 
                 SET user_id = null, username = 'Disqualified', wins = 0, prize_amount = 0, prize_status = 'disqualified' 
                 WHERE id = $1`,
                [snapRes[0].id]
              );
            } else {
              await pool.query(`
                INSERT INTO leaderboard_snapshots (week_start, week_end, user_id, username, wins, rank, prize_amount, prize_status)
                VALUES ($1, $2, null, 'Disqualified', 0, $3, 0, 'disqualified')
              `, [weekStartStr, weekEndStr, w.rank]);
            }
            results.push({ userId: w.userId, status: 'disqualified', message: 'User marked as Disqualified (None)' });
            continue;
          }

          if (prizeAmount > 0) {
            // 1. Credit wallet (bonus_balance and available_balance)
            await pool.query(
              `UPDATE wallets SET bonus_balance = bonus_balance + $1, available_balance = available_balance + $1 WHERE user_id = $2`,
              [prizeAmount, w.userId]
            );

            // 2. Insert bonus log
            await pool.query(
              `INSERT INTO bonus_logs (user_id, amount, reason) VALUES ($1, $2, $3)`,
              [w.userId, prizeAmount, `Weekly Leaderboard #${w.rank} Prize (Manual)`]
            );

            // 3. Record accomplishment
            try {
              const weekStartMD = formatMonthDay(weekStartStr);
              const accomplishmentStr = `Week of ${weekStartMD}: Ranked #${w.rank} - Awarded ${prizeAmount} ETB`;
              await pool.query(`
                UPDATE users
                SET raw_user_meta_data = jsonb_set(
                  COALESCE(raw_user_meta_data, '{}'::jsonb),
                  '{accomplishments}',
                  (COALESCE(raw_user_meta_data->'accomplishments', '[]'::jsonb) || jsonb_build_array($1::text))
                )
                WHERE id = $2
              `, [accomplishmentStr, w.userId]);
            } catch (err) {
              console.error('[ADMIN GIVEAWAY] accomplishment update failed:', err);
            }

            // 4. Send SMS
            const success = await sendSMS(w.phone, smsMsg).catch(() => false);
            results.push({ userId: w.userId, phone: w.phone, status: success ? 'sent' : 'failed', message: smsMsg });

            // 5. Send in-app leaderboard award notification
            const rankLabels = ['🥇 1st Place Champion', '🥈 2nd Place', '🥉 3rd Place'];

            await pool.query(`
              INSERT INTO notifications (user_id, type, title, message, meta)
              VALUES ($1, 'leaderboard_award', $2, $3, $4::jsonb)
            `, [
              w.userId,
              rankLabels[w.rank - 1] || `#${w.rank} Weekly Award`,
              `🏆 Congratulations! You ranked #${w.rank} on this week's leaderboard with ${winsCount} wins and earned ${prizeAmount} ETB! The prize has been added to your balance.`,
              JSON.stringify({
                rank: w.rank,
                prize: prizeAmount,
                wins: winsCount,
                weekStart: weekStartStr,
                weekEnd: weekEndStr
              })
            ]).catch(err => console.error('[ADMIN GIVEAWAY] notification insert failed:', err));

            // 6. Update or Create Snapshot
            let snapId;
            if (snapRes.length > 0) {
              snapId = snapRes[0].id;
              // Update snapshot status in DB to approved and save the custom prize amount
              await pool.query(
                `UPDATE leaderboard_snapshots SET user_id = $1, username = $2, prize_status = 'approved', prize_amount = $3, wins = $4 WHERE id = $5`,
                [w.userId, w.username, prizeAmount, winsCount, snapId]
              );
            } else {
              // Create a new approved snapshot
              const insertRes = await pool.query(`
                INSERT INTO leaderboard_snapshots (week_start, week_end, user_id, username, wins, rank, prize_amount, prize_status)
                VALUES ($1, $2, $3, $4, $5, $6, $7, 'approved')
                RETURNING id
              `, [weekStartStr, weekEndStr, w.userId, w.username, winsCount, w.rank, prizeAmount]);
              snapId = insertRes.rows[0].id;
            }

            // 7. Log transaction in wallet_transactions
            try {
              await pool.query(
                `INSERT INTO wallet_transactions (user_id, tx_type, amount, status, provider, meta, idempotency_key)
                 VALUES ($1, 'PRIZE', $2, 'COMPLETED', 'LEADERBOARD_PRIZE', $3, $4)
                 ON CONFLICT (user_id, idempotency_key) DO NOTHING`,
                [
                  w.userId,
                  prizeAmount,
                  JSON.stringify({ rank: w.rank, weekStart: weekStartStr }),
                  `LEADERBOARD_PRIZE_${snapId}`
                ]
              );
            } catch (txErr) {
              console.error('[ADMIN GIVEAWAY] wallet_transactions insert failed:', txErr);
            }

            // Emit socket event for balance update
            try {
              emitToUserEvent(w.userId, 'balance_update', {});
              emitToUserEvent(w.userId, 'info', {
                title: rankLabels[w.rank - 1] || `#${w.rank} Weekly Award`,
                message: `🏆 Congratulations! You ranked #${w.rank} on this week's leaderboard with ${winsCount} wins and earned ${prizeAmount} ETB! The prize has been added to your balance.`
              });
            } catch (e) {
              console.error('[ADMIN GIVEAWAY] socket emit failed:', e.message);
            }

          } else {
            results.push({ userId: w.userId, phone: w.phone, status: 'skipped_zero_prize', message: smsMsg });
          }
        } catch (e) {
          results.push({ userId: w.userId, phone: w.phone, status: 'error', error: e.message });
        }
      }
    }

    if (!dryRun) {
      // Log to bulk_sms_history
      await pool.query(`
        INSERT INTO bulk_sms_history (admin_id, message, filters, target_count, success_count)
        VALUES ($1, $2, $3, $4, $5)
      `, [
        req.user.id,
        `Weekly Leaderboard Giveaway SMS`,
        JSON.stringify({ type: 'leaderboard_giveaway', winners: winners.map(w => w.username), dryRun: false }),
        winners.length,
        results.filter(r => r.status === 'sent').length
      ]);

      await logAdminAction(req.user.id, 'sent_leaderboard_giveaway', null, { 
        winnerCount: winners.length, dryRun: false, results 
      });
    }

    return res.json({ ok: true, results, dryRun: !!dryRun });
  } catch (err) {
    console.error('[ADMIN] /leaderboard/send-giveaway error:', err);
    res.status(500).json({ error: 'Failed to send giveaway' });
  }
});

// GET /admin/games/:id/moves
router.get('/games/:id/moves', async (req, res) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(`SELECT moves FROM games WHERE id = $1`, [id]);
    if (!rows.length) {
      return res.status(404).json({ error: 'Game not found' });
    }
    return res.json({ moves: rows[0].moves || [] });
  } catch (err) {
    console.error('[ADMIN] GET /games/:id/moves err', err);
    res.status(500).json({ error: 'Failed to fetch game moves' });
  }
});

// ──────────────────────────────────────────────
// GET /admin/dau-list — Active users today
// ──────────────────────────────────────────────
router.get('/dau-list', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT DISTINCT ON (u.id)
        u.id, u.username, u.number, u.avatar,
        MAX(ue.created_at) AS last_seen
      FROM user_entries ue
      JOIN users u ON u.id = ue.user_id
      WHERE ue.created_at >= CURRENT_DATE
      GROUP BY u.id, u.username, u.number, u.avatar
      ORDER BY u.id, last_seen DESC
    `);
    res.json({ ok: true, dauList: rows, total: rows.length });
  } catch (err) {
    console.error('[ADMIN] GET /dau-list err', err);
    res.status(500).json({ error: 'Failed to fetch DAU list' });
  }
});

function formatMonthDay(dateInput) {
  const date = typeof dateInput === 'string' ? new Date(dateInput + 'T00:00:00Z') : dateInput;
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const month = months[date.getUTCMonth()];
  const day = date.getUTCDate();
  return `${month} ${day}`;
}

// ──────────────────────────────────────────────
// GET /admin/spin/stats — Spin game analytics
// ──────────────────────────────────────────────
router.get('/spin/stats', async (req, res) => {
  try {
    const getStatsForConfig = async (configId) => {
      // 1) Total real-user wagers
      const betsRes = await pool.query(
        `SELECT COALESCE(SUM(sb.amount), 0) AS total_bets 
         FROM spin_bets sb 
         JOIN spin_rounds sr ON sb.round_id = sr.id 
         WHERE sb.is_bot = false AND sr.config_id = $1`,
        [configId]
      );
      const totalBets = Number(betsRes.rows[0].total_bets);

      // 2) Total payouts
      const payoutsRes = await pool.query(
        `SELECT COALESCE(SUM(pt.amount), 0) AS total_payouts 
         FROM payment_transactions pt
         JOIN spin_rounds sr ON (pt.provider_payload->>'roundId')::uuid = sr.id
         WHERE pt.bank = 'SPIN_PRIZE' AND sr.config_id = $1`,
        [configId]
      );
      const totalPayouts = Number(payoutsRes.rows[0].total_payouts);

      // 3) Total refunds
      const refundsRes = await pool.query(
        `SELECT COALESCE(SUM(pt.amount), 0) AS total_refunds 
         FROM payment_transactions pt
         JOIN spin_rounds sr ON (pt.provider_payload->>'roundId')::uuid = sr.id
         WHERE pt.bank = 'SPIN_REFUND' AND sr.config_id = $1`,
        [configId]
      );
      const totalRefunds = Number(refundsRes.rows[0].total_refunds);

      // 4) Unique real players
      const playersRes = await pool.query(
        `SELECT COUNT(DISTINCT sb.user_id) AS unique_players 
         FROM spin_bets sb
         JOIN spin_rounds sr ON sb.round_id = sr.id
         WHERE sb.is_bot = false AND sr.config_id = $1`,
        [configId]
      );
      const uniquePlayers = Number(playersRes.rows[0].unique_players);

      // 5) Rounds breakdown by status
      const roundsRes = await pool.query(
        `SELECT status, COUNT(*) AS count FROM spin_rounds WHERE config_id = $1 GROUP BY status`,
        [configId]
      );
      const roundsBreakdown = {};
      let totalRounds = 0;
      for (const r of roundsRes.rows) {
        roundsBreakdown[r.status] = Number(r.count);
        totalRounds += Number(r.count);
      }

      const netHouseProfit = totalBets - totalPayouts - totalRefunds;

      return {
        totalBets,
        totalPayouts,
        totalRefunds,
        netHouseProfit,
        uniquePlayers,
        totalRounds,
        roundsBreakdown,
      };
    };

    const railStats = await getStatsForConfig(2);
    const fivePlayerStats = await getStatsForConfig(1);

    return res.json({
      ok: true,
      stats: {
        rail: railStats,
        fivePlayer: fivePlayerStats,
      }
    });
  } catch (err) {
    console.error('[ADMIN] GET /spin/stats err', err);
    res.status(500).json({ error: 'Failed to fetch spin analytics' });
  }
});

// ──────────────────────────────────────────────
// GET /admin/spin/live — Active in-memory spin rooms
// ──────────────────────────────────────────────
router.get('/spin/live', async (req, res) => {
  try {
    const { activeSpinRounds } = require('../socket/spinRoom');
    const rooms = Array.from(activeSpinRounds.values()).map(r => ({
      roundId: r.id,
      configId: r.configId,
      mode: r.mode,
      betAmount: r.betAmount,
      maxPlayers: r.maxPlayers,
      roomName: r.roomName,
      status: r.status,
      playersCount: r.players.length,
      realPlayersCount: r.players.filter(p => !p.isBot).length,
      botsCount: r.players.filter(p => p.isBot).length,
      pot: r.players.reduce((sum, p) => sum + Number(p.stake), 0),
      players: r.players.map(p => ({
        username: p.username,
        isBot: p.isBot,
        stake: Number(p.stake),
        seatIndex: p.seatIndex,
      })),
      countdown: r.countdown,
      createdAt: r.createdAt,
    }));
    return res.json({ ok: true, rooms });
  } catch (err) {
    console.error('[ADMIN] GET /spin/live err', err);
    res.status(500).json({ error: 'Failed to fetch live spin rooms' });
  }
});

// ──────────────────────────────────────────────
// GET /admin/spin/history — Paginated completed spin rounds
// ──────────────────────────────────────────────
router.get('/spin/history', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 10, 100);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    const countRes = await pool.query(
      `SELECT COUNT(*) FROM spin_rounds WHERE status IN ('paid', 'cancelled', 'resolved')`
    );
    const total = Number(countRes.rows[0].count);

    const { rows: rounds } = await pool.query(
      `SELECT
        sr.id, sr.config_id, sr.status, sr.winning_slice,
        sr.winner_user_id, sr.pot_amount::numeric AS pot_amount,
        sr.prize_amount::numeric AS prize_amount,
        sr.players AS players_json,
        sr.created_at, sr.resolved_at,
        u.username AS winner_username, u.number AS winner_phone,
        COALESCE(b.total_players, 0)::int AS total_players,
        COALESCE(b.real_players, 0)::int AS real_players
      FROM spin_rounds sr
      LEFT JOIN users u ON u.id = sr.winner_user_id
      LEFT JOIN (
        SELECT round_id,
          COUNT(*) AS total_players,
          COUNT(*) FILTER (WHERE is_bot = false) AS real_players
        FROM spin_bets GROUP BY round_id
      ) b ON b.round_id = sr.id
      WHERE sr.status IN ('paid', 'cancelled', 'resolved')
      ORDER BY sr.created_at DESC
      LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    const enrichedRounds = rounds.map(r => {
      let playersArr = [];
      try {
        playersArr = typeof r.players_json === 'string' ? JSON.parse(r.players_json) : (r.players_json || []);
      } catch (e) {
        playersArr = [];
      }

      const totalP = r.total_players || playersArr.length || 0;
      const realP = r.real_players || playersArr.filter(p => !p.isBot).length || 0;
      const isRealSpin = realP > 0 && realP === totalP;

      let winnerDisplayName = r.winner_username;
      let winnerIsBot = !r.winner_user_id;

      if (!winnerDisplayName && playersArr.length > 0) {
        const sliceIdx = r.winning_slice ?? 0;
        const winnerObj = playersArr[sliceIdx] || playersArr.find(p => p.isBot);
        if (winnerObj) {
          winnerDisplayName = winnerObj.username + (winnerObj.isBot ? ' (Bot)' : '');
          winnerIsBot = !!winnerObj.isBot;
        }
      }

      return {
        ...r,
        winner_display_name: winnerDisplayName || '—',
        winner_is_bot: winnerIsBot,
        is_real_spin: isRealSpin,
        mode_label: r.config_id === 2 ? 'Rail Spin' : '5-Player Spin',
        total_players: totalP,
        real_players: realP,
      };
    });

    return res.json({ ok: true, rounds: enrichedRounds, total, limit, offset });
  } catch (err) {
    console.error('[ADMIN] GET /spin/history err', err);
    res.status(500).json({ error: 'Failed to fetch spin history' });
  }
});

module.exports = router;
