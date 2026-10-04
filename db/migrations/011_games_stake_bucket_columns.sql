-- Migration 011: record how much of each player's stake came from which bucket.
-- Stakes are deducted bonus-first, then from withdrawable (clamped at 0), the rest
-- from deposit-only available money. Without recording the split, refunds credited
-- the FULL real stake back to withdrawable_balance — turning deposit money into
-- withdrawable cash and bypassing the AML 1x rollover rule (proven in
-- tests/step0_rollover_indexdep.js).
--
--   bonus_used_x/o      (existing) — stake portion paid from bonus_balance
--   withdrawable_used_x/o (new)    — stake portion paid from withdrawable_balance
--   locked_used_x/o       (new)    — stake portion paid from deposit-only money
--                                    (bet - bonus_used - withdrawable_used)
--
-- Refunds (ghost cron, finishAndPayout refund path) restore exactly:
--   available_balance += bet_amount
--   bonus_balance     += bonus_used
--   withdrawable_balance += withdrawable_used
-- Pre-existing games default to 0 — conservative (rollover-safe).

ALTER TABLE games ADD COLUMN IF NOT EXISTS withdrawable_used_x integer NOT NULL DEFAULT 0;
ALTER TABLE games ADD COLUMN IF NOT EXISTS withdrawable_used_o integer NOT NULL DEFAULT 0;
ALTER TABLE games ADD COLUMN IF NOT EXISTS locked_used_x integer NOT NULL DEFAULT 0;
ALTER TABLE games ADD COLUMN IF NOT EXISTS locked_used_o integer NOT NULL DEFAULT 0;
