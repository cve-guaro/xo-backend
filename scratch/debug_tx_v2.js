
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
    
    const { rows } = await pool.query(
      "SELECT id, provider_id, status, metadata FROM transactions WHERE id::text LIKE $1 LIMIT 5",
      [`%${search}%`]
    );
    
    console.log('Results found:', rows.length);
    if (rows.length > 0) {
      rows.forEach(r => {
        console.log('---');
        console.log('ID:', r.id);
        console.log('Provider ID:', r.provider_id);
        console.log('Metadata:', JSON.stringify(r.metadata, null, 2));
      });
    }
  } catch (err) {
    console.error('Error:', err);
  } finally {
    await pool.end();
  }
}

debug();
