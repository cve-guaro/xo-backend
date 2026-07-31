const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/xoet_local' });

async function run() {
  try {
    const res = await pool.query(`
      SELECT id, number, username, display_name, new_user
      FROM users
      LIMIT 10;
    `);
    console.log("USERS:");
    console.log(JSON.stringify(res.rows, null, 2));
  } catch (err) {
    console.error(err);
  } finally {
    await pool.end();
  }
}

run();
