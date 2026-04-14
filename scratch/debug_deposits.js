
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function debug() {
  try {
    console.log('Fetching recent deposits...');
    
    // Explicitly searching wallet_transactions
    const { rows } = await pool.query(
      "SELECT id, provider, provider_ref, meta FROM wallet_transactions WHERE tx_type = 'DEPOSIT' ORDER BY created_at DESC LIMIT 10"
    );
    
    console.log('Results found:', rows.length);
    rows.forEach(r => {
      console.log('---');
      console.log('ID:', r.id);
      console.log('Provider:', r.provider);
      console.log('Provider Ref:', r.provider_ref);
      console.log('Meta Keys:', r.meta ? Object.keys(r.meta) : 'null');
      if (r.meta) {
        // Look for reference in common Chapa payload locations
        const m = r.meta;
        const ref = m.reference || m.tx_ref || (m.data && m.data.reference) || (m.data && m.data.tx_ref);
        console.log('Found Reference in Meta:', ref);
      }
    });
  } catch (err) {
    console.error('Error:', err);
  } finally {
    await pool.end();
  }
}

debug();
