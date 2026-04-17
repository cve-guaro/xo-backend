const { pool } = require('../src/db/index');
async function fixDB() {
  try {
    await pool.query("ALTER TYPE wallet_tx_type ADD VALUE IF NOT EXISTS 'GIFT'");
    await pool.query("ALTER TYPE wallet_tx_type ADD VALUE IF NOT EXISTS 'BONUS'");
    await pool.query("ALTER TYPE wallet_tx_type ADD VALUE IF NOT EXISTS 'ADMIN_EDIT'");
    console.log('Enums added successfully.');

    // Remove the invalid withdrawable_balance that PRIZE inadvertently added
    await pool.query(`
      UPDATE wallets
      SET withdrawable_balance = GREATEST(0, withdrawable_balance - 10)
      WHERE user_id IN (
        SELECT user_id FROM wallet_transactions 
        WHERE tx_type = 'PRIZE' AND (meta->>'type' = 'LEGACY_WELCOME_BONUS' OR provider = 'GIVEAWAY')
      )
    `);
    
    // Change those transactions to GIFT so they match their intentional logic
    await pool.query(`
      UPDATE wallet_transactions
      SET tx_type = 'GIFT'
      WHERE tx_type = 'PRIZE' AND (meta->>'type' = 'LEGACY_WELCOME_BONUS' OR provider = 'GIVEAWAY')
    `);
    
    console.log('Fixed user balances and transaction types.');
  } catch(e) {
    console.error('Migration error:', e);
  }
  process.exit();
}
fixDB();
