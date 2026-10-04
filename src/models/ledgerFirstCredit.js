/**
 * ledgerFirstCredit.js
 *
 * Ledger-first credit primitive: write the wallet_transactions ledger row FIRST
 * (ON CONFLICT DO NOTHING, no target — works whether or not a unique constraint
 * exists), and only credit the wallet if a ledger row was actually inserted.
 *
 * Call it INSIDE an open transaction (pass the client). The wallet credit SQL
 * is the caller's responsibility, executed only when { inserted: true } — so a
 * replayed operation (cron retry, double-click, parallel request) can never
 * move money twice: the second attempt loses the INSERT race and returns
 * inserted: false.
 *
 * Never swallow errors after the wallet change — if the wallet UPDATE fails,
 * let the whole transaction roll back and retry.
 */

async function ledgerFirstCredit(client, { userId, txType, amount, status = 'COMPLETED', idempotencyKey, provider, meta = {} }) {
  if (!idempotencyKey) throw new Error('ledgerFirstCredit: idempotencyKey is required');
  if (!Number.isFinite(Number(amount))) throw new Error('ledgerFirstCredit: invalid amount');

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
