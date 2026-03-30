// auth.js
const jwt = require('jsonwebtoken');
const { pool } = require('../db/index');
const JWT_SECRET = process.env.JWT_PUBLIC_KEY || process.env.JWT_SECRET;

const pubKey = JWT_SECRET || 'test'; // or HS256 secret
if (!pubKey) {
  console.warn('JWT_PUBLIC_KEY not set — auth middleware will accept x-user-id for local testing.');
}

async function auth(req, res, next) {
  try {
    // Prefer JWT in Authorization: Bearer
    const hdr = req.headers.authorization || '';
    const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : hdr;
    if (token && pubKey) {
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

    // Dev fallback: x-user-id header
    const fake = req.headers['x-user-id'];
    if (fake) {
      req.user = { id: fake, role: 'user' };
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
    if (!req.user || (req.user.role !== 'admin' && req.user.role !== 'superadmin')) {
      return res.status(403).json({ error: 'Forbidden: Admin access required' });
    }
    next();
  });
}

module.exports = { auth, adminAuth };
