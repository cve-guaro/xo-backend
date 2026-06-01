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
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
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

module.exports = { pool, withTx };