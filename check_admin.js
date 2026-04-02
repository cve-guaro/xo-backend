const { pool } = require('./src/db/index');

async function checkAdmin() {
  try {
    const { rows } = await pool.query(`
      SELECT u.username, w.available_balance, w.bonus_balance, w.withdrawable_balance
      FROM users u
      JOIN wallets w ON w.user_id = u.id
      WHERE u.username = 'admin1'
    `);
    console.log("Admin1 status:", JSON.stringify(rows[0], null, 2));

    const settings = await pool.query(`SELECT * FROM global_settings WHERE key = 'welcome_bonus_amount'`);
    console.log("Welcome Bonus Setting:", JSON.stringify(settings.rows[0], null, 2));

    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

checkAdmin();
