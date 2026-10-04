-- Migration 010: games.status CHECK constraint
-- Local DB has NO check constraint (setup_local_db.js skips CHECK constraints).
-- Production has games_status_check restricted to
--   ('live','starting','ongoing','completed','cancelled','X','O')
-- which would REJECT 'refund' (written by finishAndPayout's refund path) and the
-- new 'payout_failed'. This migration adds the constraint locally with the full
-- value set. PRODUCTION (needs approval, after backup):
--   ALTER TABLE games DROP CONSTRAINT games_status_check;
--   ALTER TABLE games ADD CONSTRAINT games_status_check
--     CHECK (status IN ('live','starting','ongoing','completed','cancelled','refund','payout_failed','X','O'));

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'games_status_check' AND conrelid = 'games'::regclass) THEN
    ALTER TABLE games ADD CONSTRAINT games_status_check
      CHECK (status IN ('live', 'starting', 'ongoing', 'completed', 'cancelled', 'refund', 'payout_failed', 'X', 'O'));
  END IF;
END $$;
