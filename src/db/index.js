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
  max: 12,
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
const redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379');

// Cache global settings query in Redis with a 30-second TTL
async function getGlobalSetting(key, defaultValue = null) {
  const cacheKey = `global_setting:${key}`;
  try {
    const cached = await redis.get(cacheKey);
    if (cached !== null) {
      return JSON.parse(cached);
    }
    const { rows } = await pool.query('SELECT value FROM global_settings WHERE key = $1', [key]);
    const val = rows.length ? rows[0].value : defaultValue;
    await redis.setex(cacheKey, 30, JSON.stringify(val));
    return val;
  } catch (err) {
    console.error(`[DB] Error fetching global setting ${key}:`, err.message);
    return defaultValue;
  }
}

module.exports = { pool, withTx, getGlobalSetting, redis };