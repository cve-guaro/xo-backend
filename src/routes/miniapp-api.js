// src/routes/miniapp-api.js
// External Mini-App API — 14 endpoints for user data, wallet, notifications, and metadata
// All routes are authenticated via MiniAppAuth middleware and permission-scoped.
const express = require('express');
const { pool, withTx, redis } = require('../db/index');
const { miniAppAuth, requirePermission } = require('../middleware/MiniAppAuth');

const router = express.Router();

// Apply mini-app auth to ALL routes
router.use(miniAppAuth);

// ──────────────────────────────────────────────────────────────────────────────
// GET /miniapp/v1/users/:userId
// Permission: read:users
// Returns user profile + balance + game stats
// ──────────────────────────────────────────────────────────────────────────────
router.get('/users/:userId', requirePermission('read:users'), async (req, res) => {
  try {
    const { userId } = req.params;
    const { rows } = await pool.query(`
      SELECT 
        u.id, u.username, u.number, u.avatar, u.display_name, u.role,
        u.created_at, u.banned, u.telegram_id, u.telegram_username,
        u.room_1_wins, u.room_2_wins, u.room_3_wins,
        COALESCE(w.available_balance, 0)    AS available_balance,
        COALESCE(w.withdrawable_balance, 0) AS withdrawable_balance,
        COALESCE(w.bonus_balance, 0)        AS bonus_balance
      FROM users u
      LEFT JOIN wallets w ON w.user_id = u.id
      WHERE u.id = $1 AND u.is_bot = false
      LIMIT 1
    `, [userId]);

    if (!rows.length) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = rows[0];

    // Game stats
    const { rows: gameStats } = await pool.query(`
      SELECT 
        COUNT(*) AS total_games,
        COUNT(*) FILTER (WHERE winner = $1) AS total_wins
      FROM games WHERE player_x = $1 OR player_o = $1
    `, [userId]);

    return res.json({
      ok: true,
      user: {
        id: user.id,
        username: user.username,
        phone: user.number,
        avatar: user.avatar,
        display_name: user.display_name,
        role: user.role || 'user',
        created_at: user.created_at,
        banned: user.banned || false,
        telegram_id: user.telegram_id,
        telegram_username: user.telegram_username,
        balance: {
          available: Number(user.available_balance),
          withdrawable: Number(user.withdrawable_balance),
          bonus: Number(user.bonus_balance),
        },
        stats: {
          total_games: Number(gameStats[0]?.total_games || 0),
          total_wins: Number(gameStats[0]?.total_wins || 0),
          room_1_wins: user.room_1_wins || 0,
          room_2_wins: user.room_2_wins || 0,
          room_3_wins: user.room_3_wins || 0,
        },
      },
    });
  } catch (err) {
    console.error('[MINIAPP_API] GET /users/:userId error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// GET /miniapp/v1/users/by-phone/:phone
// Permission: read:users
// Look up user by phone number (normalized 251XXXXXXXXX format)
// ──────────────────────────────────────────────────────────────────────────────
router.get('/users/by-phone/:phone', requirePermission('read:users'), async (req, res) => {
  try {
    let phone = req.params.phone.replace(/[^0-9]/g, '');
    // Normalize
    if (/^0\d{9}$/.test(phone)) phone = `251${phone.slice(1)}`;
    else if (/^\d{9}$/.test(phone)) phone = `251${phone}`;

    const { rows } = await pool.query(`
      SELECT 
        u.id, u.username, u.number, u.avatar, u.display_name, u.role, u.created_at, u.banned,
        COALESCE(w.available_balance, 0) AS available_balance,
        COALESCE(w.withdrawable_balance, 0) AS withdrawable_balance,
        COALESCE(w.bonus_balance, 0) AS bonus_balance
      FROM users u
      LEFT JOIN wallets w ON w.user_id = u.id
      WHERE u.number = $1 AND u.is_bot = false
      LIMIT 1
    `, [phone]);

    if (!rows.length) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = rows[0];
    return res.json({
      ok: true,
      user: {
        id: user.id,
        username: user.username,
        phone: user.number,
        avatar: user.avatar,
        display_name: user.display_name,
        role: user.role || 'user',
        created_at: user.created_at,
        banned: user.banned || false,
        balance: {
          available: Number(user.available_balance),
          withdrawable: Number(user.withdrawable_balance),
          bonus: Number(user.bonus_balance),
        },
      },
    });
  } catch (err) {
    console.error('[MINIAPP_API] GET /users/by-phone error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// GET /miniapp/v1/users/:userId/balance
// Permission: read:wallet
// Get wallet balances only
// ──────────────────────────────────────────────────────────────────────────────
router.get('/users/:userId/balance', requirePermission('read:wallet'), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT 
        COALESCE(available_balance, 0) AS available,
        COALESCE(withdrawable_balance, 0) AS withdrawable,
        COALESCE(bonus_balance, 0) AS bonus
      FROM wallets WHERE user_id = $1 LIMIT 1
    `, [req.params.userId]);

    if (!rows.length) {
      return res.status(404).json({ error: 'Wallet not found' });
    }

    return res.json({
      ok: true,
      balance: {
        available: Number(rows[0].available),
        withdrawable: Number(rows[0].withdrawable),
        bonus: Number(rows[0].bonus),
      },
    });
  } catch (err) {
    console.error('[MINIAPP_API] GET /users/:userId/balance error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// GET /miniapp/v1/users/:userId/transactions
// Permission: read:wallet
// Get transaction history (paginated)
// ──────────────────────────────────────────────────────────────────────────────
router.get('/users/:userId/transactions', requirePermission('read:wallet'), async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const offset = parseInt(req.query.offset) || 0;

    const { rows } = await pool.query(`
      SELECT id, tx_type, amount, status, description, created_at
      FROM wallet_transactions
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3
    `, [req.params.userId, limit, offset]);

    const { rows: countRows } = await pool.query(
      'SELECT COUNT(*) AS total FROM wallet_transactions WHERE user_id = $1',
      [req.params.userId]
    );

    return res.json({
      ok: true,
      transactions: rows,
      pagination: {
        total: Number(countRows[0]?.total || 0),
        limit,
        offset,
      },
    });
  } catch (err) {
    console.error('[MINIAPP_API] GET /transactions error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// GET /miniapp/v1/users/:userId/games
// Permission: read:games
// Get game history & stats (paginated)
// ──────────────────────────────────────────────────────────────────────────────
router.get('/users/:userId/games', requirePermission('read:games'), async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const offset = parseInt(req.query.offset) || 0;
    const userId = req.params.userId;

    const { rows } = await pool.query(`
      SELECT id, player_x, player_o, winner, status, bet_amount, prize_amount, created_at
      FROM games
      WHERE player_x = $1 OR player_o = $1
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3
    `, [userId, limit, offset]);

    const { rows: stats } = await pool.query(`
      SELECT 
        COUNT(*) AS total_games,
        COUNT(*) FILTER (WHERE winner = $1) AS wins,
        COUNT(*) FILTER (WHERE winner IS NOT NULL AND winner != $1) AS losses,
        COUNT(*) FILTER (WHERE status = 'draw') AS draws
      FROM games WHERE player_x = $1 OR player_o = $1
    `, [userId]);

    return res.json({
      ok: true,
      games: rows,
      stats: {
        total: Number(stats[0]?.total_games || 0),
        wins: Number(stats[0]?.wins || 0),
        losses: Number(stats[0]?.losses || 0),
        draws: Number(stats[0]?.draws || 0),
      },
      pagination: { limit, offset },
    });
  } catch (err) {
    console.error('[MINIAPP_API] GET /games error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// POST /miniapp/v1/users/:userId/wallet/credit
// Permission: write:wallet
// Credit amount to user's available_balance
// Body: { amount: number, reason: string }
// ──────────────────────────────────────────────────────────────────────────────
router.post('/users/:userId/wallet/credit', requirePermission('write:wallet'), async (req, res) => {
  try {
    const { userId } = req.params;
    const { amount, reason } = req.body;

    if (!amount || typeof amount !== 'number' || amount <= 0 || amount > 100000) {
      return res.status(400).json({ error: 'amount must be a positive number (max 100000)' });
    }
    if (!reason || typeof reason !== 'string' || reason.length < 3) {
      return res.status(400).json({ error: 'reason is required (min 3 characters)' });
    }

    const result = await withTx(async (client) => {
      // Verify user exists
      const { rows: userRows } = await client.query('SELECT id FROM users WHERE id = $1', [userId]);
      if (!userRows.length) throw new Error('USER_NOT_FOUND');

      // Credit wallet
      const { rows: walletRows } = await client.query(`
        UPDATE wallets
        SET available_balance = available_balance + $1
        WHERE user_id = $2
        RETURNING available_balance, withdrawable_balance, bonus_balance
      `, [amount, userId]);

      if (!walletRows.length) throw new Error('WALLET_NOT_FOUND');

      // Record transaction
      await client.query(`
        INSERT INTO wallet_transactions (user_id, tx_type, amount, status, description)
        VALUES ($1, 'miniapp_credit', $2, 'completed', $3)
      `, [userId, amount, `[${req.miniApp.name}] ${reason}`]);

      return walletRows[0];
    });

    return res.json({
      ok: true,
      message: `Credited ${amount} to user`,
      balance: {
        available: Number(result.available_balance),
        withdrawable: Number(result.withdrawable_balance),
        bonus: Number(result.bonus_balance),
      },
    });
  } catch (err) {
    if (err.message === 'USER_NOT_FOUND') return res.status(404).json({ error: 'User not found' });
    if (err.message === 'WALLET_NOT_FOUND') return res.status(404).json({ error: 'Wallet not found' });
    console.error('[MINIAPP_API] POST /wallet/credit error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// POST /miniapp/v1/users/:userId/wallet/debit
// Permission: write:wallet
// Debit amount from user's available_balance
// Body: { amount: number, reason: string }
// ──────────────────────────────────────────────────────────────────────────────
router.post('/users/:userId/wallet/debit', requirePermission('write:wallet'), async (req, res) => {
  try {
    const { userId } = req.params;
    const { amount, reason } = req.body;

    if (!amount || typeof amount !== 'number' || amount <= 0 || amount > 100000) {
      return res.status(400).json({ error: 'amount must be a positive number (max 100000)' });
    }
    if (!reason || typeof reason !== 'string' || reason.length < 3) {
      return res.status(400).json({ error: 'reason is required (min 3 characters)' });
    }

    const result = await withTx(async (client) => {
      // Verify user exists
      const { rows: userRows } = await client.query('SELECT id FROM users WHERE id = $1', [userId]);
      if (!userRows.length) throw new Error('USER_NOT_FOUND');

      // Check balance first
      const { rows: balCheck } = await client.query(
        'SELECT available_balance FROM wallets WHERE user_id = $1 FOR UPDATE',
        [userId]
      );
      if (!balCheck.length) throw new Error('WALLET_NOT_FOUND');
      if (Number(balCheck[0].available_balance) < amount) throw new Error('INSUFFICIENT_BALANCE');

      // Debit wallet
      const { rows: walletRows } = await client.query(`
        UPDATE wallets
        SET available_balance = available_balance - $1
        WHERE user_id = $2
        RETURNING available_balance, withdrawable_balance, bonus_balance
      `, [amount, userId]);

      // Record transaction
      await client.query(`
        INSERT INTO wallet_transactions (user_id, tx_type, amount, status, description)
        VALUES ($1, 'miniapp_debit', $2, 'completed', $3)
      `, [userId, amount, `[${req.miniApp.name}] ${reason}`]);

      return walletRows[0];
    });

    return res.json({
      ok: true,
      message: `Debited ${amount} from user`,
      balance: {
        available: Number(result.available_balance),
        withdrawable: Number(result.withdrawable_balance),
        bonus: Number(result.bonus_balance),
      },
    });
  } catch (err) {
    if (err.message === 'USER_NOT_FOUND') return res.status(404).json({ error: 'User not found' });
    if (err.message === 'WALLET_NOT_FOUND') return res.status(404).json({ error: 'Wallet not found' });
    if (err.message === 'INSUFFICIENT_BALANCE') return res.status(400).json({ error: 'Insufficient balance' });
    console.error('[MINIAPP_API] POST /wallet/debit error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// POST /miniapp/v1/users/:userId/notify
// Permission: send:notifications
// Send in-app notification to user
// Body: { title: string, message: string, type?: string, meta?: object }
// ──────────────────────────────────────────────────────────────────────────────
router.post('/users/:userId/notify', requirePermission('send:notifications'), async (req, res) => {
  try {
    const { userId } = req.params;
    const { title, message, type, meta } = req.body;

    if (!title || !message) {
      return res.status(400).json({ error: 'title and message are required' });
    }

    // Verify user exists
    const { rows: userCheck } = await pool.query('SELECT id FROM users WHERE id = $1', [userId]);
    if (!userCheck.length) return res.status(404).json({ error: 'User not found' });

    const { rows } = await pool.query(`
      INSERT INTO notifications (user_id, type, title, message, meta)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, created_at
    `, [userId, type || 'miniapp', `[${req.miniApp.name}] ${title}`, message, meta ? JSON.stringify(meta) : null]);

    return res.json({
      ok: true,
      notification: {
        id: rows[0].id,
        created_at: rows[0].created_at,
      },
    });
  } catch (err) {
    console.error('[MINIAPP_API] POST /notify error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// PUT /miniapp/v1/users/:userId/metadata
// Permission: write:users
// Update user's raw_user_meta_data (merge, not replace)
// Body: { key: string, value: any }
// ──────────────────────────────────────────────────────────────────────────────
router.put('/users/:userId/metadata', requirePermission('write:users'), async (req, res) => {
  try {
    const { userId } = req.params;
    const { key, value } = req.body;

    if (!key || typeof key !== 'string') {
      return res.status(400).json({ error: 'key is required (string)' });
    }

    // Namespace the key with mini-app name to prevent collisions
    const namespacedKey = `miniapp_${req.miniApp.name}_${key}`;

    const { rows } = await pool.query(`
      UPDATE users 
      SET raw_user_meta_data = COALESCE(raw_user_meta_data, '{}'::jsonb) || jsonb_build_object($2, $3::jsonb)
      WHERE id = $1
      RETURNING id, raw_user_meta_data
    `, [userId, namespacedKey, JSON.stringify(value)]);

    if (!rows.length) return res.status(404).json({ error: 'User not found' });

    return res.json({ ok: true, metadata: rows[0].raw_user_meta_data });
  } catch (err) {
    console.error('[MINIAPP_API] PUT /metadata error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// DELETE /miniapp/v1/users/:userId/metadata/:key
// Permission: write:users
// Delete a specific metadata key
// ──────────────────────────────────────────────────────────────────────────────
router.delete('/users/:userId/metadata/:key', requirePermission('write:users'), async (req, res) => {
  try {
    const { userId, key } = req.params;
    const namespacedKey = `miniapp_${req.miniApp.name}_${key}`;

    const { rows } = await pool.query(`
      UPDATE users 
      SET raw_user_meta_data = raw_user_meta_data - $2
      WHERE id = $1
      RETURNING id
    `, [userId, namespacedKey]);

    if (!rows.length) return res.status(404).json({ error: 'User not found' });

    return res.json({ ok: true, message: `Metadata key '${key}' deleted` });
  } catch (err) {
    console.error('[MINIAPP_API] DELETE /metadata error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// GET /miniapp/v1/users/:userId/data
// Permission: read:miniapp_data
// Get mini-app-specific user data (scoped to the calling mini-app)
// ──────────────────────────────────────────────────────────────────────────────
router.get('/users/:userId/data', requirePermission('read:miniapp_data'), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT data_key, data_value, updated_at
      FROM mini_app_user_data
      WHERE mini_app_id = $1 AND user_id = $2
      ORDER BY data_key
    `, [req.miniApp.id, req.params.userId]);

    const data = {};
    rows.forEach(r => { data[r.data_key] = r.data_value; });

    return res.json({ ok: true, data, entries: rows.length });
  } catch (err) {
    console.error('[MINIAPP_API] GET /data error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// GET /miniapp/v1/users/:userId/data/:key
// Permission: read:miniapp_data
// Get a specific mini-app-specific user data key
// ──────────────────────────────────────────────────────────────────────────────
router.get('/users/:userId/data/:key', requirePermission('read:miniapp_data'), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT data_key, data_value, updated_at
      FROM mini_app_user_data
      WHERE mini_app_id = $1 AND user_id = $2 AND data_key = $3
      LIMIT 1
    `, [req.miniApp.id, req.params.userId, req.params.key]);

    if (!rows.length) return res.status(404).json({ error: `Key '${req.params.key}' not found` });

    return res.json({ ok: true, data: { key: rows[0].data_key, value: rows[0].data_value, updated_at: rows[0].updated_at } });
  } catch (err) {
    console.error('[MINIAPP_API] GET /data/:key error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// PUT /miniapp/v1/users/:userId/data
// Permission: write:miniapp_data
// Set mini-app-specific user data (upsert)
// Body: { key: string, value: any }
// ──────────────────────────────────────────────────────────────────────────────
router.put('/users/:userId/data', requirePermission('write:miniapp_data'), async (req, res) => {
  try {
    const { key, value } = req.body;

    if (!key || typeof key !== 'string') {
      return res.status(400).json({ error: 'key is required (string)' });
    }

    const { rows } = await pool.query(`
      INSERT INTO mini_app_user_data (mini_app_id, user_id, data_key, data_value)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (mini_app_id, user_id, data_key)
      DO UPDATE SET data_value = $4, updated_at = NOW()
      RETURNING data_key, data_value, updated_at
    `, [req.miniApp.id, req.params.userId, key, JSON.stringify(value)]);

    return res.json({ ok: true, entry: rows[0] });
  } catch (err) {
    console.error('[MINIAPP_API] PUT /data error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// DELETE /miniapp/v1/users/:userId/data/:key
// Permission: write:miniapp_data
// Delete mini-app user data key
// ──────────────────────────────────────────────────────────────────────────────
router.delete('/users/:userId/data/:key', requirePermission('write:miniapp_data'), async (req, res) => {
  try {
    const { rowCount } = await pool.query(`
      DELETE FROM mini_app_user_data
      WHERE mini_app_id = $1 AND user_id = $2 AND data_key = $3
    `, [req.miniApp.id, req.params.userId, req.params.key]);

    if (rowCount === 0) return res.status(404).json({ error: 'Data key not found' });

    return res.json({ ok: true, message: `Key '${req.params.key}' deleted` });
  } catch (err) {
    console.error('[MINIAPP_API] DELETE /data error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// GET /miniapp/v1/stats
// Permission: read:stats
// Platform-wide statistics
// ──────────────────────────────────────────────────────────────────────────────
router.get('/stats', requirePermission('read:stats'), async (req, res) => {
  try {
    const [usersRes, gamesRes, walletRes] = await Promise.all([
      pool.query(`SELECT COUNT(*) AS total_users FROM users WHERE is_bot = false`),
      pool.query(`SELECT COUNT(*) AS total_games, COUNT(*) FILTER (WHERE status = 'completed') AS completed_games FROM games`),
      pool.query(`SELECT SUM(available_balance) AS total_available, SUM(withdrawable_balance) AS total_withdrawable FROM wallets`),
    ]);

    return res.json({
      ok: true,
      stats: {
        total_users: Number(usersRes.rows[0]?.total_users || 0),
        total_games: Number(gamesRes.rows[0]?.total_games || 0),
        completed_games: Number(gamesRes.rows[0]?.completed_games || 0),
        total_available_balance: Number(walletRes.rows[0]?.total_available || 0),
        total_withdrawable_balance: Number(walletRes.rows[0]?.total_withdrawable || 0),
      },
    });
  } catch (err) {
    console.error('[MINIAPP_API] GET /stats error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
