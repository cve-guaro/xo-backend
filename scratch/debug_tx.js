
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
      "SELECT id, provider_ref, tx_ref, provider_payload FROM transactions WHERE id::text LIKE $1 OR tx_ref LIKE $1",
      [`%${search}%`]
    );
    
    console.log('Results found:', rows.length);
    if (rows.length > 0) {
      rows.forEach(r => {
        console.log('---');
        console.log('ID:', r.id);
        console.log('Provider Ref:', r.provider_ref);
        console.log('TX Ref:', r.tx_ref);
        console.log('Payload:', JSON.stringify(r.provider_payload, null, 2));
      });
    } else {
        // Try a broader search with just part of the ID
        const part = '89136b';
        console.log('Broad search for:', part);
        const res2 = await pool.query(
            "SELECT id, provider_ref, tx_ref, provider_payload FROM transactions WHERE id::text LIKE $1 OR tx_ref LIKE $1 LIMIT 5",
            [`%${part}%`]
        );
        console.log('Broad results found:', res2.rows.length);
        res2.rows.forEach(r => {
            console.log('---');
            console.log('ID:', r.id);
            console.log('Provider Ref:', r.provider_ref);
            console.log('TX Ref:', r.tx_ref);
            console.log('Payload:', JSON.stringify(r.provider_payload, null, 2));
        });
    }
  } catch (err) {
    console.error('Error:', err);
  } finally {
    await pool.end();
  }
}

debug();
