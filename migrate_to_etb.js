// EMERGENCY DB MIGRATION
// Converts all monetary values from CENTS to whole ETB
// This makes the live production mobile app show correct values
// Run ONCE only with: node migrate_to_etb.js

const { pool } = require('./src/db/index');

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    console.log('=== XOET DB MIGRATION: Cents → Whole ETB ===\n');

    // 1. Check current state before migrating
    const walletCheck = await client.query('SELECT COUNT(*), AVG(available_balance), MAX(available_balance) FROM wallets');
    console.log('BEFORE - Wallets:', walletCheck.rows[0]);

    const txCheck = await client.query('SELECT COUNT(*), AVG(amount), MAX(amount) FROM payment_transactions');
    console.log('BEFORE - Transactions:', txCheck.rows[0]);

    const gameCheck = await client.query('SELECT COUNT(*), AVG(bet_amount), MAX(bet_amount) FROM games WHERE bet_amount > 0');
    console.log('BEFORE - Games:', gameCheck.rows[0]);

    console.log('\nApplying migration...');

    // 2. Divide wallets balances by 100
    const walletRes = await client.query(`
      UPDATE wallets 
      SET available_balance    = ROUND(available_balance    / 100.0),
          withdrawable_balance = ROUND(withdrawable_balance / 100.0),
          bonus_balance        = ROUND(bonus_balance        / 100.0)
    `);
    console.log(`✓ Updated ${walletRes.rowCount} wallet rows`);

    // 3. Divide payment_transactions amounts by 100
    const txRes = await client.query(`
      UPDATE payment_transactions 
      SET amount = ROUND(amount / 100.0)
    `);
    console.log(`✓ Updated ${txRes.rowCount} payment_transaction rows`);

    // 4. Divide games bet_amount by 100
    const gamesRes = await client.query(`
      UPDATE games 
      SET bet_amount = ROUND(bet_amount / 100.0)
      WHERE bet_amount > 0
    `);
    console.log(`✓ Updated ${gamesRes.rowCount} game rows`);

    // 5. Verify after migration
    const walletAfter = await client.query('SELECT COUNT(*), AVG(available_balance), MAX(available_balance) FROM wallets');
    console.log('\nAFTER - Wallets:', walletAfter.rows[0]);

    const txAfter = await client.query('SELECT COUNT(*), AVG(amount), MAX(amount) FROM payment_transactions');
    console.log('AFTER - Transactions:', txAfter.rows[0]);

    const gameAfter = await client.query('SELECT COUNT(*), AVG(bet_amount), MAX(bet_amount) FROM games WHERE bet_amount > 0');
    console.log('AFTER - Games:', gameAfter.rows[0]);

    await client.query('COMMIT');
    console.log('\n✅ Migration complete! All values are now in whole ETB.');
    console.log('Production mobile app will now show correct balances.');

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Migration FAILED - rolled back:', err.message);
    throw err;
  } finally {
    client.release();
    pool.end();
  }
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
