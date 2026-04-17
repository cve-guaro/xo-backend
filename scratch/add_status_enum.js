const { pool } = require('../src/db/index');
async function run() {
  try {
    await pool.query(`ALTER TYPE wallet_tx_status ADD VALUE IF NOT EXISTS 'PENDING_MANUAL'`);
    console.log('Added PENDING_MANUAL to wallet_tx_status enum.');
    // Also explicitly update any existing "PENDING" records that actually have a 'reviewReason' in their meta to 'PENDING_MANUAL'
    await pool.query(`
      UPDATE wallet_transactions
      SET status = 'PENDING_MANUAL'
      WHERE status = 'PENDING'
        AND tx_type = 'WITHDRAW_REQUEST'
        AND meta->>'reviewReason' IS NOT NULL
        AND meta->>'reviewReason' != ''
    `);
    console.log('Converted historical manual review transactions.');
  } catch(e) {
    console.error('Error:', e);
  }
  process.exit();
}
run();
