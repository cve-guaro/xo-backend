require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 30000
});

async function auditRefunds() {
  try {
    // 1) Find ALL failed/rejected withdrawals
    const { rows: failedWithdrawals } = await pool.query(`
      SELECT t.id, t.user_id, u.username, t.amount, t.status, t.created_at
      FROM wallet_transactions t
      JOIN users u ON t.user_id = u.id
      WHERE t.tx_type = 'WITHDRAW_REQUEST' 
      AND t.status = 'FAILED'
      ORDER BY t.created_at DESC
    `);

    console.log(`\n=== ALL FAILED/REJECTED WITHDRAWALS ===`);
    console.log(`Total: ${failedWithdrawals.length}\n`);
    console.table(failedWithdrawals.map(r => ({
      tx_id: r.id.slice(0,8) + '...',
      user: r.username,
      amount: r.amount + ' ETB',
      status: r.status,
      date: r.created_at.toISOString().slice(0,16)
    })));

    // 2) Find ALL refunds that were successfully applied
    const { rows: refunds } = await pool.query(`
      SELECT t.id, t.user_id, u.username, t.amount, t.status, t.created_at
      FROM wallet_transactions t
      JOIN users u ON t.user_id = u.id
      WHERE t.tx_type = 'REFUND' AND t.status = 'COMPLETED'
      ORDER BY t.created_at DESC
    `);

    console.log(`\n=== SUCCESSFUL REFUNDS APPLIED ===`);
    console.log(`Total: ${refunds.length}\n`);
    console.table(refunds.map(r => ({
      tx_id: r.id.slice(0,8) + '...',
      user: r.username,
      amount: r.amount + ' ETB',
      date: r.created_at.toISOString().slice(0,16)
    })));

    // 3) Cross-check: Find users who had FAILED withdrawals but NO matching refund
    const refundedUserAmounts = new Set(
      refunds.map(r => `${r.user_id}|${r.amount}`)
    );

    // More precise: check by looking at refund idempotency keys that reference the failed tx
    const { rows: refundKeys } = await pool.query(`
      SELECT idempotency_key FROM wallet_transactions WHERE tx_type = 'REFUND'
    `);
    const refundedTxIds = new Set(
      refundKeys.map(r => {
        // idempotency_key format: AUTO_REFUND:<original_tx_id>
        const match = (r.idempotency_key || '').match(/AUTO_REFUND:(.+)/);
        return match ? match[1] : null;
      }).filter(Boolean)
    );

    const unrefunded = failedWithdrawals.filter(fw => !refundedTxIds.has(fw.id));

    console.log(`\n=== ⚠️ UNREFUNDED FAILED WITHDRAWALS (Money stuck!) ===`);
    console.log(`Total: ${unrefunded.length}\n`);
    if (unrefunded.length > 0) {
      console.table(unrefunded.map(r => ({
        tx_id: r.id,
        user_id: r.user_id,
        user: r.username,
        amount: r.amount + ' ETB',
        status: r.status,
        date: r.created_at.toISOString().slice(0,16)
      })));

      // Sum up
      const totalStuck = unrefunded.reduce((sum, r) => sum + Number(r.amount), 0);
      console.log(`\nTOTAL STUCK MONEY: ${totalStuck} ETB across ${new Set(unrefunded.map(r=>r.username)).size} users`);
    } else {
      console.log('✅ All failed withdrawals have been properly refunded!');
    }

    // 4) Also check for PENDING withdrawals still hanging
    const { rows: pending } = await pool.query(`
      SELECT t.id, t.user_id, u.username, t.amount, t.status, t.created_at
      FROM wallet_transactions t
      JOIN users u ON t.user_id = u.id
      WHERE t.tx_type = 'WITHDRAW_REQUEST' AND t.status = 'PENDING'
      ORDER BY t.created_at DESC
    `);

    console.log(`\n=== STILL PENDING (Waiting for Chapa) ===`);
    console.log(`Total: ${pending.length}\n`);
    if (pending.length > 0) {
      console.table(pending.map(r => ({
        tx_id: r.id,
        user: r.username,
        amount: r.amount + ' ETB',
        date: r.created_at.toISOString().slice(0,16)
      })));
    } else {
      console.log('✅ No pending withdrawals hanging.');
    }

  } catch (e) {
    console.error("Error:", e);
  } finally {
    await pool.end();
  }
}

auditRefunds();
