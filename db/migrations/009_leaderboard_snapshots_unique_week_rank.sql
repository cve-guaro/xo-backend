-- Migration 009: UNIQUE (week_start, rank) on leaderboard_snapshots
-- Closes the Send & Snapshot double-insert race: two parallel requests could both
-- pass the "snapshot for this week exists" check and insert duplicate rows.
--
-- LOCAL: plain CREATE UNIQUE INDEX (transactional, blocking).
-- PRODUCTION: run the duplicate pre-check FIRST, then the CONCURRENTLY version
-- outside a transaction (see docs/PRODUCTION_CHECKLIST.md).
--
-- Duplicate pre-check (must return zero rows before creating the index):
--   SELECT week_start, rank, count(*) FROM leaderboard_snapshots
--   GROUP BY week_start, rank HAVING count(*) > 1;

CREATE UNIQUE INDEX uq_leaderboard_week_rank
  ON leaderboard_snapshots (week_start, rank);
