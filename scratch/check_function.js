
const { Pool } = require('pg');
require('dotenv').config();

async function checkFunction() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  try {
    const res = await pool.query(`
      SELECT routine_definition 
      FROM information_schema.routines 
      WHERE routine_name = 'fn_wallet_apply_tx';
    `);
    console.log(res.rows[0].routine_definition);
  } catch (err) {
    console.error(err);
  } finally {
    await pool.end();
  }
}

checkFunction();
