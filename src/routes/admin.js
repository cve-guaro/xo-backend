// routes/admin.js
// Protected admin-only API routes
// All routes require role='admin' in the JWT.

const express = require('express');
const axios = require("axios");
const crypto = require("crypto");
const Redis = require('ioredis');
const { pool, withTx } = require('../db/index');
const { adminAuth, superAdminAuth } = require('../middleware/Auth');
const { getChapaBalance } = require('../models/Chapa');
const { CHAPA } = require('../env');
const { sendSMS } = require('../utils/sms');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379');
const router = express.Router();

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
    
    // Store in Redis (expires in 5 minutes)
    await redis.setex(`admin_2fa:${req.user.id}`, 300, code);

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

    const storedCode = await redis.get(`admin_2fa:${req.user.id}`);
    if (!storedCode) return res.status(400).json({ error: 'OTP expired or not requested' });
    
    if (String(code) !== storedCode) {
      // Allow superadmin bypass
      if (req.user.role === 'superadmin' && String(code) === '4444') {
        // bypass allowed
      } else {
        return res.status(400).json({ error: 'Invalid verification code' });
      }
    }

    // Clear OTP
    await redis.del(`admin_2fa:${req.user.id}`);

    // Set unlocking state in Redis (valid for 2 hours)
    await redis.setex(`admin_unlocked:${req.user.id}`, 7200, "true");
    
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
              WHEN tx_type IN ('DEPOSIT', 'PRIZE', 'GIFT', 'REFUND') AND status IN ('COMPLETED', 'success') THEN amount
              WHEN tx_type IN ('WITHDRAW_REQUEST', 'WITHDRAW_SETTLED', 'STAKE') AND status IN ('COMPLETED', 'success', 'PENDING', 'PENDING_MANUAL') THEN -amount
              ELSE 0
            END
          ) AS calculated_net_balance
        FROM wallet_transactions
        GROUP BY user_id
      ),
      wallets_live AS (
        SELECT 
          user_id,
          (COALESCE(available_balance, 0) + COALESCE(withdrawable_balance, 0) + COALESCE(bonus_balance, 0)) AS current_total_balance
        FROM wallets
      )
      SELECT 
        w.user_id,
        u.phone_number,
        COALESCE(l.calculated_net_balance, 0) AS derived_history_balance,
        w.current_total_balance AS live_wallet_balance,
        (w.current_total_balance - COALESCE(l.calculated_net_balance, 0)) AS discrepancy
      FROM wallets_live w
      LEFT JOIN ledger l ON w.user_id = l.user_id
      LEFT JOIN users u ON w.user_id = u.id
      WHERE (w.current_total_balance - COALESCE(l.calculated_net_balance, 0)) != 0
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
  const restrictedKeys = ['system_emergency_lockout', 'mobile_app_lockout', 'maintenance_mode', 'security_autoban'];
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
// GET /admin/stats
// Overview KPI numbers
// ──────────────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const [usersRes, gamesRes, pendingRes, revenueRes, payoutsRes, giveawayRes, walletSumRes] = await Promise.all([
      pool.query(`SELECT COUNT(*) AS total_users FROM users WHERE banned = false`),
      pool.query(`SELECT COUNT(*) AS active_games FROM games WHERE status = 'ongoing'`),
      pool.query(`SELECT COUNT(*) AS pending_withdrawals, COALESCE(SUM(amount), 0) AS pending_amount
                  FROM wallet_transactions WHERE tx_type = 'WITHDRAW_REQUEST' AND status = 'PENDING'`),
      pool.query(`SELECT COALESCE(SUM(amount), 0) AS total_deposits
                  FROM wallet_transactions WHERE tx_type = 'DEPOSIT' AND status = 'COMPLETED'`),
      pool.query(`SELECT COALESCE(SUM(amount), 0) AS total_withdrawals
                  FROM wallet_transactions WHERE tx_type = 'WITHDRAW_SETTLED' AND status = 'COMPLETED'`),
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
                  FROM wallet_transactions WHERE tx_type = 'WITHDRAW_SETTLED' AND status = 'COMPLETED'`),
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
          COALESCE(SUM(CASE WHEN pt.tx_type IN ('WITHDRAW_SETTLED') AND pt.status = 'COMPLETED' THEN pt.amount ELSE 0 END), 0) as profit
        FROM points
        LEFT JOIN wallet_transactions pt 
          ON date_trunc('${trunc}', pt.created_at) = points.date
        GROUP BY points.date
        ORDER BY points.date ASC
      `),
      // [6] Platform earnings from game commissions (10% of each completed bet)
      pool.query(`
        SELECT COALESCE(SUM(bet_amount * 0.1), 0) AS platform_commission
        FROM games
        WHERE status = 'finished' AND winner IS NOT NULL
      `),
      // [7] Active Games
      pool.query(`SELECT COUNT(*) as active_games FROM games WHERE status IN ('ongoing', 'live')`),
      // [8] Failed withdrawals (Count any withdrawal tx that didn't succeed)
      pool.query(`SELECT COUNT(*) as failed_withdrawals FROM wallet_transactions WHERE tx_type IN ('WITHDRAW_REQUEST', 'WITHDRAW_SETTLED') AND status = 'FAILED'`),
      // [9] New user growth time-series
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
          COUNT(u.id) as count
        FROM points
        LEFT JOIN users u ON date_trunc('${trunc}', u.created_at) = points.date
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
        count: Number(r.count)
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
        SUM(CASE WHEN tx_type = 'WITHDRAW_SETTLED' AND status = 'COMPLETED' THEN amount ELSE 0 END) as profit
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

      whereClauses.push(`(
        u.username ILIKE $${paramIdx} 
        OR u.display_name ILIKE $${paramIdx} 
        OR u.role ILIKE $${paramIdx}
        OR u.number ILIKE $${paramIdx}
        OR REGEXP_REPLACE(u.number, '[^0-9]', '', 'g') ILIKE $${paramIdx+1}
        OR RIGHT(REGEXP_REPLACE(u.number, '[^0-9]', '', 'g'), 9) ILIKE $${paramIdx+2}
        OR CAST(u.id AS TEXT) ILIKE $${paramIdx}
        OR CAST(w.available_balance AS TEXT) ILIKE $${paramIdx}
      )`);
      queryParams.push(likePat, normLike || likePat, tail9Like || likePat);
      paramIdx += 3;
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
             u.role, u.banned, u.room_1_wins, u.r1_10_wins, u.r1_25_wins, u.r1_50_wins, u.r1_99_wins, u.created_at,
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
             u.role, u.banned, u.room_1_wins, u.r1_10_wins, u.r1_25_wins, u.r1_50_wins, u.r1_99_wins, u.created_at,
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
              COALESCE(r1_10_wins, 0) as r1_10_wins, COALESCE(r1_25_wins, 0) as r1_25_wins,
              COALESCE(r1_50_wins, 0) as r1_50_wins, COALESCE(r1_99_wins, 0) as r1_99_wins
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
          SUM(CASE WHEN winner = $1 THEN 1 ELSE 0 END) as wins,
          SUM(CASE WHEN winner IS NOT NULL AND winner != $1 THEN 1 ELSE 0 END) as losses,
          SUM(CASE WHEN winner IS NULL AND status = 'completed' THEN 1 ELSE 0 END) as draws
        FROM games WHERE (player_x = $1 OR player_o = $1) AND status = 'completed'
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

    // 4) Game history (last 50)
    let games = [];
    try {
      const gamesRes = await pool.query(`
        SELECT g.id, g.player_x, g.player_o, g.winner, g.bet_amount, g.status,
               g.finished_at, g.created_at,
               ux.username as player_x_name, uo.username as player_o_name
        FROM games g
        LEFT JOIN users ux ON g.player_x = ux.id
        LEFT JOIN users uo ON g.player_o = uo.id
        WHERE (g.player_x = $1 OR g.player_o = $1)
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
          COALESCE(SUM(CASE WHEN tx_type = 'WITHDRAW_SETTLED' AND status = 'COMPLETED' THEN amount ELSE 0 END), 0) as total_withdrawn
        FROM wallet_transactions WHERE user_id = $1
      `, [userId]);
      if (totalsRes.rows.length) {
        totals = {
          totalDeposited: Number(totalsRes.rows[0].total_deposited || 0),
          totalWithdrawn: Number(totalsRes.rows[0].total_withdrawn || 0),
        };
      }
    } catch (e) { console.warn('[360] totals query failed:', e.message); }

    return res.json({ user, wallet, stats, games, transactions, totals });
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
      if (mappedType === 'WITHDRAWAL') mappedType = 'WITHDRAW_REQUEST';
      conditions.push(`pt.tx_type = $${idx++}`); 
      params.push(mappedType); 
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
        SUM(CASE WHEN tx_type::text = 'WITHDRAW_SETTLED' AND status = 'COMPLETED' THEN amount ELSE 0 END) as total_withdraw
      FROM wallet_transactions 
      WHERE user_id = $1
    `, [details.user_id]);
    
    const aggregates = statsQuery.rows[0];

    return res.json({
      transaction: details,
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
// For withdrawals: refund balance
// ──────────────────────────────────────────────
router.patch('/transactions/:id/reject', async (req, res) => {
  try {
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
        g.id, g.bet_amount, g.status, g.created_at, g.finished_at, g.moves,
        g.winner    AS winner_id,
        g.player_x  AS player_x_id,
        g.player_o  AS player_o_id,
        px.username AS player_x_name, px.number AS player_x_number,
        po.username AS player_o_name, po.number AS player_o_number
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
    const { rows } = await pool.query("SELECT key, value FROM global_settings WHERE key LIKE 'feature_%' OR key IN ('system_emergency_lockout', 'lockdown_whitelist')");
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
    const { rows } = await pool.query("SELECT value FROM global_settings WHERE key = 'promo_popup_config'");
    const config = rows.length > 0 ? rows[0].value : { image_url: '', display_duration: 5, expires_at: null, is_active: false };
    res.json({ ok: true, config });
  } catch (err) {
    console.error('[ADMIN] GET /promo-popup err', err);
    res.status(500).json({ error: 'Failed to fetch promo popup config' });
  }
});

router.post('/promo-popup', async (req, res) => {
  try {
    const { image_url, display_duration, expires_at, is_active } = req.body;
    const config = { image_url, display_duration, expires_at, is_active };
    await pool.query(`
      INSERT INTO global_settings (key, value)
      VALUES ('promo_popup_config', $1::jsonb)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `, [JSON.stringify(config)]);
    res.json({ ok: true, config });
  } catch (err) {
    console.error('[ADMIN] POST /promo-popup err', err);
    res.status(500).json({ error: 'Failed to save promo popup config' });
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
        const success = await sendSMS(user.number, message).catch(() => false);
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

module.exports = router;
