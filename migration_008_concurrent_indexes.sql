-- ============================================================================
-- XO ET — Migration 008: High-Performance Concurrent Indexes
-- ============================================================================
-- PURPOSE:
-- Adds indexes on high-frequency query paths to prevent table scans under load.
--
-- TRANSACTION SAFETY & CONCURRENCY NOTES:
-- 1. `CREATE INDEX CONCURRENTLY` builds indexes WITHOUT acquiring an exclusive lock
--    on the target tables (it permits concurrent INSERT, UPDATE, and DELETE operations).
-- 2. IMPORTANT: `CREATE INDEX CONCURRENTLY` CANNOT be executed inside an explicit
--    transaction block (do NOT wrap this file in `BEGIN; ... COMMIT;`).
-- 3. Each statement must be executed independently in autocommit mode.
-- 4. If a concurrent index build is interrupted, PostgreSQL may leave behind an
--    `INVALID` index. To clean up any invalid index, run: `DROP INDEX CONCURRENTLY <index_name>;`
-- ============================================================================

-- 1. Wallet Transactions: user lookup, pagination, and idempotency
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_wallet_tx_user_id 
  ON public.wallet_transactions (user_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_wallet_tx_created_at_desc 
  ON public.wallet_transactions (created_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_wallet_tx_idempotency_key 
  ON public.wallet_transactions (idempotency_key) 
  WHERE idempotency_key IS NOT NULL;

-- 2. Games: active room filtering and match history
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_games_status 
  ON public.games (status);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_games_created_at_desc 
  ON public.games (created_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_games_player_x 
  ON public.games (player_x);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_games_player_o 
  ON public.games (player_o);

-- 3. Withdraw Requests: user queries and pending settlement processing
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_withdraw_requests_user_status 
  ON public.withdraw_requests (user_id, status);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_withdraw_requests_created_at_desc 
  ON public.withdraw_requests (created_at DESC);

-- 4. Payment Transactions: deposit verification and external ref lookup
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payment_tx_user_status 
  ON public.payment_transactions (user_id, status);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payment_tx_provider_ref 
  ON public.payment_transactions (provider_ref) 
  WHERE provider_ref IS NOT NULL;

-- 5. Audit Logs: sequential admin activity queries
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_admin_audit_logs_created_at_desc 
  ON public.admin_audit_logs (created_at DESC);
