/**
 * settleWithdrawal.js
 * 
 * Single function to settle a withdrawal: mark it COMPLETED or FAILED,
 * and refund the user if FAILED. Uses a status guard to prevent double-settlement.
 *
 * All refund paths (cron, path 5, admin reject) should go through this function.
 */
const { pool, withTx } = require('../db/index');

/**
 * Settle a withdrawal transaction.
 *
 * @param {string} txId - The wallet_transactions.id of the WITHDRAW_REQUEST
 * @param {'COMPLETED'|'FAILED'} outcome - The final status
 * @param {object} [opts]
 * @param {string} [opts.reason] - Why the withdrawal was settled (for audit)
 * @param {string} [opts.provider] - Who settled it (e.g. 'SYSTEM_AUTO_REFUND', 'ADMIN')
 * @param {object} [opts.meta] - Extra metadata for the ledger row
 * @returns {Promise<{settled: boolean, refunded: boolean, txId: string}>}
 */
async function settleWithdrawal(txId, outcome, opts = {}) {
  if (outcome !== 'COMPLETED' && outcome !== 'FAILED') {
    throw new Error(`settleWithdrawal: invalid outcome "${outcome}"`);
  }

  const reason = opts.reason || 'Unknown';
  const provider = opts.provider || 'SYSTEM_AUTO_REFUND';
  const extraMeta = opts.meta || {};

  return withTx(async (client) => {
    // 1) Lock the row and check its current status
    const { rows } = await client.query(
      `SELECT id, user_id, amount, status, tx_type FROM wallet_transactions WHERE id = $1 FOR UPDATE`,
      [txId]
    );

    if (!rows.length) {
      console.warn(`[settleWithdrawal] TX ${txId} not found`);
      return { settled: false, refunded: false, txId };
    }

    const tx = rows[0];

    // STATUS GUARD: only settle PENDING or PENDING_MANUAL rows
    if (tx.status !== 'PENDING' && tx.status !== 'PENDING_MANUAL') {
      console.warn(`[settleWithdrawal] TX ${txId} already ${tx.status}, skipping`);
      return { settled: false, refunded: false, txId };
    }

    if (tx.tx_type !== 'WITHDRAW_REQUEST') {
      console.warn(`[settleWithdrawal] TX ${txId} is ${tx.tx_type}, not WITHDRAW_REQUEST`);
      return { settled: false, refunded: false, txId };
    }

    // 2) Mark the withdrawal as settled
    await client.query(
      `UPDATE wallet_transactions SET status = $2, updated_at = now(),
       meta = COALESCE(meta, '{}'::jsonb) || $3::jsonb
       WHERE id = $1`,
      [txId, outcome, JSON.stringify({ settled_reason: reason, settled_by: provider, ...extraMeta })]
    );

    // 3) Update withdraw_requests
    const wrStatus = outcome === 'COMPLETED' ? 'PAID' : 'REJECTED';
    await client.query(
      `UPDATE withdraw_requests SET status = $2, updated_at = now() WHERE reserve_tx_id = $1`,
      [txId, wrStatus]
    );

    // 4) If FAILED, refund the user
    let refunded = false;
    if (outcome === 'FAILED') {
      const refundAmount = Number(tx.amount);
      await client.query(
        `UPDATE wallets
         SET available_balance = available_balance + $1,
             withdrawable_balance = withdrawable_balance + $1,
             updated_at = now()
         WHERE user_id = $2`,
        [refundAmount, tx.user_id]
      );

      // Audit log: use the idempotency key WITHDRAW_REFUND:{txId}
      await client.query(
        `INSERT INTO wallet_transactions (user_id, tx_type, amount, status, idempotency_key, provider, meta)
         VALUES ($1, 'REFUND', $2, 'COMPLETED', $3, $4, $5)`,
        [
          tx.user_id,
          refundAmount,
          `WITHDRAW_REFUND:${txId}`,
          provider,
          JSON.stringify({ reason, originalTxId: txId, ...extraMeta })
        ]
      );

      refunded = true;
      console.log(`[settleWithdrawal] TX ${txId} FAILED → refunded ${refundAmount} ETB to ${tx.user_id} (${reason})`);
    } else {
      console.log(`[settleWithdrawal] TX ${txId} COMPLETED (${reason})`);
    }

    return { settled: true, refunded, txId };
  });
}

module.exports = { settleWithdrawal };
