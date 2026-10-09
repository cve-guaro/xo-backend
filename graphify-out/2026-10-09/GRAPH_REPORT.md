# Graph Report - xoet_backend  (2026-07-31)

## Corpus Check
- 69 files · ~96,124 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 593 nodes · 970 edges · 64 communities (30 shown, 34 thin omitted)
- Extraction: 92% EXTRACTED · 8% INFERRED · 0% AMBIGUOUS · INFERRED: 74 edges (avg confidence: 0.5)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `76f17b6c`
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
- node-cron
- nodemon
- @sentry/node
- socket.io
- @socket.io/redis-adapter
- socks-proxy-agent
- @supabase/supabase-js
- uuid
- zod
- temp.js

## God Nodes (most connected - your core abstractions)
1. `setupGameSocket()` - 47 edges
2. `{ Pool }` - 31 edges
3. `setupSpinSocket()` - 18 edges
4. `withTx()` - 15 edges
5. `Redis` - 12 edges
6. `getGlobalSetting()` - 10 edges
7. `finalizeSpinRematch()` - 10 edges
8. `startDirectMatch()` - 9 edges
9. `broadcastToRound()` - 9 edges
10. `recordAndProcessWebhook()` - 8 edges

## Surprising Connections (you probably didn't know these)
- `verifyPendingDeposits()` --calls--> `verifyTx()`  [EXTRACTED]
  src/cron/verifyPendingDeposits.js → src/models/Chapa.js
- `verifyPendingDeposits()` --calls--> `completeDeposit()`  [EXTRACTED]
  src/cron/verifyPendingDeposits.js → src/models/payments.service.js
- `verifyPendingPayouts()` --calls--> `sendWithdrawalSMS()`  [EXTRACTED]
  src/cron/verifyPendingPayouts.js → src/utils/sms.js
- `completeDeposit()` --calls--> `withTx()`  [EXTRACTED]
  src/models/payments.service.js → src/db/index.js
- `creditWinnings()` --calls--> `withTx()`  [EXTRACTED]
  src/services/spinWalletService.js → src/db/index.js

## Import Cycles
- 1-file cycle: `src/cron.js -> src/cron.js`

## Communities (64 total, 34 thin omitted)

### Community 0 - "game.js"
Cohesion: 0.06
Nodes (66): acquireMatchLocks(), calculatePrize(), checkDraw(), checkWin(), cleanupGame(), clearQueueTimeout(), clearRematchOffer(), { creditPrize } (+58 more)

### Community 1 - "spinRoom.js"
Cohesion: 0.08
Nodes (46): getGlobalSetting(), { calculateSpinPrize }, express, { getSpinConfigs, activeSpinRounds }, jwt, { pool }, router, calculateSpinPrize() (+38 more)

### Community 2 - "server.js"
Cohesion: 0.05
Nodes (46): platformDetection(), WEB_ORIGINS, ADMIN_PHONES, ALWAYS_ALLOW_PATHS, BYPASS_ROLES, { pool, redis }, systemLockdownCheck(), accountRoutes (+38 more)

### Community 3 - "Transaction.js"
Cohesion: 0.07
Nodes (38): addWebhookSecret(), ALLOWED_TRANSITIONS, attachProviderExternalId(), computeHmac(), createDepositIntent(), createWithdrawalRequest(), createWithdrawalWithBalanceCheck(), crypto (+30 more)

### Community 4 - "admin.js"
Cohesion: 0.07
Nodes (20): { adminAuth, superAdminAuth }, axios, { CHAPA }, crypto, { emitToUserEvent }, express, fs, { getChapaBalance } (+12 more)

### Community 5 - "payment.js"
Cohesion: 0.11
Nodes (15): CHAPA, LIMITS, METHODS, missing, REQUIRED_VARS, toCents(), { auth }, express (+7 more)

### Community 6 - "payments.service.js"
Cohesion: 0.18
Nodes (17): withTx(), initChapaPayout(), applyNewUserGiveaways(), { CHAPA }, creditPrize(), crypto, hash20(), { initChapaDeposit, initChapaPayout } (+9 more)

### Community 7 - "telegram.js"
Cohesion: 0.12
Nodes (15): { applyNewUserGiveaways }, createTelegramLoginSession(), crypto, initTelegramBot(), jwt, memoryTgSessions, pollTelegramLoginSession(), { pool, redis, withTx, getGlobalSetting } (+7 more)

### Community 8 - "demo.js"
Cohesion: 0.19
Nodes (10): addMove(), createGame(), finishGame(), getGamesByUser(), { pool }, { createGame, addMove, finishGame, getGamesByUser }, { createUser }, demo() (+2 more)

### Community 9 - "otp.js"
Cohesion: 0.12
Nodes (12): { applyNewUserGiveaways }, axios, crypto, express, jwt, MAX_TRIES, OTP_RATE_MAX, OTP_RATE_WINDOW_SEC (+4 more)

### Community 10 - "Deployment Steps"
Cohesion: 0.12
Nodes (15): 1. Database Migration (Run FIRST), 2. Railway Environment Variables (Backend), 3. Vercel Environment Variables (Frontend), 4. Security Verification, Deployment Steps, Monitoring, Post-Deployment, Pre-Deployment (+7 more)

### Community 11 - "account.js"
Cohesion: 0.17
Nodes (13): logAnomaly(), auth(), { logAnomaly }, schemas, validate(), { z }, { auth }, express (+5 more)

### Community 12 - "Chapa.js"
Cohesion: 0.20
Nodes (12): { completeDeposit }, { pool }, { verifyTx }, { CHAPA }, chapaFetch(), crypto, getChapaBalance(), initChapaDeposit() (+4 more)

### Community 13 - "cron.js"
Cohesion: 0.19
Nodes (11): cron, initCron(), { verifyPendingDeposits }, { verifyPendingPayouts }, { pool }, verifyPendingDeposits(), { getChapaTransferStatus }, { pool } (+3 more)

### Community 14 - "Auth.js"
Cohesion: 0.18
Nodes (10): adminAuth(), jwt, { logAnomaly }, { pool, redis }, superAdminAuth(), { adminAuth }, express, jwt (+2 more)

### Community 15 - "dependencies"
Cohesion: 0.18
Nodes (11): agora-token, compression, jsonwebtoken, node-telegram-bot-api, dependencies, agora-token, compression, jsonwebtoken (+3 more)

### Community 16 - "weeklyLeaderboard.js"
Cohesion: 0.29
Nodes (9): formatMonthDay(), getPrevWeekBounds(), { pool }, runWeeklyLeaderboardSnapshot(), { sendSMS }, axios, sendDepositSMS(), sendSMS() (+1 more)

### Community 17 - "webhook.controller.js"
Cohesion: 0.24
Nodes (10): completeDeposit(), { CHAPA }, { completeDeposit }, crypto, handleWebhook(), parseProviderEvent(), { pool }, NOTE: Deposit SMS disabled per admin request — only withdrawal SMS is active (+2 more)

### Community 18 - "{ Pool }"
Cohesion: 0.20
Nodes (4): { pool }, { pool }, { Pool }, { pool }

### Community 19 - "index.js"
Cohesion: 0.24
Nodes (8): CIRCUIT_COOLDOWN_STEPS, FALLBACKS, getCircuitCooldown(), invalidateGlobalSettingCache(), isRedisAvailable(), _memoryGlobalSettingsCache, safeRedis, tripCircuitBreaker()

### Community 20 - "package.json"
Cohesion: 0.29
Nodes (6): main, name, scripts, dev, start, version

### Community 21 - "leaderboard.js"
Cohesion: 0.29
Nodes (4): { auth }, express, { pool, redis }, router

### Community 22 - "Redis"
Cohesion: 0.33
Nodes (3): Redis, { redis }, { pool, redis }

### Community 23 - "user.js"
Cohesion: 0.33
Nodes (5): { auth }, express, { pool, getGlobalSetting }, { redeemPromoCode }, router

### Community 24 - "scratch_search.js"
Cohesion: 0.40
Nodes (3): fs, path, projectRoot

### Community 25 - "auth.js"
Cohesion: 0.40
Nodes (4): express, jwt, { pool }, router

### Community 26 - "supabaseStorage.js"
Cohesion: 0.60
Nodes (4): { createClient }, deleteFile(), getSupabase(), uploadFile()

### Community 27 - "_cross_check_chapa.js"
Cohesion: 0.67
Nodes (3): checkChapaStatus(), crossCheck(), { Pool }

### Community 32 - "voice.js"
Cohesion: 0.50
Nodes (3): express, router, { RtcTokenBuilder, RtcRole }

## Knowledge Gaps
- **269 isolated node(s):** `{ Pool }`, `{ Pool }`, `{ Pool }`, `{ Pool }`, `Redis` (+264 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **34 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `{ Pool }` connect `{ Pool }` to `game.js`, `spinRoom.js`, `server.js`, `Transaction.js`, `admin.js`, `payment.js`, `payments.service.js`, `telegram.js`, `demo.js`, `otp.js`, `account.js`, `Chapa.js`, `cron.js`, `Auth.js`, `weeklyLeaderboard.js`, `webhook.controller.js`, `index.js`, `leaderboard.js`, `Redis`, `user.js`, `auth.js`?**
  _High betweenness centrality (0.118) - this node is a cross-community bridge._
- **Why does `setupGameSocket()` connect `game.js` to `spinRoom.js`, `server.js`?**
  _High betweenness centrality (0.021) - this node is a cross-community bridge._
- **Why does `Redis` connect `Redis` to `game.js`, `spinRoom.js`, `server.js`, `admin.js`, `telegram.js`, `otp.js`, `Auth.js`, `index.js`, `leaderboard.js`?**
  _High betweenness centrality (0.011) - this node is a cross-community bridge._
- **What connects `{ Pool }`, `{ Pool }`, `{ Pool }` to the rest of the system?**
  _269 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `game.js` be split into smaller, more focused modules?**
  _Cohesion score 0.06459627329192547 - nodes in this community are weakly interconnected._
- **Should `spinRoom.js` be split into smaller, more focused modules?**
  _Cohesion score 0.08392156862745098 - nodes in this community are weakly interconnected._
- **Should `server.js` be split into smaller, more focused modules?**
  _Cohesion score 0.047619047619047616 - nodes in this community are weakly interconnected._