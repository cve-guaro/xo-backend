require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

async function run() {
  try {
    const res = await pool.query('SELECT id, username, room_1_wins, r1_10_wins, r1_25_wins, r1_50_wins, r1_99_wins FROM users WHERE username ILIKE \'Yared%\'');
    console.log(res.rows);
  } catch (err) {
    console.error(err);
  } finally {
    pool.end();
  }
}

run();
