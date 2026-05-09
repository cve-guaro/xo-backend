/**
 * verifyPendingDeposits.js
 * Cron job that runs every 30 minutes to check if pending deposit payments
 * were actually paid by the user via Chapa. If confirmed → COMPLETED + credit wallet.
 * If older than 72 hours and still pending → mark as EXPIRED.
 */
const { pool } = require('../db/index');
const { verifyTx } = require('../models/Chapa');
const { completeDeposit } = require('../models/payments.service');

async function verifyPendingDeposits() {
  console.log('[CRON] Verifying pending deposit payments...');
  
  try {
    // 1) Auto-expire deposits older than 1 hour — user never completed checkout (clicked X or abandoned)
    const { rowCount: expiredCount } = await pool.query(`
      UPDATE wallet_transactions
      SET status = 'FAILED', 
          updated_at = now(),
          meta = COALESCE(meta, '{}'::jsonb) || '{"failed_reason": "Auto-expired — user never completed Chapa checkout"}'::jsonb
      WHERE tx_type = 'DEPOSIT'
        AND status = 'PENDING'
        AND created_at < now() - interval '5 minutes'
    `);
    if (expiredCount > 0) {
      console.log(`[CRON] 🗑️ Auto-expired ${expiredCount} abandoned deposits (older than 1 hour).`);
    }

    // 2) Find pending deposits between 2 minutes and 1 hour old
    const { rows: pendingDeposits } = await pool.query(`
      SELECT id, user_id, amount, created_at
      FROM wallet_transactions
      WHERE tx_type = 'DEPOSIT'
        AND status = 'PENDING'
        AND created_at < now() - interval '30 seconds'
        AND created_at > now() - interval '5 minutes'
      ORDER BY created_at ASC
      LIMIT 30
    `);

    if (pendingDeposits.length === 0) {
      console.log('[CRON] No pending deposits to verify.');
      return;
    }

    console.log(`[CRON] Checking ${pendingDeposits.length} pending deposit(s) against Chapa...`);

    let completedCount = 0;
    let failedCount = 0;

    for (const tx of pendingDeposits) {
      try {
        // Query Chapa to see if this deposit was actually paid
        const chapaResult = await verifyTx(tx.id);
        const chapaStatus = chapaResult?.data?.status || chapaResult?.status;

        console.log(`[CRON DEPOSIT] TX ${tx.id} | Amount: ${tx.amount} ETB | Chapa status: ${chapaStatus || 'unknown'}`);

        if (chapaStatus === 'success') {
          // ✅ User actually paid — complete the deposit and credit wallet
          try {
            await completeDeposit(tx.id, 'CHAPA', null);
            completedCount++;
            console.log(`[CRON] ✅ Deposit ${tx.id} verified as PAID — wallet credited.`);
          } catch (completeErr) {
            // Likely already completed by webhook concurrently — safe to ignore
            if (completeErr.message && completeErr.message.includes('already')) {
              console.log(`[CRON] Deposit ${tx.id} was already completed (idempotency OK).`);
            } else {
              console.error(`[CRON] Error completing deposit ${tx.id}:`, completeErr.message);
            }
          }
        } else if (chapaStatus && (chapaStatus.includes('fail') || chapaStatus.includes('expired') || chapaStatus.includes('cancel'))) {
          // ❌ Chapa confirmed it failed/cancelled — mark as FAILED
          await pool.query(`
            UPDATE wallet_transactions 
            SET status = 'FAILED', 
                updated_at = now(),
                meta = COALESCE(meta, '{}'::jsonb) || $2::jsonb
            WHERE id = $1 AND status = 'PENDING'
          `, [tx.id, JSON.stringify({ chapa_status: chapaStatus, verified_by: 'cron_auto' })]);
          failedCount++;
          console.log(`[CRON] ❌ Deposit ${tx.id} confirmed FAILED by Chapa (status: ${chapaStatus}).`);
        } else {
          // Still pending or unknown — leave it for next cycle
          console.log(`[CRON] ⏳ Deposit ${tx.id} still pending in Chapa (status: ${chapaStatus || 'unknown'}).`);
        }

        // Small delay between Chapa API calls to avoid rate limiting
        await new Promise(r => setTimeout(r, 600));

      } catch (txErr) {
        // Chapa may return 404 for tx_refs it doesn't recognize — that's OK
        if (txErr.status === 404 || (txErr.message && txErr.message.includes('404'))) {
          console.log(`[CRON] Deposit ${tx.id} not found in Chapa (likely never initiated or expired).`);
        } else {
          console.error(`[CRON] Error verifying deposit ${tx.id}:`, txErr.message);
        }
      }
    }

    console.log(`[CRON] Deposit verification complete: ${completedCount} completed, ${failedCount} failed.`);
  } catch (err) {
    console.error('[CRON] verifyPendingDeposits fatal error:', err.message);
  }
}

module.exports = { verifyPendingDeposits };
