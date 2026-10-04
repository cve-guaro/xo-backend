# Production Migration & Deploy Plan — Fix #1 / Fix #2

> **DO NOT RUN anything on production until:** (1) the production queries in
> `PRODUCTION_CHECKLIST.md` have been executed and reviewed, (2) a Supabase
> backup newer than 24h is confirmed, (3) the owner has approved each step.
> Every step below lists pre-checks, the action, verification, and rollback.

## Guiding rules

- **Index first, code second**: the ledger-first credit paths depend on
  `uq_wallet_tx_idem`. Deploying the code before the index means every
  `ledgerFirstCredit` call refuses (fail closed, `IDEMPOTENCY_INDEX_UNAVAILABLE`)
  — deposits/withdrawals gameplay payouts keep working through
  `fn_wallet_apply_tx`, but prize/refund paths pause until the index is in.
- **Frontend before backend** for the admin refund change: the new frontend
  sends `originalTxId`, which the OLD backend ignores; the NEW backend rejects
  the OLD form (missing `originalTxId`). Frontend first = never locked out.
- **Restart in a quiet hour**: live games live in the server's memory
  (`activeGames`); a restart forfeits them (the ghost cron will refund those
  players 30 minutes later).

## Ordered steps

### Step 0 — Production recon (read-only)

Run ALL queries in `PRODUCTION_CHECKLIST.md` ("Schema Verification" +
duplicate/double-refund/stuck-games queries). Decisions this drives:

| Finding | Consequence |
|---|---|
| Unique index on `idempotency_key` / `(user_id, idempotency_key)` EXISTS | 42P10 findings were local-only; ghost cron works; leaderboard ledger rows exist. Migration 008 step below becomes a no-op (skip). |
| NOT present | The ghost-cron rollback + missing prize ledger rows are LIVE → migrations below are urgent. |
| `games_status_check` exists with the narrow value set | The `'refund'` path in finishAndPayout is broken in production (constraint violation) → migration 010 fix is urgent. |
| `leaderboard_snapshots` has no unique on `(week_start, rank)` | The Send & Snapshot double-pay is LIVE → migration 009 is urgent. |

### Step 1 — Migration 008: `uq_wallet_tx_idem`

- **Pre-check** (must return 0 rows):
  ```sql
  SELECT idempotency_key, count(*) FROM wallet_transactions
  WHERE status <> 'FAILED' AND idempotency_key IS NOT NULL
  GROUP BY 1 HAVING count(*) > 1;
  ```
  If duplicates exist: STOP. Record affected users and over-credit amounts
  before resolving anything.
- **Action** (outside any transaction, quiet hour):
  ```sql
  CREATE UNIQUE INDEX CONCURRENTLY uq_wallet_tx_idem
    ON wallet_transactions (idempotency_key) WHERE status <> 'FAILED';
  ```
- **Verify**: `SELECT indisvalid FROM pg_index pi JOIN pg_class c ON c.oid = pi.indexrelid WHERE c.relname = 'uq_wallet_tx_idem';` → must be `true`.
- **Rollback**: `DROP INDEX CONCURRENTLY uq_wallet_tx_idem;`
  (Code keeps working — the boot guard fails closed with an alert.)

### Step 2 — Migration 009: `uq_leaderboard_week_rank`

- **Pre-check** (must return 0 rows):
  ```sql
  SELECT week_start, rank, count(*) FROM leaderboard_snapshots
  GROUP BY 1, 2 HAVING count(*) > 1;
  ```
- **Action**:
  ```sql
  CREATE UNIQUE INDEX CONCURRENTLY uq_leaderboard_week_rank
    ON leaderboard_snapshots (week_start, rank);
  ```
- **Verify** `indisvalid = true`.
- **Rollback**: `DROP INDEX CONCURRENTLY uq_leaderboard_week_rank;`

### Step 3 — Migration 010: `games_status_check` (read first, then alter)

- **Pre-check — READ the current constraint** (INFERRED today, from
  ARCHITECTURE.md only — nobody has seen production):
  ```sql
  SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
  WHERE conrelid = 'games'::regclass AND contype = 'c';
  ```
- **Pre-check** — no rows outside the new value set:
  ```sql
  SELECT DISTINCT status FROM games;
  ```
- **Action** (replace the constraint with the superset — adds `refund`,
  `payout_failed`; keeps every value the old constraint allowed):
  ```sql
  ALTER TABLE games DROP CONSTRAINT games_status_check;
  ALTER TABLE games ADD  CONSTRAINT games_status_check
    CHECK (status IN ('live','starting','ongoing','completed','cancelled','refund','payout_failed','X','O'));
  ```
  Run the DROP+ADD back-to-back in one command batch; if the ADD fails, re-ADD
  the ORIGINAL definition (from the pre-check output) immediately.
- **Rollback**: re-ADD the original constraint definition captured in the pre-check.

### Step 4 — Migration 011: stake-bucket columns (additive, safe)

- **Pre-check**: none needed (additive columns with defaults).
- **Action**:
  ```sql
  ALTER TABLE games ADD COLUMN IF NOT EXISTS withdrawable_used_x integer NOT NULL DEFAULT 0;
  ALTER TABLE games ADD COLUMN IF NOT EXISTS withdrawable_used_o integer NOT NULL DEFAULT 0;
  ALTER TABLE games ADD COLUMN IF NOT EXISTS locked_used_x      integer NOT NULL DEFAULT 0;
  ALTER TABLE games ADD COLUMN IF NOT EXISTS locked_used_o      integer NOT NULL DEFAULT 0;
  ```
- **Rollback**: not required (unused columns are harmless). To remove:
  `ALTER TABLE games DROP COLUMN ...` for the four columns.

## Code deploy order (after the migrations above)

1. **Frontend first** (`xoet-3`): admin refund form with `originalTxId`
   (commit `2775164`). Old backend ignores the extra field.
2. **Backend second** (`xoet_backend`): commits `3101eeb` → `8aa3c55` →
   `3470901` → `f54a42b` → `cf51d5c` → `19daf83` (single branch,
   `fix/promo-double-credit`). Restart in a quiet hour.
3. **Watch for 30 minutes** after restart (see PRODUCTION_CHECKLIST.md
   "Post-Deploy"): boot log must show
   `[IDEMPOTENCY] uq_wallet_tx_idem present and valid`; any
   `IDEMPOTENCY_INDEX_UNAVAILABLE` / `PAYOUT_LATE_SUCCESS` / `PAYOUT_FAILED`
   alerts in `system_alerts` need immediate review.

## Explicitly NOT covered here

- Production duplicates cleanup scripts (need the recon results first).
- Fix #3 (redeem-code, otp.js referral/promo bonuses, stake ledger, wallet v2).
