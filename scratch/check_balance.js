require('dotenv').config();
const { pool } = require('./src/db/index');

async function checkUser(username) {
  const { rows } = await pool.query(`
    SELECT u.username, w.available_balance, w.withdrawable_balance, w.bonus_balance 
    FROM wallets w JOIN users u ON w.user_id = u.id 
    WHERE u.username = $1 OR u.number = $1
  `, [username]);
  console.log(rows);
  process.exit(0);
}

checkUser(process.argv[2]);
