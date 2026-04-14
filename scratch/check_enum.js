
const { Pool } = require('pg');
require('dotenv').config();

async function checkEnum() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  try {
    const res = await pool.query(`
      SELECT enumlabel 
      FROM pg_enum 
      JOIN pg_type ON pg_enum.enumtypid = pg_type.oid 
      WHERE typname = 'wallet_tx_type';
    `);
    console.log('Enum Values:', res.rows.map(r => r.enumlabel));
  } catch (err) {
    console.error(err);
  } finally {
    await pool.end();
  }
}

checkEnum();
