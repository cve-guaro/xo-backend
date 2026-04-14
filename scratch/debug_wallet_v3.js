
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function debug() {
  try {
    const search = '89136b-5efc-4d8a-adc7-714521ed837';
    console.log('Searching for:', search);
    
    // Explicitly searching wallet_transactions
    const { rows } = await pool.query(
      "SELECT id, provider, provider_ref, meta FROM wallet_transactions WHERE id::text LIKE $1 LIMIT 5",
      [`%${search}%`]
    );
    
    console.log('Results found:', rows.length);
    if (rows.length > 0) {
      rows.forEach(r => {
        console.log('---');
        console.log('ID:', r.id);
        console.log('Provider:', r.provider);
        console.log('Provider Ref:', r.provider_ref);
        console.log('Meta:', JSON.stringify(r.meta, null, 2));
      });
    }
  } catch (err) {
    console.error('Error:', err);
  } finally {
    await pool.end();
  }
}

debug();
