/**
 * verifyPendingPayouts.js
 * Cron job that runs every 15 minutes to check if pending withdrawal transfers
 * were actually delivered by Chapa. If confirmed → COMPLETED. If failed → FAILED + refund user.
 */
const { pool } = require('../db/index');
const { getChapaTransferStatus } = require('../models/Chapa');

async function verifyPendingPayouts() {
  console.log('[CRON] Verifying pending withdrawal payouts...');
  
  try {
    // Find all PENDING WITHDRAW_REQUESTs older than 2 minutes (give Chapa time to process)
    const { rows: pendingTxs } = await pool.query(`
      SELECT id, user_id, amount, meta, created_at
      FROM wallet_transactions
      WHERE tx_type = 'WITHDRAW_REQUEST'
        AND status = 'PENDING'
        AND created_at < now() - interval '2 minutes'
        AND created_at > now() - interval '48 hours'
      ORDER BY created_at ASC
      LIMIT 20
    `);

    if (pendingTxs.length === 0) {
      console.log('[CRON] No pending payouts to verify.');
      return;
    }

    console.log(`[CRON] Checking ${pendingTxs.length} pending payout(s)...`);

    for (const tx of pendingTxs) {
      try {
        const chapaStatus = await getChapaTransferStatus(tx.id);
        const status = chapaStatus?.data?.status || chapaStatus?.status;

        console.log(`[CRON VERIFY] TX ${tx.id} | Amount: ${tx.amount} ETB | Chapa status: ${status}`);

        if (status === 'success' || status === 'transferred') {
          // ✅ Chapa confirmed — mark as COMPLETED
          await pool.query(
            `UPDATE wallet_transactions SET status = 'COMPLETED', updated_at = now() WHERE id = $1`,
            [tx.id]
          );
          await pool.query(
            `UPDATE withdraw_requests SET status = 'PAID', updated_at = now() WHERE reserve_tx_id = $1`,
            [tx.id]
          );
          console.log(`[CRON] ✅ TX ${tx.id} confirmed DELIVERED — marked COMPLETED`);

        } else if (
          status === 'failed' || status === 'cancelled' ||
          status === 'rejected' || status === 'expired' ||
          status === 'failed/cancelled'
        ) {
          // ❌ Chapa failed — mark FAILED and refund the user
          const client = await pool.connect();
          try {
            await client.query('BEGIN');

            await client.query(
              `UPDATE wallet_transactions SET status = 'FAILED', updated_at = now() WHERE id = $1`,
              [tx.id]
            );
            await client.query(
              `UPDATE withdraw_requests SET status = 'REJECTED', updated_at = now() WHERE reserve_tx_id = $1`,
              [tx.id]
            );

            // Refund the balance back to the user
            const refundAmount = Number(tx.amount);
            await client.query(
              `UPDATE wallets
               SET available_balance = available_balance + $1,
                   withdrawable_balance = withdrawable_balance + $1,
                   updated_at = now()
               WHERE user_id = $2`,
              [refundAmount, tx.user_id]
            );

            // Audit log entry
            await client.query(
              `INSERT INTO wallet_transactions (user_id, tx_type, amount, status, idempotency_key, provider, meta)
               VALUES ($1, 'REFUND', $2, 'COMPLETED', $3, 'SYSTEM_AUTO_REFUND', $4)`,
              [
                tx.user_id,
                refundAmount,
                `AUTO_REFUND:${tx.id}`,
                JSON.stringify({ reason: `Chapa transfer ${status}`, originalTxId: tx.id })
              ]
            );

            await client.query('COMMIT');
            console.log(`[CRON] ❌ TX ${tx.id} FAILED in Chapa — refunded ${refundAmount} ETB to user ${tx.user_id}`);
          } catch (err) {
            await client.query('ROLLBACK');
            console.error(`[CRON] Refund transaction failed for TX ${tx.id}:`, err.message);
          } finally {
            client.release();
          }
        } else {
          // Still pending or processing — leave it and check again next cycle
          console.log(`[CRON] ⏳ TX ${tx.id} still pending in Chapa (status: ${status || 'unknown'})`);
        }

        // Small delay between Chapa API calls to avoid rate limiting
        await new Promise(r => setTimeout(r, 500));

      } catch (txErr) {
        console.error(`[CRON] Error verifying TX ${tx.id}:`, txErr.message);
      }
    }

    console.log('[CRON] Payout verification cycle complete.');
  } catch (err) {
    console.error('[CRON] verifyPendingPayouts fatal error:', err.message);
  }
}

module.exports = { verifyPendingPayouts };
