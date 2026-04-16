const Redis = require('ioredis');
const redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379');

/**
 * Military-Grade Anomaly Detection Engine
 * Tracks suspicious activities per IP footprint and escalates alerts for WAF or Admin review
 */
const logAnomaly = async (req, reason) => {
    try {
        // Extract real IP behind reverse proxies/Cloudflare/Railway
        const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
        const key = `anomaly:${ip}`;
        
        const score = await redis.incr(key);
        if (score === 1) {
             // Anomaly window lasts 15 minutes
            await redis.expire(key, 15 * 60);
        }

        console.warn(`[SECURITY ANOMALY] IP: ${ip} | Reason: ${reason} | Danger Score: ${score}/10`);
        
        if (score >= 10) {
            console.error(`[CRITICAL SECURITY FLAG] IP ${ip} has exceeded anomaly thresholds. Potential brute-force or injection attempt.`);
            // In a fully integrated environment, we'd trigger a Postgres auto-ban or Cloudflare API block here.
        }
    } catch (err) {
        console.error('[ANOMALY TRACKER EROR]', err);
    }
};

module.exports = { logAnomaly };
