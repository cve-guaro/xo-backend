/**
 * verifyPendingPayouts.js
 * Cron job that runs every 2 minutes to check if pending withdrawal transfers
 * were actually delivered by Chapa. If confirmed → COMPLETED. If failed → FAILED + refund user.
 *
 * Uses settleWithdrawal for all settlement paths to prevent double-refunds.
 */
const { pool } = require('../db/index');
const { getChapaTransferStatus } = require('../models/Chapa');
const { sendWithdrawalSMS } = require('../utils/sms');
const { settleWithdrawal } = require('../models/settleWithdrawal');

// Module-level guard: prevents overlapping cron runs
let isRunning = false;

async function verifyPendingPayouts() {
  if (isRunning) {
    console.log('[CRON] verifyPendingPayouts already running, skipping');
    return;
  }
  isRunning = true;

  try {
    // Find all PENDING WITHDRAW_REQUESTs older than 10 seconds (give Chapa time to process)
    // FOR UPDATE SKIP LOCKED prevents double-processing if two workers run concurrently
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

    if (pendingTxs.length > 0) {
      console.log(`[CRON] Checking ${pendingTxs.length} pending payout(s)...`);
    }

    for (const tx of pendingTxs) {
      try {
        const chapaStatus = await getChapaTransferStatus(tx.id);
        const status = chapaStatus?.data?.status || chapaStatus?.status;

        console.log(`[CRON VERIFY] TX ${tx.id} | Amount: ${tx.amount} ETB | Chapa status: ${status}`);

        if (status === 'success' || status === 'transferred') {
          // ✅ Chapa confirmed — mark as COMPLETED
          const result = await settleWithdrawal(tx.id, 'COMPLETED', {
            reason: `Chapa transfer ${status}`,
            provider: 'CHAPA_VERIFIED'
          });

          if (result.settled) {
            console.log(`[CRON] ✅ TX ${tx.id} confirmed DELIVERED — marked COMPLETED`);

            // Send SMS notification to user
            try {
              const userRow = await pool.query('SELECT number, display_name, username FROM users WHERE id = $1', [tx.user_id]);
              const phone = userRow.rows[0]?.number;
              const uname = userRow.rows[0]?.display_name || userRow.rows[0]?.username;
              if (phone) sendWithdrawalSMS(phone, Number(tx.amount), uname).catch(e => console.error('[SMS]', e.message));
            } catch (smsErr) { /* non-critical */ }
          } else {
            // Row already settled (e.g. refunded after 3×404) but Chapa now reports success.
            // The transfer may have been delivered AFTER the refund — money may have left
            // the platform twice. Never credit again here; raise an alert for manual review.
            console.error(`[CRON] ⚠️ TX ${tx.id}: Chapa reports "${status}" but the row is already settled — raising PAYOUT_LATE_SUCCESS alert`);
            try {
              await pool.query(
                `INSERT INTO system_alerts (event_type, details, severity)
                 VALUES ($1, $2::jsonb, 'critical')`,
                ['PAYOUT_LATE_SUCCESS',
                 JSON.stringify({ txId: tx.id, userId: tx.user_id, amount: tx.amount, chapa_status: status,
                   note: 'Withdrawal was settled (likely refunded) but Chapa now reports success' })]
              );
            } catch (alertErr) { console.error('[CRON] system_alerts insert failed:', alertErr.message); }
          }

        } else if (
          status === 'failed' || status === 'cancelled' ||
          status === 'rejected' || status === 'expired' ||
          status === 'failed/cancelled'
        ) {
          // ❌ Chapa confirmed failure — refund via settleWithdrawal
          const result = await settleWithdrawal(tx.id, 'FAILED', {
            reason: `Chapa transfer ${status}`,
            provider: 'SYSTEM_AUTO_REFUND',
            meta: { chapa_status: status }
          });
          if (result.refunded) {
            console.log(`[CRON] ❌ TX ${tx.id} FAILED in Chapa — refunded ${tx.amount} ETB to user ${tx.user_id}`);
          }

        } else {
          // Still pending or processing — check if it's stuck (older than 30 minutes)
          const ageMinutes = (Date.now() - new Date(tx.created_at).getTime()) / 1000 / 60;
          if (ageMinutes > 30) {
            console.log(`[CRON] ⛔ TX ${tx.id} stuck in ${status || 'pending'} status for ${Math.round(ageMinutes)} mins. Marking FAILED and refunding.`);
            const result = await settleWithdrawal(tx.id, 'FAILED', {
              reason: `Stuck in Chapa ${status || 'pending'} status for ${Math.round(ageMinutes)} min`,
              provider: 'SYSTEM_AUTO_REFUND',
              meta: { stuck_status: status, age_minutes: Math.round(ageMinutes) }
            });
            if (result.refunded) {
              console.log(`[CRON] ✅ Refunded ${tx.amount} ETB to user ${tx.user_id} (TX ${tx.id} — Chapa stuck)`);
            }
          } else {
            console.log(`[CRON] ⏳ TX ${tx.id} still pending in Chapa (status: ${status || 'unknown'}, age: ${Math.round(ageMinutes)} mins)`);
          }
        }

        // Small delay between Chapa API calls to avoid rate limiting
        await new Promise(r => setTimeout(r, 200));

      } catch (txErr) {
        // Chapa returns 404 "Transfer is not found" — track retries and refund after 3
        if (txErr.status === 404 || (txErr.message && txErr.message.includes('not found'))) {
          const meta = typeof tx.meta === 'string' ? JSON.parse(tx.meta || '{}') : (tx.meta || {});
          const retries = (meta.chapa_404_retries || 0) + 1;
          
          if (retries >= 3) {
            // Transfer never existed in Chapa — refund via settleWithdrawal
            console.log(`[CRON] ⛔ TX ${tx.id} — Chapa returned 404 three times. Marking FAILED and refunding.`);
            const result = await settleWithdrawal(tx.id, 'FAILED', {
              reason: 'Chapa transfer not found after 3 retries',
              provider: 'SYSTEM_AUTO_REFUND',
              meta: { chapa_404_retries: retries }
            });
            if (result.refunded) {
              console.log(`[CRON] ✅ Refunded ${tx.amount} ETB to user ${tx.user_id} (TX ${tx.id} — Chapa 404)`);
            }
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

    // ── Late-success sweep ──
    // Withdrawals refunded after 3×404 may in fact have been delivered later.
    // The pending loop never sees FAILED rows, so check each recently-refunded
    // row ONCE against Chapa. If Chapa reports success the money left the
    // platform AND the user was refunded — never credit again, raise an alert
    // for manual reconciliation instead.
    const { rows: refunded } = await pool.query(`
      SELECT id, user_id, amount
      FROM wallet_transactions
      WHERE tx_type = 'WITHDRAW_REQUEST'
        AND status = 'FAILED'
        AND updated_at > now() - interval '48 hours'
        AND COALESCE(meta->>'late_success_checked', 'false') = 'false'
      ORDER BY updated_at ASC
      LIMIT 20
    `);
    for (const tx of refunded) {
      try {
        const chapaStatus = await getChapaTransferStatus(tx.id);
        const status = chapaStatus?.data?.status || chapaStatus?.status;
        if (status === 'success' || status === 'transferred') {
          console.error(`[CRON] ⚠️ TX ${tx.id}: refunded but Chapa reports "${status}" — raising PAYOUT_LATE_SUCCESS alert`);
          try {
            await pool.query(
              `INSERT INTO system_alerts (event_type, details, severity)
               VALUES ($1, $2::jsonb, 'critical')`,
              ['PAYOUT_LATE_SUCCESS',
               JSON.stringify({ txId: tx.id, userId: tx.user_id, amount: tx.amount, chapa_status: status,
                 note: 'Withdrawal was refunded but the Chapa transfer was delivered' })]
            );
          } catch (alertErr) { console.error('[CRON] system_alerts insert failed:', alertErr.message); }
        }
      } catch (chkErr) {
        // 404 (transfer never existed) or transient error — nothing to escalate here
      }
      // Mark checked either way so each refunded row is queried at most once
      await pool.query(
        `UPDATE wallet_transactions SET meta = COALESCE(meta, '{}'::jsonb) || $2::jsonb WHERE id = $1`,
        [tx.id, JSON.stringify({ late_success_checked: true })]
      );
    }

    if (pendingTxs.length > 0 || refunded.length > 0) {
      console.log('[CRON] Payout verification cycle complete.');
    }
  } catch (err) {
    console.error('[CRON] verifyPendingPayouts fatal error:', err.message);
  } finally {
    isRunning = false;
  }
}

module.exports = { verifyPendingPayouts };
