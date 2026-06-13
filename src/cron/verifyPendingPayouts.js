/**
 * verifyPendingPayouts.js
 * Cron job that runs every 15 minutes to check if pending withdrawal transfers
 * were actually delivered by Chapa. If confirmed → COMPLETED. If failed → FAILED + refund user.
 */
const { pool } = require('../db/index');
const { getChapaTransferStatus } = require('../models/Chapa');
const { sendWithdrawalSMS } = require('../utils/sms');

async function verifyPendingPayouts() {
  console.log('[CRON] Verifying pending withdrawal payouts...');
  
  try {
    // Find all PENDING WITHDRAW_REQUESTs older than 10 seconds (give Chapa time to process)
    // FOR UPDATE SKIP LOCKED prevents double-refund if two cron workers run concurrently
    const { rows: pendingTxs } = await pool.query(`
      SELECT id, user_id, amount, meta, created_at
      FROM wallet_transactions
      WHERE tx_type = 'WITHDRAW_REQUEST'
        AND status = 'PENDING'
        AND created_at < now() - interval '10 seconds'
        AND created_at > now() - interval '48 hours'
      ORDER BY created_at ASC
      LIMIT 20
      FOR UPDATE SKIP LOCKED
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

          // Send SMS notification to user
          try {
            const userRow = await pool.query('SELECT number, display_name, username FROM users WHERE id = $1', [tx.user_id]);
            const phone = userRow.rows[0]?.number;
            const uname = userRow.rows[0]?.display_name || userRow.rows[0]?.username;
            if (phone) sendWithdrawalSMS(phone, Number(tx.amount), uname).catch(e => console.error('[SMS]', e.message));
          } catch (smsErr) { /* non-critical */ }

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
          // Still pending or processing — check if it's stuck (older than 30 minutes)
          const ageMinutes = (Date.now() - new Date(tx.created_at).getTime()) / 1000 / 60;
          if (ageMinutes > 30) {
            console.log(`[CRON] ⛔ TX ${tx.id} stuck in ${status || 'pending'} status for ${Math.round(ageMinutes)} mins. Marking FAILED and refunding.`);
            const client = await pool.connect();
            try {
              await client.query('BEGIN');
              await client.query(
                `UPDATE wallet_transactions SET status = 'FAILED', updated_at = now(),
                 meta = COALESCE(meta, '{}'::jsonb) || $2::jsonb
                 WHERE id = $1`,
                [tx.id, JSON.stringify({ failed_reason: `Stuck in Chapa ${status || 'pending'} status for too long`, stuck_status: status })]
              );
              await client.query(
                `UPDATE withdraw_requests SET status = 'REJECTED', updated_at = now() WHERE reserve_tx_id = $1`,
                [tx.id]
              );
              const refundAmount = Number(tx.amount);
              await client.query(
                `UPDATE wallets SET available_balance = available_balance + $1, withdrawable_balance = withdrawable_balance + $1, updated_at = now() WHERE user_id = $2`,
                [refundAmount, tx.user_id]
              );
              await client.query(
                `INSERT INTO wallet_transactions (user_id, tx_type, amount, status, idempotency_key, provider, meta)
                 VALUES ($1, 'REFUND', $2, 'COMPLETED', $3, 'SYSTEM_AUTO_REFUND', $4)`,
                [tx.user_id, refundAmount, `AUTO_REFUND_STUCK:${tx.id}`, JSON.stringify({ reason: `Stuck in Chapa ${status || 'pending'} status`, originalTxId: tx.id })]
              );
              await client.query('COMMIT');
              console.log(`[CRON] ✅ Refunded ${refundAmount} ETB to user ${tx.user_id} (TX ${tx.id} — Chapa stuck)`);
            } catch (err) {
              await client.query('ROLLBACK');
              console.error(`[CRON] Refund failed for stuck TX ${tx.id}:`, err.message);
            } finally {
              client.release();
            }
          } else {
            console.log(`[CRON] ⏳ TX ${tx.id} still pending in Chapa (status: ${status || 'unknown'}, age: ${Math.round(ageMinutes)} mins)`);
          }
        }

        // Small delay between Chapa API calls to avoid rate limiting
        await new Promise(r => setTimeout(r, 200));

      } catch (txErr) {
        // Chapa returns 404 "Transfer is not found" — track retries and stop after 3
        if (txErr.status === 404 || (txErr.message && txErr.message.includes('not found'))) {
          const meta = typeof tx.meta === 'string' ? JSON.parse(tx.meta || '{}') : (tx.meta || {});
          const retries = (meta.chapa_404_retries || 0) + 1;
          
          if (retries >= 3) {
            // Transfer never existed in Chapa — refund user and stop retrying
            console.log(`[CRON] ⛔ TX ${tx.id} — Chapa returned 404 three times. Marking FAILED and refunding.`);
            const client = await pool.connect();
            try {
              await client.query('BEGIN');
              await client.query(
                `UPDATE wallet_transactions SET status = 'FAILED', updated_at = now(), 
                 meta = COALESCE(meta, '{}'::jsonb) || $2::jsonb
                 WHERE id = $1`,
                [tx.id, JSON.stringify({ failed_reason: 'Chapa transfer not found after 3 retries', chapa_404_retries: retries })]
              );
              await client.query(
                `UPDATE withdraw_requests SET status = 'REJECTED', updated_at = now() WHERE reserve_tx_id = $1`,
                [tx.id]
              );
              const refundAmount = Number(tx.amount);
              await client.query(
                `UPDATE wallets SET available_balance = available_balance + $1, withdrawable_balance = withdrawable_balance + $1, updated_at = now() WHERE user_id = $2`,
                [refundAmount, tx.user_id]
              );
              await client.query(
                `INSERT INTO wallet_transactions (user_id, tx_type, amount, status, idempotency_key, provider, meta)
                 VALUES ($1, 'REFUND', $2, 'COMPLETED', $3, 'SYSTEM_AUTO_REFUND', $4)`,
                [tx.user_id, refundAmount, `AUTO_REFUND_404:${tx.id}`, JSON.stringify({ reason: 'Chapa transfer not found', originalTxId: tx.id })]
              );
              await client.query('COMMIT');
              console.log(`[CRON] ✅ Refunded ${refundAmount} ETB to user ${tx.user_id} (TX ${tx.id} — Chapa 404)`);
            } catch (err) {
              await client.query('ROLLBACK');
              console.error(`[CRON] Refund failed for TX ${tx.id}:`, err.message);
            } finally { client.release(); }
          } else {
            // Increment retry counter and check again next cycle
            await pool.query(
              `UPDATE wallet_transactions SET meta = COALESCE(meta, '{}'::jsonb) || $2::jsonb WHERE id = $1`,
              [tx.id, JSON.stringify({ chapa_404_retries: retries })]
            );
            console.log(`[CRON] ⏳ TX ${tx.id} — Chapa 404, retry ${retries}/3. Will check again next cycle.`);
          }
        } else {
          console.error(`[CRON] Error verifying TX ${tx.id}:`, txErr.message);
        }
      }
    }

    console.log('[CRON] Payout verification cycle complete.');
  } catch (err) {
    console.error('[CRON] verifyPendingPayouts fatal error:', err.message);
  }
}

module.exports = { verifyPendingPayouts };
