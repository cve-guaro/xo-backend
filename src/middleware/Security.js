const { pool } = require('../db/index');
const Redis = require('ioredis');
const redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379');

/**
 * Security middleware to check for global system locks.
 * If 'system_emergency_lockout' is true in global_settings, 
 * all non-admin routes will return 503 Service Unavailable.
 */
async function systemLockdownCheck(req, res, next) {
  try {
    // Skip lockdown for admin routes (so we can turn it off)
    if (req.originalUrl.startsWith('/admin') || req.originalUrl === '/health') {
      return next();
    }

    let isEmergencyLocked = false;
    let isMobileLocked = false;

    const cacheKey = 'system_lockdown_status';
    const cachedStatus = await redis.get(cacheKey);

    if (cachedStatus) {
      const status = JSON.parse(cachedStatus);
      isEmergencyLocked = status.isEmergencyLocked;
      isMobileLocked = status.isMobileLocked;
    } else {
      const { rows } = await pool.query(`SELECT key, value FROM global_settings WHERE key IN ('system_emergency_lockout', 'mobile_app_lockout')`);
      for (const r of rows) {
        if (r.key === 'system_emergency_lockout') isEmergencyLocked = (r.value === true || r.value === 'true');
        if (r.key === 'mobile_app_lockout') isMobileLocked = (r.value === true || r.value === 'true');
      }
      await redis.setex(cacheKey, 30, JSON.stringify({ isEmergencyLocked, isMobileLocked }));
    }

    if (isEmergencyLocked) {
      return res.status(503).json({ 
        error: 'System Maintenance', 
        message: 'The platform is temporarily locked for security maintenance. Please try again later.' 
      });
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
