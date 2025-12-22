const SQL = {
  ensureWallet: `SELECT fn_wallet_ensure($1::uuid) AS wallet;`,

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
