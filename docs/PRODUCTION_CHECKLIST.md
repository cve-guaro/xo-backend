# Production Checklist: Fix #1 — Withdrawal Settlement

> This checklist covers the deployment of the withdrawal settlement fix.
> **DO NOT DEPLOY** until all items are completed in order.

## Pre-Deploy Verification

### 1. Check for duplicate idempotency keys

Run this query **before** creating the index:

```sql
SELECT idempotency_key, count(*) AS dupes, array_agg(id) AS tx_ids
FROM wallet_transactions
WHERE status <> 'FAILED'
  AND idempotency_key IS NOT NULL
GROUP BY idempotency_key
HAVING count(*) > 1
ORDER BY count(*) DESC;
```

**If duplicates exist:** resolve them manually before step 2. Each duplicate means a user was credited twice. Record which users were affected and the total over-credit.

### 2. Create the unique partial index (CONCURRENTLY)

**Must be run OUTSIDE a transaction** (not inside `BEGIN`/`COMMIT`):

```sql
CREATE UNIQUE INDEX CONCURRENTLY uq_wallet_tx_idem
  ON wallet_transactions (idempotency_key)
  WHERE status <> 'FAILED';
```

After it finishes, verify it's valid:

```sql
SELECT indexname, indisvalid
FROM pg_indexes i
JOIN pg_class c ON c.relname = i.indexname
JOIN pg_index pi ON pi.indexrelid = c.oid
WHERE i.indexname = 'uq_wallet_tx_idem';
```

If `indisvalid` is `false`, the index creation failed (likely due to a duplicate that appeared during creation). Drop it and retry:

```sql
DROP INDEX CONCURRENTLY uq_wallet_tx_idem;
-- Resolve the new duplicate, then retry step 2
```

### 3. Verify the `transactions` table

The old `transactions` table exists with 0 rows. The fix removes references to it, but confirm it's not used by anything else:

```sql
SELECT count(*) FROM transactions;
-- Should be 0. If not, investigate before deploying.
```

### 4. Compare Chapa payout history with platform records

Find withdrawals that were refunded **and** also paid by Chapa:

```sql
-- Pending withdrawals older than 30 minutes (path 5 victims)
SELECT id, user_id, amount, created_at, meta
FROM wallet_transactions
WHERE tx_type = 'WITHDRAW_REQUEST'
  AND status = 'PENDING'
  AND created_at < now() - interval '30 minutes'
ORDER BY created_at;

-- Duplicate refunds (same original TX refunded more than once)
SELECT meta->>'originalTxId' AS original_tx, count(*) AS refund_count, sum(amount) AS total_refunded
FROM wallet_transactions
WHERE tx_type = 'REFUND'
  AND meta->>'originalTxId' IS NOT NULL
GROUP BY meta->>'originalTxId'
HAVING count(*) > 1;
```

### 5. Compare leaderboard payments with snapshots

```sql
SELECT
  ls.week_start, ls.rank, ls.prize_amount, ls.prize_status,
  ls.user_id, ls.username,
  (SELECT count(*) FROM bonus_logs bl WHERE bl.user_id = ls.user_id AND bl.reason LIKE 'Weekly Leaderboard%' AND bl.created_at >= ls.week_start) AS bonus_log_count,
  (SELECT sum(amount) FROM bonus_logs bl WHERE bl.user_id = ls.user_id AND bl.reason LIKE 'Weekly Leaderboard%' AND bl.created_at >= ls.week_start) AS bonus_log_total
FROM leaderboard_snapshots ls
WHERE ls.prize_status = 'approved'
ORDER BY ls.week_start DESC, ls.rank;
```

Check that every approved snapshot has exactly one matching bonus_log entry.

## Deploy Steps

1. **Apply migration** `db/migrations/008_unique_idempotency_key.sql` (use `CONCURRENTLY` version above)
2. **Deploy code** (settleWithdrawal, classifyChapaInitError, updated verifyPendingPayouts, updated payments.service.js)
3. **Monitor** the cron logs for the first 30 minutes:
   - `[settleWithdrawal]` messages should appear instead of the old inline refund messages
   - No `column "tx_id" does not exist` errors
   - No duplicate key violations on `uq_wallet_tx_idem`

## Post-Deploy Verification

- [ ] Trigger a test withdrawal with a known-bad account → should see `classifyChapaInitError: ambiguous` (allow-list is EMPTY until sandbox fixtures are captured) → row stays PENDING, cron refunds after 3×404 (~6 min)
- [ ] Check that the cron still processes legitimate pending withdrawals
- [ ] Verify `isRunning` flag prevents overlapping cron runs (check logs)

## Schema Verification (run BEFORE and AFTER deploy — settles the local/production mirror question)

`setup_local_db.js` copies only PRIMARY KEY / UNIQUE **constraints** and skips all
unique **indexes** (`indexdef NOT LIKE '%UNIQUE%'`), FKs and CHECKs — so the local
DB silently lacks any uniqueness that production implements as a plain unique
index. These queries establish what production actually has:

```sql
-- 1) Constraints actually present (compare with xoet_local, which has none on wallet_transactions)
SELECT conrelid::regclass, conname, pg_get_constraintdef(oid) FROM pg_constraint
WHERE conrelid IN ('wallet_transactions'::regclass, 'leaderboard_snapshots'::regclass);

-- 2) Indexes (look for UNIQUE / partial unique on idempotency_key and (week_start, rank))
SELECT indexname, indexdef FROM pg_indexes WHERE tablename IN ('wallet_transactions','leaderboard_snapshots');

-- 3) Function definitions unchanged (fn_wallet_apply_tx md5 must be 89a091f6f65f76a0179254e9e4f736bf)
SELECT proname, md5(pg_get_functiondef(oid)) FROM pg_proc
WHERE proname IN ('fn_wallet_apply_tx','fn_wallet_apply_existing_tx','fn_wallet_ensure');
```

If query 2 shows a unique index on `(user_id, idempotency_key)` or
`idempotency_key` in production, then the local 42P10 errors on
`ON CONFLICT (user_id, idempotency_key)` are a local-only artifact and the
ghost-cron rollback does not happen in production. If it shows nothing, the
ON CONFLICT clauses throw in production too and the ghost-cron fix is urgent.

```sql
-- 4) Stuck games (cleanup failing / payout failure victims). Must be 0.
SELECT count(*) FROM games
WHERE status IN ('ongoing','live','countdown') AND created_at < now() - interval '30 minutes';

-- 5) Leaderboard prizes paid with NO matching wallet_transactions ledger row
SELECT ls.week_start, ls.rank, ls.user_id, ls.prize_amount
FROM leaderboard_snapshots ls
WHERE ls.prize_status = 'approved'
  AND NOT EXISTS (
    SELECT 1 FROM wallet_transactions wt
    WHERE wt.user_id = ls.user_id AND wt.tx_type = 'PRIZE'
      AND wt.meta->>'weekStart' = ls.week_start::text
  )
ORDER BY ls.week_start DESC;
```

## Known Issues NOT Fixed in This Release

| Issue | Status | Fix # |
|-------|--------|-------|
| Leaderboard `ON CONFLICT (user_id, idempotency_key)` throws | KNOWN BUG | Fix #2 |
| Leaderboard cron has no transaction (crash gap) | KNOWN BUG | Fix #2 |
| No UNIQUE on `leaderboard_snapshots (week_start, rank)` | KNOWN BUG | Fix #2 |
| Ghost-game refund puts stake into wrong bucket | KNOWN BUG | Fix #3 |
| `/account/redeem-code` has no ledger row or unique constraint | KNOWN BUG | Fix #4 |
| Game stakes leave no ledger row | KNOWN BUG | Fix #5 |
| `finishAndPayout` tx() is fire-and-forget (lost payout risk) | KNOWN BUG | Separate |
