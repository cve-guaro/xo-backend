require('dotenv').config();
const { pool } = require('../src/db/index');

async function checkUser(username) {
  try {
    const { rows } = await pool.query(`
      SELECT w.available_balance, w.withdrawable_balance, w.bonus_balance 
      FROM wallets w JOIN users u ON w.user_id = u.id 
      WHERE u.username = $1 OR u.number = $1
    `, [username]);
    console.log("Raw DB for", username, ":", rows[0]);
  } catch(e) {
    console.error(e);
  } finally {
    process.exit(0);
  }
}

checkUser(process.argv[2]);
