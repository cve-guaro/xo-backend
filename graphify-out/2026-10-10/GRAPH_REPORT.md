# Graph Report - xoet_backend  (2026-10-09)

## Corpus Check
- 96 files · ~129,668 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 779 nodes · 1423 edges · 69 communities (34 shown, 35 thin omitted)
- Extraction: 93% EXTRACTED · 7% INFERRED · 0% AMBIGUOUS · INFERRED: 101 edges (avg confidence: 0.5)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `eecf4701`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- game.js
- spinRoom.js
- server.js
- Transaction.js
- admin.js
- payment.js
- payments.service.js
- telegram.js
- demo.js
- otp.js
- Deployment Steps
- account.js
- Chapa.js
- cron.js
- Auth.js
- dependencies
- weeklyLeaderboard.js
- webhook.controller.js
- { Pool }
- index.js
- package.json
- leaderboard.js
- Redis
- user.js
- scratch_search.js
- auth.js
- supabaseStorage.js
- _cross_check_chapa.js
- enable_lockdown.js
- export_users_template.js
- filter_2517_2519.js
- split_phones.js
- voice.js
- _audit_refunds.js
- cleanup_pending.js
- query.js
- scratch_add_columns.js
- scratch_check.js
- setup_local_db.js
- test-stats.js
- axios
- body-parser
- cors
- dotenv
- express
- express-rate-limit
- express-validator
- follow-redirects
- helmet
- https-proxy-agent
- ioredis
- multer
- ngrok
- nodemon
- @sentry/node
- socket.io
- @socket.io/redis-adapter
- socks-proxy-agent
- @supabase/supabase-js
- uuid
- zod
- temp.js
- compression
- jsonwebtoken
- node-telegram-bot-api
- pg
- connectRedisAdapter

## God Nodes (most connected - your core abstractions)
1. `setupGameSocket()` - 47 edges
2. `{ Pool }` - 34 edges
3. `withTx()` - 25 edges
4. `main()` - 24 edges
5. `checkInvariant()` - 20 edges
6. `report()` - 20 edges
7. `setupSpinSocket()` - 18 edges
8. `resetUsers()` - 18 edges
9. `finishAndPayout()` - 15 edges
10. `assertServerStopped()` - 15 edges

## Surprising Connections (you probably didn't know these)
- `main()` --calls--> `withTx()`  [EXTRACTED]
  tests/step0_rollover_indexdep.js → src/db/index.js
- `main()` --calls--> `requestWithdraw()`  [EXTRACTED]
  tests/fix3_step0_c.js → src/models/payments.service.js
- `t11()` --calls--> `finishAndPayout()`  [EXTRACTED]
  tests/run_all.js → src/socket/game.js
- `t14()` --calls--> `finishAndPayout()`  [EXTRACTED]
  tests/run_all.js → src/socket/game.js
- `main()` --calls--> `finishAndPayout()`  [EXTRACTED]
  tests/step0_ghost_payout_repro.js → src/socket/game.js

## Import Cycles
- 1-file cycle: `src/cron.js -> src/cron.js`

## Communities (69 total, 35 thin omitted)

### Community 0 - "game.js"
Cohesion: 0.06
Nodes (67): acquireMatchLocks(), calculatePrize(), checkDraw(), checkWin(), cleanupGame(), clearQueueTimeout(), clearRematchOffer(), { creditPrize } (+59 more)

### Community 1 - "spinRoom.js"
Cohesion: 0.07
Nodes (55): getGlobalSetting(), { calculateSpinPrize }, express, { getSpinConfigs, activeSpinRounds }, jwt, { pool }, router, calculateSpinPrize() (+47 more)

### Community 2 - "server.js"
Cohesion: 0.05
Nodes (37): accountRoutes, adminRoutes, ALLOWED_ORIGINS, app, authLimiter, authRoutes, bodyParser, { checkIdempotencyIndex } (+29 more)

### Community 3 - "Transaction.js"
Cohesion: 0.07
Nodes (38): addWebhookSecret(), ALLOWED_TRANSITIONS, attachProviderExternalId(), computeHmac(), createDepositIntent(), createWithdrawalRequest(), createWithdrawalWithBalanceCheck(), crypto (+30 more)

### Community 4 - "admin.js"
Cohesion: 0.07
Nodes (20): { adminAuth, superAdminAuth }, axios, { CHAPA }, crypto, { emitToUserEvent, finishAndPayout }, express, fs, { getChapaBalance } (+12 more)

### Community 5 - "payment.js"
Cohesion: 0.05
Nodes (53): initCron(), { completeDeposit }, { pool }, verifyPendingDeposits(), { verifyTx }, withTx(), CHAPA, LIMITS (+45 more)

### Community 6 - "payments.service.js"
Cohesion: 0.08
Nodes (40): deductStake(), NOTE: this is the extraction of the inline block that used to live in, { assertServerStopped, pool, USER_X, USER_O }, { deductStake }, main(), plainTx(), reserveWithdraw(), stake() (+32 more)

### Community 7 - "telegram.js"
Cohesion: 0.17
Nodes (10): { applyNewUserGiveaways }, BOT_TOKEN, crypto, HARDCODED_ADMINS, initTelegramBot(), jwt, memoryTgSessions, { pool, redis, withTx, getGlobalSetting } (+2 more)

### Community 8 - "demo.js"
Cohesion: 0.19
Nodes (10): addMove(), createGame(), finishGame(), getGamesByUser(), { pool }, { createGame, addMove, finishGame, getGamesByUser }, { createUser }, demo() (+2 more)

### Community 9 - "otp.js"
Cohesion: 0.11
Nodes (13): { applyNewUserGiveaways }, axios, crypto, express, HARDCODED_ADMINS, jwt, MAX_TRIES, OTP_RATE_MAX (+5 more)

### Community 10 - "Deployment Steps"
Cohesion: 0.12
Nodes (15): 1. Database Migration (Run FIRST), 2. Railway Environment Variables (Backend), 3. Vercel Environment Variables (Frontend), 4. Security Verification, Deployment Steps, Monitoring, Post-Deployment, Pre-Deployment (+7 more)

### Community 11 - "account.js"
Cohesion: 0.13
Nodes (18): logAnomaly(), { redis }, adminAuth(), auth(), jwt, { logAnomaly }, { pool, redis }, superAdminAuth() (+10 more)

### Community 12 - "Chapa.js"
Cohesion: 0.19
Nodes (14): connectSocket(), { execFile }, getToken(), health(), http, { io }, main(), NUMBERS (+6 more)

### Community 13 - "cron.js"
Cohesion: 0.12
Nodes (50): verifyPendingPayouts(), classifyChapaInitError(), DEFINITIVE_PATTERNS, checkIdempotencyIndex(), settleWithdrawal(), nodeCron, origSchedule, assertNoForeignDbClients() (+42 more)

### Community 14 - "Auth.js"
Cohesion: 0.29
Nodes (5): { adminAuth }, express, jwt, { pool }, router

### Community 15 - "dependencies"
Cohesion: 0.18
Nodes (11): agora-token, express, express-validator, https-proxy-agent, node-cron, dependencies, agora-token, express (+3 more)

### Community 16 - "weeklyLeaderboard.js"
Cohesion: 0.09
Nodes (27): cron, { verifyPendingDeposits }, { verifyPendingPayouts }, { ledgerFirstCredit }, { pool, withTx }, formatMonthDay(), getPrevWeekBounds(), { ledgerFirstCredit } (+19 more)

### Community 17 - "webhook.controller.js"
Cohesion: 0.24
Nodes (9): { CHAPA }, { completeDeposit }, crypto, handleWebhook(), parseProviderEvent(), { pool }, NOTE: Deposit SMS disabled per admin request — only withdrawal SMS is active, { sendDepositSMS, sendWithdrawalSMS } (+1 more)

### Community 18 - "{ Pool }"
Cohesion: 0.23
Nodes (11): checkRateLimit(), crypto, logApiCall(), miniAppAuth(), { pool, redis }, requirePermission(), verifySecret(), express (+3 more)

### Community 19 - "index.js"
Cohesion: 0.18
Nodes (9): CIRCUIT_COOLDOWN_STEPS, FALLBACKS, getCircuitCooldown(), invalidateGlobalSettingCache(), isRedisAvailable(), _memoryGlobalSettingsCache, safeRedis, tripCircuitBreaker() (+1 more)

### Community 20 - "package.json"
Cohesion: 0.25
Nodes (7): main, name, scripts, dev, start, test, version

### Community 21 - "leaderboard.js"
Cohesion: 0.18
Nodes (6): Redis, { pool, redis }, { auth }, express, { pool, redis }, router

### Community 22 - "Redis"
Cohesion: 0.17
Nodes (11): 1. Check for duplicate idempotency keys, 2. Create the unique partial index (CONCURRENTLY), 3. Verify the `transactions` table, 4. Compare Chapa payout history with platform records, 5. Compare leaderboard payments with snapshots, Deploy Steps, Known Issues NOT Fixed in This Release, Post-Deploy Verification (+3 more)

### Community 23 - "user.js"
Cohesion: 0.18
Nodes (10): Code deploy order (after the migrations above), Explicitly NOT covered here, Guiding rules, Ordered steps, Production Migration & Deploy Plan — Fix #1 / Fix #2, Step 0 — Production recon (read-only), Step 1 — Migration 008: `uq_wallet_tx_idem`, Step 2 — Migration 009: `uq_leaderboard_week_rank` (+2 more)

### Community 24 - "scratch_search.js"
Cohesion: 0.22
Nodes (8): createTelegramLoginSession(), pollTelegramLoginSession(), {
  createTelegramLoginSession,
  pollTelegramLoginSession,
}, express, initLimiter, pollLimiter, rateLimit, router

### Community 25 - "auth.js"
Cohesion: 0.17
Nodes (10): { getChapaTransferStatus }, { pool }, { sendWithdrawalSMS }, { settleWithdrawal }, { Pool }, { pool, withTx }, express, jwt (+2 more)

### Community 26 - "supabaseStorage.js"
Cohesion: 0.60
Nodes (4): { createClient }, deleteFile(), getSupabase(), uploadFile()

### Community 27 - "_cross_check_chapa.js"
Cohesion: 0.67
Nodes (3): checkChapaStatus(), crossCheck(), { Pool }

### Community 32 - "voice.js"
Cohesion: 0.50
Nodes (3): express, router, { RtcTokenBuilder, RtcRole }

### Community 37 - "scratch_check.js"
Cohesion: 0.53
Nodes (5): ADMIN_PHONES, ALWAYS_ALLOW_PATHS, BYPASS_ROLES, { pool, redis }, systemLockdownCheck()

### Community 44 - "express"
Cohesion: 0.60
Nodes (4): axios, sendDepositSMS(), sendSMS(), sendWithdrawalSMS()

### Community 49 - "https-proxy-agent"
Cohesion: 0.67
Nodes (3): ensureUserSchema(), runMigrations(), startServer()

## Knowledge Gaps
- **350 isolated node(s):** `{ Pool }`, `{ Pool }`, `{ Pool }`, `{ Pool }`, `Redis` (+345 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **35 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `{ Pool }` connect `auth.js` to `game.js`, `spinRoom.js`, `server.js`, `Transaction.js`, `admin.js`, `payment.js`, `scratch_check.js`, `telegram.js`, `demo.js`, `otp.js`, `account.js`, `Auth.js`, `weeklyLeaderboard.js`, `webhook.controller.js`, `{ Pool }`, `index.js`, `leaderboard.js`?**
  _High betweenness centrality (0.100) - this node is a cross-community bridge._
- **Why does `withTx()` connect `payment.js` to `spinRoom.js`, `admin.js`, `telegram.js`, `otp.js`, `cron.js`, `weeklyLeaderboard.js`, `{ Pool }`, `index.js`, `auth.js`?**
  _High betweenness centrality (0.021) - this node is a cross-community bridge._
- **Why does `setupGameSocket()` connect `game.js` to `spinRoom.js`, `server.js`?**
  _High betweenness centrality (0.013) - this node is a cross-community bridge._
- **What connects `{ Pool }`, `{ Pool }`, `{ Pool }` to the rest of the system?**
  _350 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `game.js` be split into smaller, more focused modules?**
  _Cohesion score 0.06317907444668008 - nodes in this community are weakly interconnected._
- **Should `spinRoom.js` be split into smaller, more focused modules?**
  _Cohesion score 0.06830601092896176 - nodes in this community are weakly interconnected._
- **Should `server.js` be split into smaller, more focused modules?**
  _Cohesion score 0.05263157894736842 - nodes in this community are weakly interconnected._