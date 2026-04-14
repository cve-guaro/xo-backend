
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function checkIdem() {
  try {
    const { rows: wt } = await pool.query("SELECT idempotency_key FROM wallet_transactions WHERE tx_type = 'DEPOSIT' AND idempotency_key IS NOT NULL LIMIT 10");
    if (wt.length > 0) {
        const keys = wt.map(r => `'${r.idempotency_key}'`).join(',');
        const { rows: t } = await pool.query(`SELECT idempotency_key FROM transactions WHERE idempotency_key IN (${keys})`);
        console.log('Idempotency keys found in both tables:', t.length);
        console.log('Sample Matches:', t.map(r => r.idempotency_key));
    } else {
        console.log('No idempotency keys found in wallet_transactions');
    }
  } catch (err) {
    console.error('Error:', err);
  } finally {
    await pool.end();
  }
}

checkIdem();
