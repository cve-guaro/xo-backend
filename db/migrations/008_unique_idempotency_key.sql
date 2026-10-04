-- Migration 008: Add unique partial index on wallet_transactions.idempotency_key
-- This prevents concurrent duplicate refunds and other idempotency violations.
--
-- LOCAL: plain CREATE UNIQUE INDEX (transactional, blocking).
-- PRODUCTION: use CONCURRENTLY — see docs/PRODUCTION_CHECKLIST.md
--
-- Prerequisites:
--   1. Run the duplicate query first to find any existing duplicates:
--      SELECT idempotency_key, count(*) FROM wallet_transactions
--      WHERE status <> 'FAILED' GROUP BY idempotency_key HAVING count(*) > 1;
--   2. Resolve any duplicates before creating the index.

CREATE UNIQUE INDEX uq_wallet_tx_idem
  ON wallet_transactions (idempotency_key)
  WHERE status <> 'FAILED';
