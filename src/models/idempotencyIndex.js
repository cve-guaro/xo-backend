/**
 * idempotencyIndex.js
 *
 * ledgerFirstCredit's once-only guarantee comes ENTIRELY from the unique partial
 * index uq_wallet_tx_idem on wallet_transactions(idempotency_key) WHERE status <>
 * 'FAILED' (migration 008). ON CONFLICT DO NOTHING without a target only skips a
 * row when SOME unique index would be violated — with no index, every insert
 * succeeds and every credit path double-pays (proven in
 * tests/step0_rollover_indexdep.js).
 *
 * Fail closed: checkIdempotencyIndex() runs at boot (and can be re-run by
 * tests/admin). If the index is missing or invalid, ledgerFirstCredit REFUSES
 * every credit until migration 008 is applied, and a critical system_alerts row
 * is written.
 */
const { pool } = require('../db');

let state = 'unchecked'; // 'ok' | 'missing' | 'unchecked'

async function checkIdempotencyIndex(dbPool = pool) {
  try {
    const { rows } = await dbPool.query(`
      SELECT pi.indisvalid
      FROM pg_index pi
      JOIN pg_class c ON c.oid = pi.indexrelid
      WHERE c.relname = 'uq_wallet_tx_idem'
    `);
    const ok = rows.length > 0 && rows[0].indisvalid === true;
    state = ok ? 'ok' : 'missing';
    if (!ok) {
      console.error('[IDEMPOTENCY] uq_wallet_tx_idem MISSING or INVALID — ledgerFirstCredit will REFUSE all credits (fail closed). Apply db/migrations/008_unique_idempotency_key.sql.');
      try {
        await dbPool.query(
          `INSERT INTO system_alerts (event_type, details, severity)
           VALUES ($1, $2::jsonb, 'critical')`,
          ['IDEMPOTENCY_INDEX_MISSING',
           JSON.stringify({ note: 'wallet_transactions.uq_wallet_tx_idem missing or invalid — all ledgerFirstCredit credit paths are refused until migration 008 is applied' })]
        );
      } catch (alertErr) {
        console.error('[IDEMPOTENCY] system_alerts insert failed:', alertErr.message);
      }
    } else {
      console.log('[IDEMPOTENCY] uq_wallet_tx_idem present and valid — ledger-first guards active');
    }
    return ok;
  } catch (e) {
    state = 'missing';
    console.error('[IDEMPOTENCY] index check failed:', e.message, '— refusing credits (fail closed)');
    return false;
  }
}

function idempotencyIndexOk() {
  return state !== 'missing';
}

module.exports = { checkIdempotencyIndex, idempotencyIndexOk };
