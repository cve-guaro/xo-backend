const { pool } = require('./src/db/index');

async function fixAdminData() {
  try {
    // 1. Correct the global setting for welcome bonus (should be 1000 = 10 Birr)
    await pool.query(`
      UPDATE global_settings 
      SET value = '1000'::jsonb 
      WHERE key = 'welcome_bonus_amount'
    `);
    console.log("Global setting fixed: welcome_bonus_amount = 1000");

    // 2. Fix admin1's balance (mistakenly set to 0.10)
    await pool.query(`
      UPDATE wallets SET 
        available_balance = available_balance * 100,
        bonus_balance = bonus_balance * 100
      WHERE user_id IN (SELECT id FROM users WHERE username = 'admin1')
      AND available_balance < 100
    `);
    console.log("Admin1 balance fixed.");

    // 3. Final check
    const { rows } = await pool.query(`
      SELECT u.username, w.available_balance 
      FROM users u JOIN wallets w ON w.user_id = u.id 
      WHERE u.username = 'admin1'
    `);
    console.log("Admin1 new state:", rows[0]);

    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

fixAdminData();
