const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: "postgresql://postgres.szfphzuygiabvxtxemiy:r9Zn*Cw6@tNg2Jx@aws-1-eu-west-1.pooler.supabase.com:5432/postgres",
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const res = await fn(client);
    await client.query('COMMIT');
    return res;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { }
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { pool, withTx };