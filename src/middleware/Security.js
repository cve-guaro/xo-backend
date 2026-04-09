const { pool } = require('../db/index');

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

    const { rows } = await pool.query(`SELECT value FROM global_settings WHERE key = 'system_emergency_lockout'`);
    const isLocked = rows.length > 0 && (rows[0].value === true || rows[0].value === 'true');

    if (isLocked) {
      return res.status(503).json({ 
        error: 'System Maintenance', 
        message: 'The platform is temporarily locked for security maintenance. Please try again later.' 
      });
    }

    next();
  } catch (err) {
    console.error('[SECURITY] Lockdown check error:', err);
    next(); // Continue on error to prevent total blackout if settings table fails
  }
}

module.exports = { systemLockdownCheck };
