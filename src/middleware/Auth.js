const jwt = require('jsonwebtoken');
const { pool, redis } = require('../db/index');
const { logAnomaly } = require('./AnomalyMonitor');



const JWT_SECRET = process.env.JWT_PUBLIC_KEY || process.env.JWT_SECRET;

if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET is not set. Server cannot start securely.');
  process.exit(1);
}
const pubKey = JWT_SECRET;

// Bounded short-TTL in-memory role cache to prevent DB stampedes on Redis circuit-break
const _roleMemCache = new Map();
const ROLE_MEM_TTL_MS = 15_000;
const ROLE_MEM_MAX = 5000;

function invalidateUserRoleCache(userId) {
  if (userId) {
    _roleMemCache.delete(String(userId));
  } else {
    _roleMemCache.clear();
  }
}

function setRoleMemCache(uid, role) {
  if (_roleMemCache.size >= ROLE_MEM_MAX) {
    const oldestKey = _roleMemCache.keys().next().value;
    _roleMemCache.delete(oldestKey);
  }
  _roleMemCache.set(uid, { role, expiresAt: Date.now() + ROLE_MEM_TTL_MS });
}

async function getLiveUserRole(req, userId, fallbackRole = 'user') {
  if (!userId) return fallbackRole;
  const uid = String(userId);

  // 1. Request-level deduplication (shared between Security.js & Auth.js)
  if (req && req._resolvedRoleUserId === uid && req._resolvedUserRole !== undefined) {
    return req._resolvedUserRole;
  }

  // 2. Short-TTL in-memory cache
  const mem = _roleMemCache.get(uid);
  if (mem && Date.now() < mem.expiresAt) {
    if (req) {
      req._resolvedRoleUserId = uid;
      req._resolvedUserRole = mem.role;
    }
    return mem.role;
  }

  // 3. Redis + DB fallback
  try {
    const cacheKey = `user_role:${uid}`;
    const cachedRole = await redis.get(cacheKey);
    if (cachedRole) {
      setRoleMemCache(uid, cachedRole);
      if (req) {
        req._resolvedRoleUserId = uid;
        req._resolvedUserRole = cachedRole;
      }
      return cachedRole;
    }

    const { rows } = await pool.query('SELECT role FROM users WHERE id = $1', [uid]);
    if (rows.length) {
      const liveRole = rows[0].role || 'user';
      setRoleMemCache(uid, liveRole);
      if (req) {
        req._resolvedRoleUserId = uid;
        req._resolvedUserRole = liveRole;
      }
      await redis.setex(cacheKey, 300, liveRole);
      return liveRole;
    }
  } catch (_) {
    /* keep fallbackRole on transient DB error without caching fallback */
  }

  return fallbackRole;
}

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

      const payload = (req._verifiedJwt && req._verifiedJwtToken === token)
        ? req._verifiedJwt
        : jwt.verify(token, pubKey, { algorithms: ['HS256'] });
      req._verifiedJwt = payload;
      req._verifiedJwtToken = token;
      const userId = payload.sub || payload.userId || payload.id;

      // ✅ Always fetch the LIVE role (request dedup -> 15s mem -> Redis -> DB)
      const liveRole = await getLiveUserRole(req, userId, payload.role || 'user');

      req.user = {
        id: userId,
        phone_number: payload.number,
        role: liveRole,
      };
      return next();
    }

    return res.status(401).json({ error: 'Unauthorized' });
  } catch (err) {
    // TokenExpiredError or stale signature from client local storage is NORMAL — user just needs to re-auth. Never flag as anomaly.
    const msg = String(err.message || '').toLowerCase();
    if (err.name === 'TokenExpiredError' || msg.includes('invalid signature') || msg.includes('jwt malformed') || msg.includes('jwt expired')) {
      return res.status(401).json({ error: 'Unauthorized', code: 'INVALID_TOKEN' });
    }
    // All other suspicious JWT crashes (e.g. injection attempts) ARE logged
    await logAnomaly(req, `JWT validation crash: ${err.message}`);
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
     const isAdmin = req.user.role === 'admin' || req.user.role === 'superadmin' || req.user.role === 'maintenance' || req.user.role === 'maintenance_admin';
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
     if (req.user.role !== 'superadmin' && req.user.role !== 'maintenance' && req.user.role !== 'maintenance_admin') {
       return res.status(403).json({ error: 'Critical access denied: Only Super Admin can perform this action.' });
     }
     next();
   });
 }

module.exports = { auth, adminAuth, superAdminAuth, getLiveUserRole, invalidateUserRoleCache };
