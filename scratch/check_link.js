
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function checkLink() {
  try {
    // Get recent wallet_transactions
    const { rows: wt } = await pool.query("SELECT id FROM wallet_transactions LIMIT 5");
    if (wt.length > 0) {
        const ids = wt.map(r => `'${r.id}'`).join(',');
        const { rows: t } = await pool.query(`SELECT id FROM transactions WHERE id IN (${ids})`);
        console.log('IDs found in both tables:', t.map(r => r.id).length);
        console.log('Matches:', t.map(r => r.id));
    }
  } catch (err) {
    console.error('Error:', err);
  } finally {
    await pool.end();
  }
}

checkLink();
