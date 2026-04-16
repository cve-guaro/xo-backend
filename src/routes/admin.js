// routes/admin.js
// Protected admin-only API routes
// All routes require role='admin' in the JWT.

const express = require('express');
const { pool, withTx } = require('../db/index');
const { adminAuth, superAdminAuth } = require('../middleware/Auth');
const { getChapaBalance } = require('../models/Chapa');
const { CHAPA } = require('../env');

const router = express.Router();

// Apply adminAuth to ALL routes in this file
router.use(adminAuth);

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
    const isSimon = req.user.phone_number === '+251961111106' || req.user.role === 'superadmin';
    if (!isSimon) {
      return res.status(403).json({ error: 'Permission denied: Only Super Admin can modify security protocols.' });
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
    const [usersRes, revenueRes, payoutsRes, pendingRes, metricsRes, graphRes, earningsRes, activeGamesRes, failedWdRes] = await Promise.all([
      // [0] Total users
      pool.query(`SELECT COUNT(*) AS total_users FROM users WHERE banned = false`),
      // [1] Total completed deposits (money that came in via Chapa)
      pool.query(`SELECT COALESCE(SUM(amount), 0) AS total_revenue
                  FROM wallet_transactions WHERE tx_type = 'DEPOSIT' AND status = 'COMPLETED'`),
      // [2] Total settled withdrawals
      pool.query(`SELECT COALESCE(SUM(amount), 0) AS total_payouts
                  FROM wallet_transactions WHERE tx_type = 'WITHDRAW_SETTLED' AND status = 'COMPLETED'`),
      // [3] Pending withdrawal amount
      pool.query(`SELECT COALESCE(SUM(amount), 0) AS pending_amount
                   FROM wallet_transactions WHERE tx_type = 'WITHDRAW_REQUEST' AND status = 'PENDING'`),
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
      pool.query(`SELECT COUNT(*) as failed_withdrawals FROM wallet_transactions WHERE tx_type IN ('WITHDRAW_REQUEST', 'WITHDRAW_SETTLED') AND status = 'FAILED'`)
    ]);

    const revenue = Number(revenueRes.rows[0].total_revenue);
    const payouts = Number(payoutsRes.rows[0].total_payouts);
    const pending = Number(pendingRes.rows[0].pending_amount);
    const volume24h = Number(metricsRes.rows[0].volume);
    const successRate = Number(metricsRes.rows[0].success_rate) || 0;
    const platformCommission = Number(earningsRes.rows[0].platform_commission);

    let realChapaBalance = revenue - payouts;
    try {
      const chapaBalances = await getChapaBalance(CHAPA.secret);
      if (chapaBalances && chapaBalances.data && Array.isArray(chapaBalances.data)) {
        const etbBalance = chapaBalances.data.find((b) => b.currency === 'ETB') || chapaBalances.data[0];
        if (etbBalance) {
          // Send back the actual available balance from Chapa
          realChapaBalance = Number(etbBalance.available_balance || etbBalance.balance || 0);
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
      pendingWithdrawalAmount: pending,
      volume24h,
      successRate,
      activeGames: Number(activeGamesRes.rows[0].active_games),
      failedWithdrawals: Number(failedWdRes.rows[0].failed_withdrawals),
      graphData: (graphRes.rows || []).map(r => ({
        date: r.label,
        profit: Number(r.profit)
      }))
    });
  } catch (err) {
    console.error('[ADMIN] /dashboard-data error', err);
    return res.status(500).json({ error: 'Failed to fetch dashboard data' });
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
    const { limit = 100, offset = 0, search = '', role = 'all', status = 'all' } = req.query;
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
    return res.json({
      ...user,
      available_balance: Number(user.available_balance || 0),
      withdrawable_balance: Number(user.withdrawable_balance || 0),
      bonus_balance: Number(user.bonus_balance || 0)
    });
  } catch (err) {
    console.error('[ADMIN] /users/:id error', err);
    return res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// ──────────────────────────────────────────────
// PATCH /admin/users/:id
// Full user profile edit
// ──────────────────────────────────────────────
router.patch('/users/:id', async (req, res) => {
  try {
    const { username, number, role, available_balance, bonus_balance } = req.body;
    
    // Process User details
    await pool.query(
      `UPDATE users SET username = $1, number = $2, role = $3 WHERE id = $4`,
      [username, number, role, req.params.id]
    );

    // Process balances (store as whole ETB since migration)
    let availableCents = Math.round(Number(available_balance || 0));
    let bonusCents = Math.round(Number(bonus_balance || 0));

    // Ensure wallet exists
    await pool.query(`INSERT INTO wallets (user_id) VALUES ($1) ON CONFLICT DO NOTHING`, [req.params.id]);

    await pool.query(
      `UPDATE wallets SET available_balance = $1, bonus_balance = $2 WHERE user_id = $3`,
      [availableCents, bonusCents, req.params.id]
    );

    // Logging
    await logAdminAction(req.user.id, 'edit_user_profile', req.params.id, { username, number, role, available_balance, bonus_balance });

    return res.json({ ok: true });
  } catch (err) {
    console.error('[ADMIN] /users/:id patch error', err);
    return res.status(500).json({ error: 'Failed to fully update user' });
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
    if (!['user', 'admin'].includes(targetRole)) {
      return res.status(400).json({ error: 'Invalid role assignment' });
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

// ──────────────────────────────────────────────
// PATCH /admin/users/:id
// Full CRUD functionality for Admin user updates
// ──────────────────────────────────────────────
router.patch('/users/:id', async (req, res) => {
  try {
    const { username, number, role, available_balance, bonus_balance, banned } = req.body;
    
    // Authorization check for sensitive fields
    const isSimon = req.user.phone_number === '+251961111106' || req.user.role === 'superadmin';
    if ((role !== undefined || available_balance !== undefined || bonus_balance !== undefined) && !isSimon) {
      return res.status(403).json({ error: 'Permission denied: Only Super Admin can modify roles or wallet balances.' });
    }

    await withTx(async (client) => {
      // 1. Update user profile
      const userUpdates = [];
      const userParams = [];
      let uIdx = 1;
      
      if (username !== undefined) { userUpdates.push(`username = $${uIdx++}`); userParams.push(username); }
      if (number !== undefined) { userUpdates.push(`number = $${uIdx++}`); userParams.push(number); }
      if (role !== undefined) { userUpdates.push(`role = $${uIdx++}`); userParams.push(role); }
      if (banned !== undefined) { userUpdates.push(`banned = $${uIdx++}`); userParams.push(banned); }
      
      let userRes;
      if (userUpdates.length > 0) {
        userParams.push(req.params.id);
        const q = `UPDATE users SET ${userUpdates.join(', ')} WHERE id = $${uIdx} RETURNING *`;
        userRes = await client.query(q, userParams);
        if (!userRes.rows.length) throw new Error("User not found");
      }

      // 2. Update wallet balances
      const walletUpdates = [];
      const walletParams = [];
      let wIdx = 1;

      if (available_balance !== undefined) { walletUpdates.push(`available_balance = $${wIdx++}`); walletParams.push(Math.round(Number(available_balance))); }
      if (bonus_balance !== undefined) { walletUpdates.push(`bonus_balance = $${wIdx++}`); walletParams.push(Math.round(Number(bonus_balance))); }
      
      let walletRes;
      if (walletUpdates.length > 0) {
        walletParams.push(req.params.id);
        const q2 = `UPDATE wallets SET ${walletUpdates.join(', ')} WHERE user_id = $${wIdx} RETURNING *`;
        walletRes = await client.query(q2, walletParams);
      }

      await logAdminAction(req.user.id, 'updated_user_profile', req.params.id, { username, role, balance: available_balance, bonus: bonus_balance });

      res.json({ ok: true, user: userRes?.rows?.[0], wallet: walletRes?.rows?.[0] });
    });
  } catch (err) {
    if (err.message === "User not found") return res.status(404).json({ error: err.message });
    console.error('[ADMIN] /users/:id err', err);
    res.status(500).json({ error: "Failed to update user profile." });
  }
});

// ──────────────────────────────────────────────
// POST /admin/users
// Manually create a user and initial wallet
// ──────────────────────────────────────────────
router.post('/users', async (req, res) => {
  try {
    const { username, number, role, balance } = req.body;
    if (!username || !number) return res.status(400).json({ error: "Username and Number are required." });

    if (role && role !== 'user' && !['admin', 'superadmin'].includes(req.user.role)) {
      return res.status(403).json({ error: "Insufficient permissions to create administrative accounts." });
    }

    const newUser = await withTx(async (client) => {
      // 1. Create User
      const userRes = await client.query(
        `INSERT INTO users (username, number, role) VALUES ($1, $2, $3) RETURNING *`,
        [username, number, role || 'user']
      );
      const user = userRes.rows[0];

      // 2. Initialize Wallet
      const balCents = Math.round(Number(balance || 0));
      await client.query(
        `INSERT INTO wallets (user_id, available_balance, bonus_balance) VALUES ($1, $2, $3)`,
        [user.id, balCents, 0]
      );

      await logAdminAction(req.user.id, 'created_user_manual', user.id, { username, role, balance });
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
    if (!['admin', 'superadmin'].includes(req.user.role)) {
      return res.status(403).json({ error: "Insufficient permissions to delete accounts." });
    }

    await withTx(async (client) => {
      // Order is important for foreign keys
      await client.query(`DELETE FROM games WHERE player_x = $1 OR player_o = $1 OR winner = $1`, [req.params.id]);
      await client.query(`DELETE FROM wallet_transactions WHERE user_id = $1`, [req.params.id]);
      await client.query(`DELETE FROM bonus_logs WHERE user_id = $1`, [req.params.id]);
      await client.query(`DELETE FROM wallets WHERE user_id = $1`, [req.params.id]);
      await client.query(`DELETE FROM users WHERE id = $1`, [req.params.id]);
      await logAdminAction(req.user.id, 'deleted_user_permanent', req.params.id, {});
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('[ADMIN] DELETE /users/:id err', err);
    res.status(500).json({ error: "Failed to delete user account." });
  }
});

// ──────────────────────────────────────────────
// GET /admin/users/:id/360
// Aggregates history and transactions
// ──────────────────────────────────────────────
router.get('/users/:id/360', async (req, res) => {
  try {
    const userId = req.params.id;
    const statsQuery = `
      SELECT 
        COUNT(*) FILTER (WHERE winner = $1::uuid) as wins,
        COUNT(*) FILTER (WHERE winner IS NOT NULL AND winner != $1::uuid) as losses,
        COUNT(*) as total_games
      FROM games 
      WHERE (player_x = $1::uuid OR player_o = $1::uuid)
        AND status NOT IN ('ongoing', 'live')
    `;
    const txQuery = `
      SELECT id, tx_type as type, amount, status, provider as bank, provider_ref as tx_ref, created_at FROM wallet_transactions 
      WHERE user_id = $1 AND (provider IS NULL OR provider != 'PRIZE')
      ORDER BY created_at DESC LIMIT 50
    `;
    const gamesQuery = `
      SELECT id, status, winner, bet_amount, created_at
      FROM games
      WHERE player_x = $1 OR player_o = $1
      ORDER BY created_at DESC LIMIT 50
    `;

    const [statsRes, txsRes, gamesRes] = await Promise.all([
      pool.query(statsQuery, [userId]),
      pool.query(txQuery, [userId]),
      pool.query(gamesQuery, [userId])
    ]);

    return res.json({ 
      ok: true, 
      games: {
        wins: Number(statsRes.rows[0].wins || 0),
        losses: Number(statsRes.rows[0].losses || 0),
        total: Number(statsRes.rows[0].total_games || 0)
      },
      txs: txsRes.rows,
      recent_games: gamesRes.rows
    });
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch 360 data." });
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

      if (txn.status !== 'PENDING') {
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

      if (txn.status !== 'PENDING') {
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
      ORDER BY g.created_at DESC
      LIMIT $1 OFFSET $2
    `, [limit, offset]);

    const formatted = rows.map(r => ({
      ...r,
      bet_amount: Number(r.bet_amount || 0)
    }));

    const countRes = await pool.query(`SELECT COUNT(*) FROM games`);
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
    const { rows } = await pool.query(`
      SELECT c.*, u.username, u.number
      FROM giveaway_claims c
      JOIN users u ON c.user_id = u.id
      WHERE c.giveaway_id = $1
      ORDER BY c.claimed_at DESC
    `, [req.params.id]);
    return res.json({ ok: true, claims: rows });
  } catch (err) {
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

module.exports = router;
