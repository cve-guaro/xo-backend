const { pool } = require('../db/index');
const Redis = require('ioredis');
const redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379');

// Admin phone numbers (both local and 251-prefixed formats)
const ADMIN_PHONES = [
  '0961111106', '251961111106', '+251961111106',
  '0939484533', '251939484533', '+251939484533',
  '0995270894', '251995270894', '+251995270894'
];

// Roles that can bypass the lockdown
const BYPASS_ROLES = ['superadmin', 'maintenance', 'maintenance_admin', 'admin'];

// Routes that should NEVER be blocked (webhooks, callbacks, health, etc.)
const ALWAYS_ALLOW_PATHS = [
  '/health',
  '/payments/webhook',        // Chapa webhook callback
  '/payments/chapa-bounce',   // Chapa redirect bounce page
  '/payments/chapa-banks',    // Bank list (public info)
  '/api/features',            // Needed to detect lockdown status
];

/**
 * Security middleware to check for global system locks.
 * If 'system_emergency_lockout' is true in global_settings,
 * all non-admin routes will return 503 Service Unavailable.
 * 
 * Bypass rules (in order):
 * 1. Always-allow paths (webhooks, health, callbacks)
 * 2. Admin panel routes (/admin/*)
 * 3. Admin phone numbers in request body (for OTP login)
 * 4. Valid JWT with admin role or admin phone number
 * 5. If none match → check lockdown flag → block if locked
 */
async function systemLockdownCheck(req, res, next) {
  try {
    const url = req.originalUrl.split('?')[0]; // Strip query params for matching

    // ─── BYPASS 1: Always-allow paths (webhooks, callbacks, health) ───
    if (ALWAYS_ALLOW_PATHS.some(p => url.startsWith(p))) {
      return next();
    }

    // ─── BYPASS 2: Admin panel routes ───
    if (url.startsWith('/admin')) {
      return next();
    }

    // ─── BYPASS 3: Admin phone numbers in request body (OTP login) ───
    if (req.body && req.body.number) {
      const num = String(req.body.number).replace(/\+/g, '');
      if (ADMIN_PHONES.includes(num) || ADMIN_PHONES.includes(req.body.number)) {
        return next();
      }
    }

    // ─── BYPASS 4: Valid JWT with admin role or admin phone ───
    const authHeader = req.headers.authorization || '';
    if (authHeader.startsWith('Bearer ')) {
      try {
        const token = authHeader.slice(7);
        const jwt = require('jsonwebtoken');
        const pubKey = process.env.JWT_PUBLIC_KEY || process.env.JWT_SECRET;
        const payload = jwt.verify(token, pubKey);

        if (payload) {
          // Check role from JWT
          if (BYPASS_ROLES.includes(payload.role)) {
            return next();
          }

          // Check phone number from JWT
          const jwtNumber = payload.number ? String(payload.number).replace(/\+/g, '') : null;
          if (jwtNumber && ADMIN_PHONES.includes(jwtNumber)) {
            return next();
          }

          // Check live role from DB (JWT role may be stale)
          const userId = payload.sub || payload.userId || payload.id;
          if (userId) {
            try {
              const cacheKey = `lockdown_role:${userId}`;
              let liveRole = await redis.get(cacheKey);
              if (!liveRole) {
                const { rows } = await pool.query('SELECT role FROM users WHERE id = $1', [userId]);
                if (rows.length) {
                  liveRole = rows[0].role;
                  await redis.setex(cacheKey, 60, liveRole); // Cache for 1 min
                }
              }
              if (liveRole && BYPASS_ROLES.includes(liveRole)) {
                return next();
              }
            } catch (_) { /* DB error — fall through to lockdown check */ }
          }
        }
      } catch (e) {
        // JWT verification failed — not an admin, fall through
      }
    }

    // Exempt external webhooks and return URLs from lockdown
    if (req.path.startsWith('/payments/chapa-return') || req.path.startsWith('/payments/chapa-webhook')) {
      return next();
    }

    // ─── CHECK LOCKDOWN STATUS ───
    let isEmergencyLocked = false;
    let isMobileLocked = false;
    let whitelist = [];

    const cacheKey = 'system_lockdown_status';
    const cachedStatus = await redis.get(cacheKey);

    if (cachedStatus) {
      const status = JSON.parse(cachedStatus);
      isEmergencyLocked = status.isEmergencyLocked;
      isMobileLocked = status.isMobileLocked;
      whitelist = status.whitelist || [];
    } else {
      const { rows } = await pool.query(`SELECT key, value FROM global_settings WHERE key IN ('system_emergency_lockout', 'mobile_app_lockout', 'lockdown_whitelist')`);
      for (const r of rows) {
        if (r.key === 'system_emergency_lockout') isEmergencyLocked = (r.value === true || r.value === 'true');
        if (r.key === 'mobile_app_lockout') isMobileLocked = (r.value === true || r.value === 'true');
        if (r.key === 'lockdown_whitelist') whitelist = Array.isArray(r.value) ? r.value : [];
      }
      await redis.setex(cacheKey, 30, JSON.stringify({ isEmergencyLocked, isMobileLocked, whitelist }));
    }

    if (isEmergencyLocked) {
      // Check if user is in whitelist
      let isWhitelisted = false;
      const authHeader = req.headers.authorization || '';
      if (authHeader.startsWith('Bearer ')) {
        try {
          const token = authHeader.slice(7);
          const jwt = require('jsonwebtoken');
          const pubKey = process.env.JWT_PUBLIC_KEY || process.env.JWT_SECRET;
          const payload = jwt.verify(token, pubKey);
          
          if (payload) {
            const jwtNum = payload.number ? String(payload.number).replace(/\+/g, '') : null;
            if (jwtNum && whitelist.includes(jwtNum)) isWhitelisted = true;
            if (payload.username && whitelist.includes(payload.username)) isWhitelisted = true;
          }
        } catch(e) {}
      }

      if (!isWhitelisted) {
        return res.status(503).json({
          error: 'System Maintenance',
          message: 'The platform is temporarily locked for security maintenance. Please try again later.'
        });
      }
    }

    if (isMobileLocked && req.isWeb === false) {
      return res.status(403).json({
        error: 'App Deprecated',
        message: 'The mobile app is no longer supported. Please use the website to access your account.'
      });
    }

    next();
  } catch (err) {
    console.error('[SECURITY] Lockdown check error:', err);
    next(); // Continue on error to prevent total blackout if settings table fails
  }
}

module.exports = { systemLockdownCheck };
