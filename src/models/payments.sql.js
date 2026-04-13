const SQL = {
  ensureWallet: `SELECT fn_wallet_ensure($1::uuid) AS wallet;`,

  applyExistingTx: `
    SELECT fn_wallet_apply_existing_tx($1::uuid) AS tx_id;
  `,

  // Find deposit tx by tx_id (which is what we send to Chapa as tx_ref)
  findDepositTxByProviderRef: `
    SELECT id, user_id, status, tx_id
    FROM wallet_transactions
    WHERE tx_type = 'DEPOSIT'
      AND provider = $1
      AND (
        id::text = $2::text
        OR provider_ref::text = $2::text
      )
    ORDER BY created_at DESC
    LIMIT 1
    FOR UPDATE;
  `,
    getWalletByUserId: `
    SELECT user_id, available_balance, withdrawable_balance
    FROM wallets
    WHERE user_id = $1::uuid;
  `,

  // Mark completed by internal id (UUID PK)
  markTxCompletedById: `
    UPDATE wallet_transactions
    SET status = 'COMPLETED',
        provider_ref = COALESCE($2::text, provider_ref::text)::text,
        updated_at = now()
    WHERE id = $1::uuid
      AND status = 'PENDING'
    RETURNING id, user_id;
  `,

  applyTx: `
    SELECT fn_wallet_apply_tx(
      $1::uuid,                 -- user_id
      $2::wallet_tx_type,       -- tx_type
      $3::numeric,              -- amount
      $4::wallet_tx_status,     -- status
      $5::text,                 -- idempotency_key
      $6::text,                 -- provider
      $7::text,                 -- provider_ref
      $8::jsonb                 -- meta
    ) AS tx_id;
  `,

  getWallet: `
    SELECT user_id, available_balance, withdrawable_balance
    FROM wallets
    WHERE user_id = $1::uuid;
  `,

  createWithdrawRequest: `
    INSERT INTO withdraw_requests(
      user_id,
      amount,
      payout_method,
      payout_destination,
      reserve_tx_id
    )
    VALUES ($1::uuid, $2::numeric, $3::text, $4::text, $5::uuid)
    RETURNING *;
  `,
};

module.exports = {
  SQL,
};
