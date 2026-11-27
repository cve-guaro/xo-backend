-- ============================================================================
-- XO ET — Migration 010: Notification, Spin & Leaderboard Query Indexes
-- ============================================================================
-- DRAFT MIGRATION FILE ONLY — review and apply manually against PostgreSQL.
-- Uses CREATE INDEX CONCURRENTLY (must NOT run inside a BEGIN/COMMIT block).
--
-- Targets slow read paths identified in the Nov 26 performance audit:
--   1. GET /notifications/user & /notifications/user/unread-count
--   2. GET /user/me (spin_bets + spin_rounds stats)
--   3. GET /leaderboard/weekly (payment_transactions correlated sum)
--
-- Rollback:
--   DROP INDEX CONCURRENTLY IF EXISTS idx_notifications_user_read_created;
--   DROP INDEX CONCURRENTLY IF EXISTS idx_spin_bets_user_bot_round;
--   DROP INDEX CONCURRENTLY IF EXISTS idx_spin_rounds_winner_status;
--   DROP INDEX CONCURRENTLY IF EXISTS idx_payment_tx_user_status_bank;
-- ============================================================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_notifications_user_read_created
  ON public.notifications (user_id, read, created_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_spin_bets_user_bot_round
  ON public.spin_bets (user_id, is_bot, round_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_spin_rounds_winner_status
  ON public.spin_rounds (winner_user_id, status)
  WHERE winner_user_id IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payment_tx_user_status_bank
  ON public.payment_transactions (user_id, status, bank);
