
const { Pool } = require('pg');
require('dotenv').config();

async function checkUsers() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  try {
    const res = await pool.query(`
      SELECT u.id, u.number, u.username, u.role, w.available_balance, u.created_at 
      FROM users u
      LEFT JOIN wallets w ON u.id = w.user_id
      WHERE u.username ILIKE 'Simon%' OR u.role IN ('admin', 'superadmin')
    `);
    console.log(JSON.stringify(res.rows, null, 2));
  } catch (err) {
    console.error(err);
  } finally {
    await pool.end();
  }
}

checkUsers();
