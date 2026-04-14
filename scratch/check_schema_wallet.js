
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function checkSchema() {
  try {
    const { rows } = await pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'wallet_transactions'"
    );
    console.log('Columns in wallet_transactions table:');
    console.log(rows.map(r => r.column_name).join(', '));
  } catch (err) {
    console.error('Error:', err);
  } finally {
    await pool.end();
  }
}

checkSchema();
