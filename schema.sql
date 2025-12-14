-- Users (simplified)
CREATE TABLE IF NOT EXISTS app_users (
  id UUID PRIMARY KEY,
  email TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Wallet with withdrawable separation (lock this row to avoid races)
CREATE TABLE IF NOT EXISTS wallets (
  user_id UUID PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE,
  available_balance BIGINT NOT NULL DEFAULT 0,        -- in ETB cents (integers)
  withdrawable_balance BIGINT NOT NULL DEFAULT 0,     -- subset of available balance that can be withdrawn
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Generic transactions ledger
CREATE TYPE txn_type AS ENUM ('deposit','withdrawal');
CREATE TYPE txn_status AS ENUM ('pending','processing','success','failed');

CREATE TABLE IF NOT EXISTS payment_transactions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  type txn_type NOT NULL,
  status txn_status NOT NULL DEFAULT 'pending',
  amount BIGINT NOT NULL,               -- ETB cents
  bank TEXT NOT NULL,                   -- TELEBIRR_USSD | CBE_BIRR | WEB_CHECKOUT
  tx_ref TEXT UNIQUE NOT NULL,          -- our reference (idempotency key)
  provider_ref TEXT,                    -- Chapa reference if any
  provider_payload JSONB,               -- request we sent
  provider_response JSONB,              -- raw response (init or webhook)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payment_transactions_user ON payment_transactions(user_id);
