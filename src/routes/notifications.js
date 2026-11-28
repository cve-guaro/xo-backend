// routes/notifications.js
// Notification system routes for both users and admin
const express = require('express');
const { pool } = require('../db/index');
const { adminAuth } = require('../middleware/Auth');
const jwt = require('jsonwebtoken');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || process.env.JWT_PUBLIC_KEY;

// Short-TTL bounded in-memory cache for unread badge count (10s)
const _unreadCountCache = new Map();
const UNREAD_COUNT_TTL_MS = 10_000;
const UNREAD_COUNT_MAX = 5000;

function invalidateUnreadCountCache(userId) {
  if (userId) {
    _unreadCountCache.delete(String(userId));
  } else {
    _unreadCountCache.clear();
  }
}

// ──────────────────────────────────────────────
// Middleware: extract userId from JWT for user routes
// ──────────────────────────────────────────────
function authUser(req, res, next) {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'No token' });
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] });
    req.userId = decoded.sub || decoded.id;
    req.user = decoded;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ══════════════════════════════════════════════
//  USER ROUTES (require auth token)
// ══════════════════════════════════════════════

// GET /notifications/user — fetch user's notifications
router.get('/user', authUser, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 50), 100);
    const offset = Number(req.query.offset || 0);

    const listQuery = `
      SELECT id, type, title, message, read, meta, created_at
      FROM notifications
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3
    `;
    const countQuery = `SELECT COUNT(*) as total FROM notifications WHERE user_id = $1`;

    let [listRes, countRes] = await Promise.all([
      pool.query(listQuery, [req.userId, limit, offset]),
      pool.query(countQuery, [req.userId]),
    ]);
    let { rows } = listRes;

    if (rows.length === 0 && offset === 0) {
      await pool.query(`
        INSERT INTO notifications (user_id, type, title, message, meta)
        VALUES ($1, 'welcome', '👋 Welcome to XO Ethiopia!', 'Play XO and Spin games to win real prizes daily. Good luck!', '{}'::jsonb)
      `, [req.userId]).catch(() => {});
      invalidateUnreadCountCache(req.userId);

      [listRes, countRes] = await Promise.all([
        pool.query(listQuery, [req.userId, limit, offset]),
        pool.query(countQuery, [req.userId]),
      ]);
      rows = listRes.rows;
    }

    return res.json({
      ok: true,
      notifications: rows.map(r => ({
        ...r,
        read: !!r.read,
        meta: r.meta || null,
      })),
      total: Number(countRes.rows[0].total),
    });
  } catch (err) {
    console.error('[NOTIFICATIONS] /user error', err);
    return res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

// GET /notifications/user/unread-count — badge number
router.get('/user/unread-count', authUser, async (req, res) => {
  try {
    const uid = String(req.userId);
    const now = Date.now();
    const cached = _unreadCountCache.get(uid);
    if (cached && now < cached.expiresAt) {
      return res.json({ ok: true, count: cached.count });
    }

    const { rows } = await pool.query(`SELECT COUNT(*) as count FROM notifications WHERE user_id = $1 AND read = false`, [req.userId]);
    const count = Number(rows[0].count);
    if (_unreadCountCache.size >= UNREAD_COUNT_MAX) {
      const oldestKey = _unreadCountCache.keys().next().value;
      _unreadCountCache.delete(oldestKey);
    }
    _unreadCountCache.set(uid, { count, expiresAt: now + UNREAD_COUNT_TTL_MS });
    return res.json({ ok: true, count });
  } catch (err) {
    return res.status(500).json({ error: 'Failed' });
  }
});

// PATCH /notifications/user/:id/read — mark single notification as read
router.patch('/user/:id/read', authUser, async (req, res) => {
  try {
    await pool.query(`UPDATE notifications SET read = true WHERE id = $1 AND user_id = $2`, [req.params.id, req.userId]);
    invalidateUnreadCountCache(req.userId);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: 'Failed' });
  }
});

// PATCH /notifications/user/read-all — mark ALL as read
router.patch('/user/read-all', authUser, async (req, res) => {
  try {
    await pool.query(`UPDATE notifications SET read = true WHERE user_id = $1 AND read = false`, [req.userId]);
    invalidateUnreadCountCache(req.userId);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: 'Failed' });
  }
});

// ══════════════════════════════════════════════
//  ADMIN ROUTES (require admin auth)
// ══════════════════════════════════════════════

// POST /notifications/admin/send — send to specific user(s)
router.post('/admin/send', adminAuth, async (req, res) => {
  try {
    const { userId, userIds, type, title, message, meta } = req.body;
    if (!title || !message) return res.status(400).json({ error: 'Title and message required' });

    const targets = userIds || (userId ? [userId] : []);
    if (!targets.length) return res.status(400).json({ error: 'No target user(s) specified' });

    let sent = 0;
    for (const uid of targets) {
      await pool.query(`
        INSERT INTO notifications (user_id, type, title, message, meta)
        VALUES ($1, $2, $3, $4, $5)
      `, [uid, type || 'admin_message', title, message, meta ? JSON.stringify(meta) : null]);
      invalidateUnreadCountCache(uid);
      sent++;
    }

    return res.json({ ok: true, sent });
  } catch (err) {
    console.error('[NOTIFICATIONS] /admin/send error', err);
    return res.status(500).json({ error: 'Failed to send notifications' });
  }
});

// POST /notifications/admin/send-by-phone — send by phone number
router.post('/admin/send-by-phone', adminAuth, async (req, res) => {
  try {
    const { phone, type, title, message, meta } = req.body;
    if (!phone || !title || !message) return res.status(400).json({ error: 'Phone, title, and message required' });

    // Normalize phone
    const normalizedPhone = phone.replace(/[\s\-\+\(\)]/g, '');
    const tail9 = normalizedPhone.length >= 9 ? normalizedPhone.slice(-9) : normalizedPhone;

    const userRes = await pool.query(`
      SELECT id, username, number FROM users 
      WHERE RIGHT(REGEXP_REPLACE(number, '[^0-9]', '', 'g'), 9) = $1
      LIMIT 1
    `, [tail9]);

    if (!userRes.rows.length) return res.status(404).json({ error: `User with phone ${phone} not found` });

    const user = userRes.rows[0];
    await pool.query(`
      INSERT INTO notifications (user_id, type, title, message, meta)
      VALUES ($1, $2, $3, $4, $5)
    `, [user.id, type || 'admin_message', title, message, meta ? JSON.stringify(meta) : null]);
    invalidateUnreadCountCache(user.id);

    return res.json({ ok: true, sent: 1, user: { id: user.id, username: user.username, number: user.number } });
  } catch (err) {
    console.error('[NOTIFICATIONS] /admin/send-by-phone error', err);
    return res.status(500).json({ error: 'Failed to send notification' });
  }
});

// POST /notifications/admin/broadcast — send to ALL users
router.post('/admin/broadcast', adminAuth, async (req, res) => {
  try {
    const { type, title, message, meta } = req.body;
    if (!title || !message) return res.status(400).json({ error: 'Title and message required' });

    const result = await pool.query(`
      INSERT INTO notifications (user_id, type, title, message, meta)
      SELECT id, $1, $2, $3, $4 FROM users WHERE banned = false
    `, [type || 'broadcast', title, message, meta ? JSON.stringify(meta) : null]);
    invalidateUnreadCountCache();

    return res.json({ ok: true, sent: result.rowCount });
  } catch (err) {
    console.error('[NOTIFICATIONS] /admin/broadcast error', err);
    return res.status(500).json({ error: 'Failed to broadcast' });
  }
});

// GET /notifications/admin/history — all sent notifications
router.get('/admin/history', adminAuth, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 50), 200);
    const offset = Number(req.query.offset || 0);

    const { rows } = await pool.query(`
      SELECT n.id, n.user_id, n.type, n.title, n.message, n.read, n.created_at,
             u.username, u.number
      FROM notifications n
      LEFT JOIN users u ON n.user_id = u.id
      ORDER BY n.created_at DESC
      LIMIT $1 OFFSET $2
    `, [limit, offset]);

    const countRes = await pool.query(`SELECT COUNT(*) as total FROM notifications`);

    return res.json({
      ok: true,
      notifications: rows,
      total: Number(countRes.rows[0].total),
    });
  } catch (err) {
    console.error('[NOTIFICATIONS] /admin/history error', err);
    return res.status(500).json({ error: 'Failed' });
  }
});

// GET /notifications/admin/refund-log — all refund records
router.get('/admin/refund-log', adminAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT wt.id, wt.user_id, wt.amount, wt.status, wt.meta, wt.created_at,
             u.username, u.number
      FROM wallet_transactions wt
      LEFT JOIN users u ON wt.user_id = u.id
      WHERE wt.tx_type = 'REFUND'
      ORDER BY wt.created_at DESC
      LIMIT 100
    `);

    return res.json({
      ok: true,
      refunds: rows.map(r => ({
        ...r,
        amount: Number(r.amount || 0),
        meta: typeof r.meta === 'string' ? JSON.parse(r.meta) : r.meta,
      })),
    });
  } catch (err) {
    console.error('[NOTIFICATIONS] /admin/refund-log error', err);
    return res.status(500).json({ error: 'Failed' });
  }
});

router.invalidateUnreadCountCache = invalidateUnreadCountCache;
module.exports = router;
