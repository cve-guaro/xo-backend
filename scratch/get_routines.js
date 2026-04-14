
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function main() {
  try {
    const res = await pool.query(`
      SELECT routine_name, routine_definition 
      FROM information_schema.routines 
      WHERE routine_name IN ('fn_wallet_apply_tx', 'fn_wallet_apply_existing_tx');
    `);
    
    res.rows.forEach(r => {
      console.log(`--- ${r.routine_name} ---`);
      console.log(r.routine_definition);
    });
    
  } catch (err) {
    console.error(err);
  } finally {
    await pool.end();
  }
}

main();
