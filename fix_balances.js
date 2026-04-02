const { pool } = require('./src/db/index');
const crypto = require('crypto');

async function fixBalances() {
  try {
    console.log("--- SCANNING FOR FRACTIONAL BALANCES ---");
    const { rows } = await pool.query(`
      SELECT w.user_id, u.username, w.available_balance 
      FROM wallets w 
      JOIN users u ON u.id = w.user_id 
      WHERE w.available_balance > 0 AND w.available_balance < 100
    `);

    console.log(`Found ${rows.length} affected users.`);
    for (const row of rows) {
      console.log(`User: ${row.username || row.user_id} | Balance: ${row.available_balance} -> Should be ${row.available_balance * 100}`);
    }

    if (rows.length > 0) {
      const res = await pool.query(`
        UPDATE wallets SET 
          available_balance = available_balance * 100,
          bonus_balance = bonus_balance * 100
        WHERE available_balance > 0 AND available_balance < 100
        RETURNING *
      `);
      console.log(`SUCCESS: Fixed ${res.rowCount} wallets.`);
    }

    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

fixBalances();
