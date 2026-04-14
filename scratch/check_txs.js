
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function checkTxs() {
  try {
    const { rows } = await pool.query(
        "SELECT id, provider_ext_id, metadata, created_at FROM transactions WHERE provider_ext_id IS NOT NULL LIMIT 5"
    );
    console.log('Sample transactions with provider_ext_id:', rows.length);
    rows.forEach(r => {
        console.log('---');
        console.log('ID:', r.id);
        console.log('Provider Ext ID:', r.provider_ext_id);
    });
  } catch (err) {
    console.error('Error:', err);
  } finally {
    await pool.end();
  }
}

checkTxs();
