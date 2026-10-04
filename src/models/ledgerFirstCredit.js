/**
 * ledgerFirstCredit.js
 *
 * Ledger-first credit primitive: write the wallet_transactions ledger row FIRST
 * (ON CONFLICT DO NOTHING, no target) and only credit the wallet if a ledger row
 * was actually inserted. A replayed operation (cron retry, double-click,
 * parallel request) loses the INSERT race and credits nothing.
 *
 * IMPORTANT — the guard is the UNIQUE INDEX, not this function: ON CONFLICT DO
 * NOTHING without a target only skips a row when some unique index would be
 * violated. The once-only guarantee here comes from uq_wallet_tx_idem
 * (migration 008, partial unique index on idempotency_key WHERE status <>
 * 'FAILED'). If that index is missing or invalid, every insert succeeds and
 * every caller double-pays — so checkIdempotencyIndex() (src/models/
 * idempotencyIndex.js) runs at boot and this function REFUSES to operate when
 * the index is gone (fail closed). Proven in tests/step0_rollover_indexdep.js.
 *
 * Call it INSIDE an open transaction (pass the client). The wallet credit SQL
 * is the caller's responsibility, executed only when { inserted: true }.
 * Never swallow errors after the wallet change — if the wallet UPDATE fails,
 * let the whole transaction roll back and retry.
 */
const { idempotencyIndexOk } = require('./idempotencyIndex');

async function ledgerFirstCredit(client, { userId, txType, amount, status = 'COMPLETED', idempotencyKey, provider, meta = {} }) {
  if (!idempotencyKey) throw new Error('ledgerFirstCredit: idempotencyKey is required');
  if (!Number.isFinite(Number(amount))) throw new Error('ledgerFirstCredit: invalid amount');
  if (!idempotencyIndexOk()) {
    throw new Error('IDEMPOTENCY_INDEX_UNAVAILABLE: uq_wallet_tx_idem is missing or invalid — refusing to credit (apply migration 008; see system_alerts IDEMPOTENCY_INDEX_MISSING)');
  }

  const { rows } = await client.query(
    `INSERT INTO wallet_transactions (user_id, tx_type, amount, status, idempotency_key, provider, meta)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [userId, txType, amount, status, idempotencyKey, provider, JSON.stringify(meta)]
  );

  return { inserted: rows.length > 0 };
}

module.exports = { ledgerFirstCredit };
