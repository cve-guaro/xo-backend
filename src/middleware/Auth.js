const jwt = require('jsonwebtoken');
const { pool } = require('../db/index');
const Redis = require('ioredis');
const redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379');

const JWT_SECRET = process.env.JWT_PUBLIC_KEY || process.env.JWT_SECRET;

if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET is not set. Server cannot start securely.');
  process.exit(1);
}
const pubKey = JWT_SECRET;

async function auth(req, res, next) {
  try {
    // Prefer JWT in Authorization: Bearer
    const hdr = req.headers.authorization || '';
    const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : hdr;
    if (token && pubKey) {
      // ✅ Military-Grade: Check if token was explicitly revoked
      const isBlacklisted = await redis.get(`jwt_bl:${token}`);
      if (isBlacklisted) {
        return res.status(401).json({ error: 'Token revoked' });
      }

      const payload = jwt.verify(token, pubKey);
      const userId = payload.sub || payload.userId || payload.id;

      // ✅ Always fetch the LIVE role from DB — JWT role may be stale after promotion
      let liveRole = payload.role || 'user';
      try {
        const { rows } = await pool.query('SELECT role FROM users WHERE id = $1', [userId]);
        if (rows.length) liveRole = rows[0].role || 'user';
      } catch (_) { /* keep JWT role as fallback */ }

      req.user = {
        id: userId,
        phone_number: payload.number,
        role: liveRole,
      };
      return next();
    }

    return res.status(401).json({ error: 'Unauthorized' });
  } catch (err) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
}

/**
 * Chains auth + admin role guard.
 * Returns 403 if user is authenticated but not an admin or superadmin.
 */
function adminAuth(req, res, next) {
  auth(req, res, () => {
    // 1. Must be authenticated
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    // 2. Must be an admin
    const isAdmin = req.user.role === 'admin' || req.user.role === 'superadmin';
    if (!isAdmin) {
      return res.status(403).json({ error: 'Forbidden: Admin access required' });
    }

    // 3. PLATFORM CHECK: Admin access ONLY allowed via Web
    if (!req.isWeb) {
      console.warn(`[ADMIN_BLOCK] Admin attempt from non-web platform for user ${req.user.id}`);
      return res.status(403).json({ error: 'Forbidden: Admin dashboard only available on Web' });
    }

    next();
  });
}

/**
 * Restricts to ONLY Super Admins (role-based, no hardcoded phones)
 */
function superAdminAuth(req, res, next) {
  adminAuth(req, res, () => {
    if (req.user.role !== 'superadmin') {
      return res.status(403).json({ error: 'Critical access denied: Only Super Admin can perform this action.' });
    }
    next();
  });
}

module.exports = { auth, adminAuth, superAdminAuth };
