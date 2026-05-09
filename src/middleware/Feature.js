const { pool } = require('../db/index');
const Redis = require('ioredis');
const redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379');

/**
 * Middleware factory to check if a specific feature is enabled.
 * If disabled, returns 503 Service Unavailable.
 */
function checkFeature(featureKey) {
  return async (req, res, next) => {
    try {
      // Allow admins to bypass feature locks so they can test
      if (req.user && ['superadmin', 'maintenance_admin', 'maintenance', 'admin'].includes(req.user.role)) {
        return next();
      }

      const cacheKey = `feature_status_${featureKey}`;
      let isEnabled = await redis.get(cacheKey);

      if (isEnabled === null) {
        const { rows } = await pool.query("SELECT value FROM global_settings WHERE key = $1", [featureKey]);
        // Default to true if not set
        isEnabled = rows.length ? (rows[0].value === true || rows[0].value === 'true') : true;
        await redis.setex(cacheKey, 60, isEnabled ? '1' : '0'); // Cache for 1 min
      } else {
        isEnabled = isEnabled === '1';
      }

      if (!isEnabled) {
        return res.status(503).json({
          error: 'Feature Disabled',
          message: 'This feature is currently disabled for maintenance. Please try again later.'
        });
      }

      next();
    } catch (err) {
      console.error(`[FEATURE CHECK] Error checking ${featureKey}:`, err);
      next(); // Fail open on error
    }
  };
}

module.exports = { checkFeature };
