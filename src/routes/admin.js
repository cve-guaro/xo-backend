// routes/admin.js
// Protected admin-only API routes
// All routes require role='admin' in the JWT.

const express = require('express');
const { pool, withTx } = require('../db/index');
const { adminAuth } = require('../middleware/Auth');

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
  if (req.user.role !== 'superadmin') return res.status(403).json({ error: 'Only Super Administrators can modify global settings' });
  try {
    const updates = req.body; // e.g., { welcome_bonus_active: true, welcome_bonus_amount: 1000 }
    for (const [key, value] of Object.entries(updates)) {
      await pool.query(`
        INSERT INTO global_settings (key, value) VALUES ($1, $2::jsonb)
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
      `, [key, JSON.stringify(value)]);
    }
    await logAdminAction(req.user.id, 'updated_global_settings', null, updates);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to update settings' });
  }
});

// ──────────────────────────────────────────────
// GET /admin/audit-logs
// ──────────────────────────────────────────────
router.get('/audit-logs', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT l.*, u.username as admin_name 
      FROM admin_audit_logs l
      LEFT JOIN users u ON l.admin_id = u.id
      ORDER BY l.created_at DESC LIMIT 10
    `);
    return res.json({ ok: true, logs: rows });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch audit logs' });
  }
});
// GET /admin/stats
// Overview KPI numbers
// ──────────────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const [usersRes, gamesRes, pendingRes, revenueRes] = await Promise.all([
      pool.query(`SELECT COUNT(*) AS total_users FROM users WHERE banned = false`),
      pool.query(`SELECT COUNT(*) AS active_games FROM games WHERE status = 'ongoing'`),
      pool.query(`SELECT COUNT(*) AS pending_withdrawals, COALESCE(SUM(amount), 0) AS pending_amount
                  FROM payment_transactions WHERE type = 'withdrawal' AND status = 'pending'`),
      pool.query(`SELECT COALESCE(SUM(amount), 0) AS total_deposits
                  FROM payment_transactions WHERE type = 'deposit' AND status = 'success'`),
    ]);

    return res.json({
      totalUsers: Number(usersRes.rows[0].total_users),
      activeGames: Number(gamesRes.rows[0].active_games),
      pendingWithdrawals: Number(pendingRes.rows[0].pending_withdrawals),
      pendingWithdrawalAmount: Number(pendingRes.rows[0].pending_amount),
      totalDeposits: Number(revenueRes.rows[0].total_deposits),
    });
  } catch (err) {
    console.error('[ADMIN] /stats error', err);
    return res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// ──────────────────────────────────────────────
// GET /admin/metrics/recent
// Grabs 7 recent users and 7 recent transactions
// ──────────────────────────────────────────────
router.get('/metrics/recent', async (req, res) => {
  try {
    const usersRes = await pool.query(`SELECT id, username, number, available_balance, banned, created_at, role FROM users ORDER BY created_at DESC LIMIT 7`);
    const txsRes = await pool.query(`
      SELECT pt.*, u.username as username, u.number as number
      FROM payment_transactions pt
      LEFT JOIN users u ON pt.user_id = u.id
      ORDER BY pt.created_at DESC LIMIT 7
    `);
    return res.json({ ok: true, users: usersRes.rows, transactions: txsRes.rows });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch recent metrics' });
  }
});

// ──────────────────────────────────────────────
// GET /admin/users?search=&limit=&offset=
// Searchable paginated user list
// ──────────────────────────────────────────────
router.get('/users', async (req, res) => {
  try {
    const limit  = Math.min(Number(req.query.limit  || 200), 500);
    const offset = Number(req.query.offset || 0);

    // Normalize the raw search term: strip +, spaces, dashes, parens
    const rawSearch = (req.query.search || '').toString().trim();
    // Normalized: digits only (for phone comparison)
    const normSearch = rawSearch.replace(/[\s\-\+\(\)]/g, '');
    // Strip Ethiopian country code prefix for a simpler 9-digit tail match
    const tail9 = normSearch.replace(/^251/, '').replace(/^0/, '');

    let query, params;
    if (rawSearch) {
      const likePat     = `%${rawSearch}%`;
      const normLike    = normSearch ? `%${normSearch}%` : null;
      const tail9Like   = tail9     ? `%${tail9}%`     : null;

      query = `
        SELECT u.id, u.number, u.username, u.display_name, u.avatar,
               u.role, u.banned, u.room_1_wins, u.r1_10_wins, u.r1_25_wins, u.r1_50_wins, u.r1_99_wins, u.created_at,
               COALESCE(w.available_balance, 0)    AS available_balance,
               COALESCE(w.withdrawable_balance, 0) AS withdrawable_balance,
               COALESCE(w.bonus_balance, 0)        AS bonus_balance
        FROM users u
        LEFT JOIN wallets w ON w.user_id = u.id
        WHERE
          -- username / display_name freetext
          u.username     ILIKE $1
          OR u.display_name ILIKE $1
          -- raw phone match
          OR u.number    ILIKE $1
          -- normalized digits match (strips +/spaces from stored number)
          OR REGEXP_REPLACE(u.number, '[^0-9]', '', 'g') ILIKE $2
          -- last-9-digits tail match (handles 0961… vs 961… vs 251961…)
          OR RIGHT(REGEXP_REPLACE(u.number, '[^0-9]', '', 'g'), 9) ILIKE $3
          -- ID prefix
          OR CAST(u.id AS TEXT) ILIKE $1
        ORDER BY u.created_at DESC
        LIMIT $4 OFFSET $5
      `;
      params = [
        likePat,
        normLike   || likePat,
        tail9Like  || likePat,
        limit,
        offset,
      ];
    } else {
      query = `
        SELECT u.id, u.number, u.username, u.display_name, u.avatar,
               u.role, u.banned, u.room_1_wins, u.r1_10_wins, u.r1_25_wins, u.r1_50_wins, u.r1_99_wins, u.created_at,
               COALESCE(w.available_balance, 0)    AS available_balance,
               COALESCE(w.withdrawable_balance, 0) AS withdrawable_balance,
               COALESCE(w.bonus_balance, 0)        AS bonus_balance
        FROM users u
        LEFT JOIN wallets w ON w.user_id = u.id
        ORDER BY u.created_at DESC
        LIMIT $1 OFFSET $2
      `;
      params = [limit, offset];
    }

    const { rows } = await pool.query(query, params);
    const countRes = await pool.query(`SELECT COUNT(*) FROM users`);

    return res.json({ users: rows, total: Number(countRes.rows[0].count), limit, offset });
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
    return res.json(rows[0]);
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

    // Process balances (parse to floats -> multiply by 100 for cents -> ensure integer)
    let availableCents = Math.round(Number(available_balance || 0));
    // Wait, the UI ALREADY sends `editData.available_balance` as literally "9000".
    // If the frontend text input takes "9000", it means 9000 ETB. So I must multiply by 100.
    availableCents = Math.round(Number(available_balance || 0) * 100);
    let bonusCents = Math.round(Number(bonus_balance || 0) * 100);

    // Ensure wallet exists
    await pool.query(`INSERT INTO wallets (user_id) VALUES ($1) ON CONFLICT DO NOTHING`, [req.params.id]);

    await pool.query(
      `UPDATE wallets SET available_balance = $1, bonus_balance = $2 WHERE user_id = $3`,
      [availableCents, bonusCents, req.params.id]
    );

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
router.patch('/users/:id/balance', async (req, res) => {
  try {
    const { field, amount } = req.body;
    if (!['available_balance', 'bonus_balance', 'withdrawable_balance'].includes(field)) {
      return res.status(400).json({ error: 'Invalid field. Must be available_balance, bonus_balance, or withdrawable_balance' });
    }
    const amountCents = Math.round(Number(amount) * 100);
    if (!Number.isFinite(amountCents) || amountCents < 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    // Ensure wallet row exists
    await pool.query(`INSERT INTO wallets (user_id) VALUES ($1) ON CONFLICT DO NOTHING`, [req.params.id]);

    const { rows } = await pool.query(
      `UPDATE wallets SET ${field} = $1 WHERE user_id = $2 RETURNING *`,
      [amountCents, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
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
router.patch('/users/:id/role', async (req, res) => {
  try {
    if (req.user.role !== 'superadmin') {
      return res.status(403).json({ error: 'Only Super Administrators can modify roles' });
    }
    const targetRole = req.body.role;
    if (!['user', 'admin'].includes(targetRole)) {
      return res.status(400).json({ error: 'Invalid role assignment' });
    }
    const { rows } = await pool.query(
      `UPDATE users SET role = $1 WHERE id = $2 RETURNING id, username, role`,
      [targetRole, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
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
    
    // Authorization check for structural edits
    if (role && req.user.role !== 'superadmin') {
      return res.status(403).json({ error: 'Only Super Administrators can modify roles.' });
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

      if (available_balance !== undefined) { walletUpdates.push(`available_balance = $${wIdx++}`); walletParams.push(Math.round(Number(available_balance) * 100)); } // Assume parsed ETH logic provided
      if (bonus_balance !== undefined) { walletUpdates.push(`bonus_balance = $${wIdx++}`); walletParams.push(Math.round(Number(bonus_balance) * 100)); }
      
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
// GET /admin/users/:id/360
// Aggregates history and transactions
// ──────────────────────────────────────────────
router.get('/users/:id/360', async (req, res) => {
  try {
    const userId = req.params.id;
    const statsQuery = `
      SELECT 
        COUNT(*) FILTER (WHERE winner = $1) as wins,
        COUNT(*) FILTER (WHERE winner != $1 AND winner IS NOT NULL AND status = 'completed') as losses,
        COUNT(*) FILTER (WHERE winner IS NULL AND status = 'draw') as draws
      FROM games 
      WHERE (player_x = $1 OR player_o = $1)
    `;
    const txQuery = `
      SELECT * FROM payment_transactions 
      WHERE user_id = $1 
      ORDER BY created_at DESC LIMIT 5
    `;
    const [statsRes, txsRes] = await Promise.all([
      pool.query(statsQuery, [userId]),
      pool.query(txQuery, [userId])
    ]);

    return res.json({ 
      ok: true, 
      games: {
        wins: Number(statsRes.rows[0].wins || 0),
        losses: Number(statsRes.rows[0].losses || 0),
        draws: Number(statsRes.rows[0].draws || 0)
      },
      transactions: txsRes.rows 
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

    const conditions = [];
    const params = [];
    let idx = 1;

    if (type)   { conditions.push(`pt.type = $${idx++}`);   params.push(type); }
    if (status) { conditions.push(`pt.status = $${idx++}`); params.push(status); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const query = `
      SELECT pt.*, u.number, u.username, u.display_name
      FROM payment_transactions pt
      LEFT JOIN users u ON u.id = pt.user_id
      ${where}
      ORDER BY pt.created_at DESC
      LIMIT $${idx++} OFFSET $${idx}
    `;
    params.push(limit, offset);

    const { rows } = await pool.query(query, params);
    const countRow = await pool.query(
      `SELECT COUNT(*) FROM payment_transactions ${where}`,
      params.slice(0, -2)
    );

    return res.json({ transactions: rows, total: Number(countRow.rows[0].count), limit, offset });
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
        `SELECT * FROM payment_transactions WHERE id = $1 FOR UPDATE`,
        [req.params.id]
      );
      if (!rows.length) throw Object.assign(new Error('Transaction not found'), { status: 404 });
      const txn = rows[0];

      if (txn.status !== 'pending') {
        throw Object.assign(new Error(`Cannot approve a ${txn.status} transaction`), { status: 409 });
      }

      // Mark as success
      await client.query(
        `UPDATE payment_transactions SET status = 'success', updated_at = now() WHERE id = $1`,
        [req.params.id]
      );

      // For deposits: credit the wallet
      if (txn.type === 'deposit') {
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
    });

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
        `SELECT * FROM payment_transactions WHERE id = $1 FOR UPDATE`,
        [req.params.id]
      );
      if (!rows.length) throw Object.assign(new Error('Transaction not found'), { status: 404 });
      const txn = rows[0];

      if (txn.status !== 'pending') {
        throw Object.assign(new Error(`Cannot reject a ${txn.status} transaction`), { status: 409 });
      }

      await client.query(
        `UPDATE payment_transactions SET status = 'failed', updated_at = now() WHERE id = $1`,
        [req.params.id]
      );

      // For withdrawals: refund the deducted balance
      if (txn.type === 'withdrawal') {
        await client.query(
          `UPDATE wallets
           SET available_balance    = available_balance    + $2,
               withdrawable_balance = withdrawable_balance + $2,
               updated_at           = now()
           WHERE user_id = $1`,
          [txn.user_id, txn.amount]
        );
      }
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
// PATCH /admin/settings
// Body: { key: string, value: any }
// Updates a single global setting
// ──────────────────────────────────────────────
router.patch('/settings', async (req, res) => {
  try {
    const { key, value } = req.body;
    if (!key) return res.status(400).json({ error: 'key is required' });

    const { rows } = await pool.query(
      `INSERT INTO global_settings (key, value, updated_at)
       VALUES ($1, $2::jsonb, now())
       ON CONFLICT (key) DO UPDATE
       SET value = $2::jsonb, updated_at = now()
       RETURNING *`,
      [key, JSON.stringify(value)]
    );
    return res.json({ ok: true, setting: rows[0] });
  } catch (err) {
    console.error('[ADMIN] /settings PATCH error', err);
    return res.status(500).json({ error: 'Failed to update setting' });
  }
});

// ──────────────────────────────────────────────
// GET /admin/game-logs?limit=&offset=
// Paginated game history
// ──────────────────────────────────────────────
router.get('/game-logs', async (req, res) => {
  try {
    const limit  = Math.min(Number(req.query.limit  || 20), 100);
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

    const countRes = await pool.query(`SELECT COUNT(*) FROM games`);
    return res.json({ games: rows, total: Number(countRes.rows[0].count), limit, offset });
  } catch (err) {
    console.error('[ADMIN] /game-logs error', err);
    return res.status(500).json({ error: 'Failed to fetch game logs' });
  }
});

module.exports = router;
