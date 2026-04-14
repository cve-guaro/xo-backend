
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function checkRef() {
  try {
    const { rows: wt } = await pool.query("SELECT provider_ref FROM wallet_transactions WHERE provider_ref IS NOT NULL AND provider_ref != 'CHAPA' LIMIT 10");
    if (wt.length > 0) {
        const refs = wt.map(r => `'${r.provider_ref}'`).join(',');
        const { rows: t } = await pool.query(`SELECT provider_ext_id FROM transactions WHERE provider_ext_id IN (${refs})`);
        console.log('Provider refs found in both tables:', t.length);
        console.log('Sample Matches:', t.map(r => r.provider_ext_id));
    } else {
        console.log('No valid provider_ref found in wallet_transactions');
    }
  } catch (err) {
    console.error('Error:', err);
  } finally {
    await pool.end();
  }
}

checkRef();
