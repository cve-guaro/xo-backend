const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // SECURITY NOTE: rejectUnauthorized:false is REQUIRED by Supabase's PgBouncer pooler.
  // Supabase uses self-signed certs on their pooler endpoint. Removing this will break the connection.
  // This is an accepted tradeoff — the connection is still encrypted (TLS), just not certificate-pinned.
  ssl: process.env.DATABASE_URL?.includes('supabase') 
    ? { rejectUnauthorized: false } 
    : (process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false),
  // Tuned for Supabase PgBouncer: lower pool prevents over-subscribing the bouncer's own limit
  max: Number(process.env.DB_POOL_MAX || 12),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 3000,   // Faster failure detection (was 5s)
  statement_timeout: 30000,        // Kill runaway queries after 30s
});

pool.on('error', (err) => {
  console.error('[DB POOL] Unexpected error on idle client:', err.message);
});

async function withTx(fn, maxRetries = 3) {
  let attempt = 0;
  while (attempt < maxRetries) {
    const client = await pool.connect();
    try {
      // ✅ Military-Grade Financial Integrity: Strict Read Committed with explicit locking
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      const res = await fn(client);
      await client.query('COMMIT');
      return res;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch { }
      
      // ✅ Handle Concurrency Failures gracefully
      if (e.code === '40001' && attempt < maxRetries - 1) {
        attempt++;
        // Jittered backoff to prevent thundering herd
        const backoffMs = Math.floor(Math.random() * 50 * Math.pow(2, attempt));
        console.warn(`[DB_TX] Serialization conflict (40001). Retrying tx (attempt ${attempt}/${maxRetries}) after ${backoffMs}ms`);
        await new Promise(r => setTimeout(r, backoffMs));
        continue;
      }
      throw e;
    } finally {
      client.release();
    }
  }
}
const Redis = require('ioredis');
const redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
  enableOfflineQueue: false, // Prevents commands from hanging indefinitely in queue when offline
  maxRetriesPerRequest: 3,
  retryStrategy(times) {
    if (times > 5) return null; // Stop retrying after 5 failed attempts
    return Math.min(times * 2000, 30000);
  },
  reconnectOnError(err) {
    // Only reconnect on specific recoverable errors
    return err.message.includes('READONLY') || err.message.includes('ECONNRESET');
  },
});

// ─── REDIS CIRCUIT BREAKER ─────────────────────────────────────────────────────
// When Redis is rate-limited, skip ALL Redis calls for a cooldown period.
// This prevents log spam AND stops hammering the rate-limited Upstash (which would
// extend the rate limit duration).
let _redisCircuitOpen = false;
let _redisCircuitOpenedAt = 0;
const CIRCUIT_COOLDOWN_MS = 60_000; // Skip Redis for 60s after failure

function isRedisAvailable() {
  if (!_redisCircuitOpen) return true;
  // Check if cooldown has passed
  if (Date.now() - _redisCircuitOpenedAt > CIRCUIT_COOLDOWN_MS) {
    _redisCircuitOpen = false;
    console.log('[REDIS] Circuit breaker reset — will probe Redis on next call.');
    return true;
  }
  return false;
}

function tripCircuitBreaker(err) {
  if (!_redisCircuitOpen) {
    _redisCircuitOpen = true;
    _redisCircuitOpenedAt = Date.now();
    console.warn(`[REDIS] ⚡ Circuit breaker OPEN — skipping Redis for ${CIRCUIT_COOLDOWN_MS / 1000}s. Reason: ${err.message}`);
  }
}

redis.on('error', (err) => {
  // Only log once via circuit breaker, not on every single error
  tripCircuitBreaker(err);
});

redis.on('reconnecting', (delay) => {
  if (!_redisCircuitOpen) {
    console.warn(`[REDIS] Reconnecting in ${delay}ms...`);
  }
});

// ─── SAFE REDIS PROXY WRAPPER ──────────────────────────────────────────────────
// Instead of hardcoding wrappers for every command, we use a JS Proxy to wrap
// all method calls dynamically. This checks the circuit breaker first and catches
// rate-limit errors safely.
const FALLBACKS = {
  // Returns integer/number
  scard: 0,
  llen: 0,
  incr: null,
  decr: null,
  exists: 0,
  del: 0,
  sadd: 0,
  srem: 0,
  lpush: 0,
  rpush: 0,
  lrem: 0,
  ttl: 0,
  // Returns arrays
  smembers: [],
  lrange: [],
  keys: [],
  // Returns string / other
  get: null,
  set: 'OK',
  setex: 'OK',
  expire: 0,
  eval: null,
};

const safeRedis = new Proxy(redis, {
  get(target, prop, receiver) {
    if (prop === 'raw') return redis;
    if (prop === 'isAvailable') return isRedisAvailable;
    if (typeof prop === 'symbol') return target[prop];

    const originalValue = target[prop];
    if (typeof originalValue !== 'function') {
      return originalValue;
    }

    return async function (...args) {
      const fallbackValue = FALLBACKS[prop] !== undefined ? FALLBACKS[prop] : null;

      if (!isRedisAvailable()) {
        return fallbackValue;
      }

      try {
        return await originalValue.apply(target, args);
      } catch (err) {
        tripCircuitBreaker(err);
        return fallbackValue;
      }
    };
  }
});

// Cache global settings query in Redis with a 30-second TTL
async function getGlobalSetting(key, defaultValue = null) {
  const cacheKey = `global_setting:${key}`;
  try {
    const cached = await safeRedis.get(cacheKey);
    if (cached !== null) {
      return JSON.parse(cached);
    }
    const { rows } = await pool.query('SELECT value FROM global_settings WHERE key = $1', [key]);
    const val = rows.length ? rows[0].value : defaultValue;
    await safeRedis.setex(cacheKey, 30, JSON.stringify(val));
    return val;
  } catch (err) {
    // If even DB fails, return default
    try {
      const { rows } = await pool.query('SELECT value FROM global_settings WHERE key = $1', [key]);
      return rows.length ? rows[0].value : defaultValue;
    } catch (dbErr) {
      console.error(`[DB] DB fallback failed for ${key}:`, dbErr.message);
      return defaultValue;
    }
  }
}

module.exports = { pool, withTx, getGlobalSetting, redis: safeRedis, rawRedis: redis };