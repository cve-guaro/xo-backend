// src/middleware/MiniAppAuth.js
// Authentication, permission checking, rate limiting, and audit logging for Mini-App API calls
const crypto = require('crypto');
const { pool, redis } = require('../db/index');

/**
 * Compare an API secret against its stored SHA-256 hash.
 */
function verifySecret(plainSecret, storedHash) {
  const hash = crypto.createHash('sha256').update(plainSecret).digest('hex');
  return hash === storedHash;
}

/**
 * Rate-limit check using a Redis sliding window.
 * Returns true if the request is ALLOWED, false if rate-limited.
 */
async function checkRateLimit(appId, maxPerMinute) {
  const key = `miniapp_rl:${appId}`;
  try {
    const current = await redis.incr(key);
    if (current === 1) {
      await redis.expire(key, 60);
    }
    return current <= maxPerMinute;
  } catch (err) {
    // If Redis is down, allow the request (fail-open for availability)
    console.warn('[MINIAPP_RL] Redis rate-limit check failed, allowing request:', err.message);
    return true;
  }
}

/**
 * Log an API call to the mini_app_api_logs table (fire-and-forget).
 */
function logApiCall(miniAppId, { endpoint, method, targetUserId, requestBody, responseStatus, ipAddress }) {
  pool.query(
    `INSERT INTO mini_app_api_logs (mini_app_id, endpoint, method, target_user_id, request_body, response_status, ip_address)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [miniAppId, endpoint, method, targetUserId || null, requestBody ? JSON.stringify(requestBody) : null, responseStatus, ipAddress]
  ).catch(err => console.error('[MINIAPP_LOG] Failed to write API log:', err.message));
}

/**
 * Factory: creates middleware that requires specific permissions.
 * Usage: router.get('/users/:id', requirePermission('read:users'), handler)
 */
function requirePermission(...requiredPerms) {
  return (req, res, next) => {
    if (!req.miniApp) {
      return res.status(401).json({ error: 'Mini-app authentication required' });
    }

    const appPerms = req.miniApp.permissions || [];
    const missing = requiredPerms.filter(p => !appPerms.includes(p));

    if (missing.length > 0) {
      // Log the denied attempt
      logApiCall(req.miniApp.id, {
        endpoint: req.originalUrl,
        method: req.method,
        responseStatus: 403,
        ipAddress: req.ip,
      });
      return res.status(403).json({
        error: 'Permission denied',
        required: requiredPerms,
        missing,
      });
    }

    next();
  };
}

/**
 * Core Mini-App authentication middleware.
 * Reads X-MiniApp-Key and X-MiniApp-Secret from headers.
 * Attaches req.miniApp = { id, name, permissions } on success.
 */
async function miniAppAuth(req, res, next) {
  const apiKey = req.headers['x-miniapp-key'];
  const apiSecret = req.headers['x-miniapp-secret'];

  if (!apiKey || !apiSecret) {
    return res.status(401).json({ error: 'Missing X-MiniApp-Key or X-MiniApp-Secret headers' });
  }

  try {
    // Look up the mini-app by API key
    const { rows } = await pool.query(
      `SELECT id, name, api_secret_hash, permissions, rate_limit, is_active, is_locked, ip_whitelist
       FROM mini_apps WHERE api_key = $1 LIMIT 1`,
      [apiKey]
    );

    if (rows.length === 0) {
      return res.status(401).json({ error: 'Invalid API key' });
    }

    const app = rows[0];

    // Check if the app is locked for maintenance
    if (app.is_locked) {
      logApiCall(app.id, {
        endpoint: req.originalUrl,
        method: req.method,
        responseStatus: 503,
        ipAddress: req.ip,
      });
      return res.status(503).json({ error: 'Mini-app is currently locked for maintenance' });
    }

    // Check if the app is active
    if (!app.is_active) {
      logApiCall(app.id, {
        endpoint: req.originalUrl,
        method: req.method,
        responseStatus: 403,
        ipAddress: req.ip,
      });
      return res.status(403).json({ error: 'Mini-app is deactivated' });
    }

    // Check IP whitelist if configured
    if (Array.isArray(app.ip_whitelist) && app.ip_whitelist.length > 0) {
      const clientIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
      if (!app.ip_whitelist.includes(clientIp) && !app.ip_whitelist.includes(req.ip)) {
        logApiCall(app.id, {
          endpoint: req.originalUrl,
          method: req.method,
          responseStatus: 403,
          ipAddress: req.ip,
        });
        return res.status(403).json({ error: 'Access denied: IP address not whitelisted' });
      }
    }

    // Verify the secret
    if (!verifySecret(apiSecret, app.api_secret_hash)) {
      logApiCall(app.id, {
        endpoint: req.originalUrl,
        method: req.method,
        responseStatus: 401,
        ipAddress: req.ip,
      });
      return res.status(401).json({ error: 'Invalid API secret' });
    }

    // Rate-limit check
    const allowed = await checkRateLimit(app.id, app.rate_limit || 100);
    if (!allowed) {
      logApiCall(app.id, {
        endpoint: req.originalUrl,
        method: req.method,
        responseStatus: 429,
        ipAddress: req.ip,
      });
      return res.status(429).json({ error: 'Rate limit exceeded. Try again later.' });
    }

    // Attach mini-app context to request
    req.miniApp = {
      id: app.id,
      name: app.name,
      permissions: app.permissions || [],
    };

    // Wrap res.json to capture response status for audit logging
    const originalJson = res.json.bind(res);
    res.json = function (body) {
      logApiCall(app.id, {
        endpoint: req.originalUrl,
        method: req.method,
        targetUserId: req.params.userId || null,
        requestBody: ['POST', 'PUT', 'PATCH'].includes(req.method) ? req.body : null,
        responseStatus: res.statusCode,
        ipAddress: req.ip,
      });
      return originalJson(body);
    };

    // Update last_active timestamp (fire-and-forget)
    pool.query(
      `UPDATE mini_apps SET updated_at = NOW() WHERE id = $1`,
      [app.id]
    ).catch(() => {});

    next();
  } catch (err) {
    console.error('[MINIAPP_AUTH] Error:', err.message);
    return res.status(500).json({ error: 'Internal authentication error' });
  }
}

module.exports = { miniAppAuth, requirePermission, logApiCall, verifySecret };
