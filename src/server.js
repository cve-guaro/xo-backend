// Trigger nodemon reload
const express = require('express');
const compression = require('compression');
const Sentry = require("@sentry/node");

// ─── SENTRY INITIALIZATION ───────────────────────────────────────────────────
// Only initialize Sentry if DSN is configured (keeps it out of source code)
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || "development",
    tracesSampleRate: 0.2,
  });
} else {
  console.warn('[SENTRY] No SENTRY_DSN configured — error tracking disabled.');
}

const http = require('http');
const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const Redis = require('ioredis');
const bodyParser = require("body-parser"); 
const cors = require('cors');
const path = require('path');
require('dotenv').config();

// ─── DEV ↔ PROD SAFETY GUARD ─────────────────────────────────────────────────
// Refuse to start only if a local developer environment accidentally points at production services.
const isHosted = !!process.env.RAILWAY_ENVIRONMENT || !!process.env.RAILWAY_PROJECT_ID || process.env.NODE_ENV === 'production';
if (!isHosted && process.env.NODE_ENV === 'development') {
  const combined = `${process.env.REDIS_URL || ''}|${process.env.DATABASE_URL || ''}`;
  if (/upstash|supabase\.com|pooler\.supabase|railway/i.test(combined)) {
    console.error('\n🛑 SAFETY GUARD: Refusing to start — local dev environment points at production services.');
    console.error('   REDIS_URL or DATABASE_URL contains upstash/supabase/railway.');
    console.error('   Fix your .env before running locally.\n');
    process.exit(1);
  }
}

// Auto-default NODE_ENV to production in hosted container environments
if (!process.env.NODE_ENV && (process.env.RAILWAY_ENVIRONMENT || process.env.PORT)) {
  process.env.NODE_ENV = 'production';
}

const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const txRoutes = require("./routes/transactions");
const { recordAndProcessWebhook } = require("./models/Transaction");
const payments = require('./routes/payment');
const userRoutes = require('./routes/user');
const accountRoutes = require('./routes/account');
const otpAuthRoutes = require('./routes/otp');
const adminRoutes = require('./routes/admin');
const telegramAuthRoutes = require('./routes/telegram-auth');
const miniAppApiRoutes = require('./routes/miniapp-api');

const authRoutes = require('./routes/auth');
const { setupGameSocket } = require('./socket/game');
const { setupSpinSocket } = require('./socket/spinRoom');
const { platformDetection } = require('./middleware/Detection');
const { systemLockdownCheck } = require('./middleware/Security');
const { pool, redis } = require('./db/index');


const app = express();
app.use(compression({
  level: 6,            // Best balance of speed vs compression ratio (~70% reduction)
  threshold: 1024,     // Skip responses smaller than 1KB (overhead not worth it)
  filter: (req, res) => {
    // Don't compress server-sent events or streaming responses
    if (req.headers['accept'] === 'text/event-stream') return false;
    return compression.filter(req, res);
  },
}));
app.set('trust proxy', 1);
const server = http.createServer(app);

// ─── SECURITY HEADERS ─────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      workerSrc: ["'self'", "blob:"],
      styleSrc: ["'self'", "'unsafe-inline'"],  // React Native Web requires inline styles
      imgSrc: ["'self'", "data:", "blob:", "https://xoethiopia.com", "https://www.xoethiopia.com", "https://*.vercel.app"],
      connectSrc: ["'self'", "https://xoethiopia.com", "https://www.xoethiopia.com", "https://*.vercel.app", "wss://xoethiopia.com", "wss://www.xoethiopia.com"],
      // ✅ Allow Flutter WebView to embed this site
      // 'self' = same origin web, the https domains = production Flutter app
      // Note: Flutter WebView on Android/iOS has no Origin header so it passes through
      frameAncestors: ["'self'", "https://xoethiopia.com", "https://www.xoethiopia.com", "https://*.xoethiopia.com"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      objectSrc: ["'none'"],
    }
  },
  // ✅ Disable X-Frame-Options so Flutter WebView is not blocked
  // CSP frame-ancestors above is the modern replacement
  xFrameOptions: false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" },
  crossOriginOpenerPolicy: { policy: "unsafe-none" }, // Allow opener for WebView context
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  },
  referrerPolicy: { policy: "strict-origin-when-cross-origin" }
}));


// Manually applying Permissions-Policy since helmet doesn't support it natively yet
app.use((req, res, next) => {
  res.setHeader("Permissions-Policy", "camera=(), microphone=(self *), geolocation=()");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  
  // Enforce UTF-8 charset for all application/json responses
  const originalSend = res.send;
  res.send = function (body) {
    if (typeof body === 'string' || Buffer.isBuffer(body)) {
      const contentType = res.getHeader('Content-Type');
      if (contentType && contentType.includes('application/json') && !contentType.includes('charset')) {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
      }
    }
    return originalSend.apply(this, arguments);
  };
  next();
});

// ─── STRICT CORS ───────────────────────────────────────────────────────────────
// Whitelist and dynamic origin matcher
const ALLOWED_ORIGINS = [
  "https://xoethiopia.com",
  "https://www.xoethiopia.com",
  "https://xo-frontend-gamma.vercel.app",
  "https://xo-et-frontend.vercel.app",
  "https://xoet-pro-frontend.vercel.app",
  // Local dev origins (Expo web)
  "http://localhost:8081",
  "http://localhost:8082",
  "http://127.0.0.1:8081",
  "http://127.0.0.1:8082",
  "http://localhost:19006",
  "http://localhost:3000",
];
// Allow localhost ONLY if explicitly defined in local .env configuration
if (process.env.LOCAL_CORS) {
  ALLOWED_ORIGINS.push(...process.env.LOCAL_CORS.split(',').map(o => o.trim()));
}
const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (mobile apps, server-to-server)
    if (!origin) return callback(null, true);

    // In development/local environments, dynamically allow any localhost or local network IP
    const isLocal = origin.startsWith('http://localhost:') || 
                    origin.startsWith('http://127.0.0.1:') || 
                    origin.startsWith('http://192.168.') || 
                    origin.startsWith('http://10.') || 
                    origin.startsWith('http://172.');

    const isVercel = origin.endsWith('.vercel.app') || /\.vercel\.app$/.test(origin);

    if (ALLOWED_ORIGINS.includes(origin) || isVercel || isLocal) {
      return callback(null, true);
    }
    return callback(null, false);
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Content-Type", 
    "Authorization", 
    "x-access-token", 
    "x-platform", 
    "Idempotency-Key",
    "sentry-trace",
    "baggage",
    "Accept",
    "Origin",
    "X-Requested-With",
    "Cache-Control",
    "Pragma",
    "Expires"
  ],
  credentials: true,
};

// Global CORS preflight handler ensuring headers are always injected
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && (origin.endsWith('.vercel.app') || ALLOWED_ORIGINS.includes(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,x-access-token,x-platform,Idempotency-Key,sentry-trace,baggage,Accept,Origin,X-Requested-With,Cache-Control,Pragma,Expires');
  }
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); // Handle all OPTIONS preflight requests globally

// Serve uploaded static files
app.use('/uploads', express.static(path.join(__dirname, '../public/uploads')));

// ─── SOCKET.IO & REDIS ADAPTER (RESILIENT) ─────────────────────────────────────
const io = new Server(server, {
  cors: { origin: corsOptions.origin, methods: ["GET", "POST", "OPTIONS"], credentials: true },
  pingTimeout: 60000,          // 60 seconds to survive carrier network hops/jitter
  pingInterval: 25000,         // 25 seconds heartbeat
  maxHttpBufferSize: 1e6,      // 1MB payload ceiling for security
  connectTimeout: 45000,       // 45 seconds connection timeout
  transports: ["websocket", "polling"]
});

// Resilient Redis adapter — falls back to in-memory if Redis is rate-limited/down
const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
let redisAdapterReady = false;

async function connectRedisAdapter(retryCount = 0) {
  const MAX_RETRIES = 5;
  const BASE_DELAY_MS = 5000; // 5s, 10s, 20s, 40s, 80s
  try {
    const pubClient = new Redis(REDIS_URL, {
      maxRetriesPerRequest: 3,
      retryStrategy(times) {
        if (times > 5) return null; // Stop retrying after 5 attempts
        return Math.min(times * 2000, 30000);
      },
      lazyConnect: true, // Don't auto-connect — we'll do it manually
    });
    const subClient = pubClient.duplicate();

    // Swallow errors to prevent process crash
    pubClient.on('error', (err) => {
      console.error('[REDIS PUB] Error (non-fatal):', err.message);
    });
    subClient.on('error', (err) => {
      console.error('[REDIS SUB] Error (non-fatal):', err.message);
    });

    // Manually connect and test before attaching
    await pubClient.connect();
    await subClient.connect();
    await pubClient.ping(); // Verify connection works

    io.adapter(createAdapter(pubClient, subClient));
    redisAdapterReady = true;
    console.log('[SOCKET.IO] Redis adapter connected and attached for scalable matchmaking.');
  } catch (err) {
    console.error(`[SOCKET.IO] Redis adapter failed (attempt ${retryCount + 1}/${MAX_RETRIES}):`, err.message);

    if (retryCount < MAX_RETRIES - 1) {
      const delay = BASE_DELAY_MS * Math.pow(2, retryCount);
      console.warn(`[SOCKET.IO] Retrying Redis adapter in ${delay / 1000}s...`);
      setTimeout(() => connectRedisAdapter(retryCount + 1), delay);
    } else {
      console.warn('[SOCKET.IO] ⚠️ All Redis adapter retries exhausted. Running Socket.IO in-memory mode (single-instance only).');
    }
  }
}

// Start adapter connection in background — don't block server startup
connectRedisAdapter();


// ─── RATE LIMITING (FIREWALL) ──────────────────────────────────────────────────
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: Number(process.env.GENERAL_RATE_MAX || 15000), // Raised default to prevent NAT gateway blocking
  message: { error: "Too many requests, please try again later." },
  skip: (req) => req.path === '/health' // Never throttle health checks
});

const paymentLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: Number(process.env.PAYMENT_RATE_MAX || 60), // Increased from 5 to 60 to prevent NAT blocking on deposits
  message: { error: "Security alert: Too many payment attempts. Please wait 1 minute." }
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  // Per-IP cap. Raised because Ethiopian mobile carriers frequently NAT many
  // users behind one shared IP; 30 locked out legitimate users sharing an IP.
  max: Number(process.env.AUTH_RATE_MAX || 1200),
  message: {
    error: "TOO_MANY_REQUESTS",
    message: "Too many login attempts. For security, please wait 15 minutes before trying again."
  },
  standardHeaders: true,
  legacyHeaders: false,
  // /refresh is self-protected (requires a valid refresh token) and is polled on every boot —
  // don't let it consume the auth budget and lock users out of login/OTP.
  skip: (req) => req.path === '/refresh' || req.path === '/auth/refresh',
});

// Dedicated high-capacity limiter for authenticated profile polling
const profileLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: Number(process.env.PROFILE_RATE_MAX || 600), // Raised default to prevent NAT gateway blocking
  message: { error: "Too many profile requests, please slow down." }
});

app.use('/payments/withdraw', paymentLimiter);
app.use('/payments/deposit', paymentLimiter);
app.use('/api/auth', authLimiter);
app.use('/auth', authLimiter);
app.use('/user/me', profileLimiter); // Dedicated limiter for hot polling endpoint
app.use(generalLimiter);

// ─── BODY PARSERS ──────────────────────────────────────────────────────────────
// Enable raw body capture for all JSON requests to support webhook HMAC signature verification
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf; // Store exact raw buffer for HMAC checks
  }
}));
app.use(express.urlencoded({ extended: true }));

// ─── DETECTION & SECURITY ──────────────────────────────────────────────────────
app.use(platformDetection);
app.use(systemLockdownCheck);

// ─── HEALTH CHECK ──────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok', timestamp: new Date() }));

// ─── ONLINE PLAYERS ────────────────────────────────────────────────────────────
app.get('/players/online', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT value FROM global_settings WHERE key = 'show_online_count'`);
    const show = rows.length ? (rows[0].value === true || rows[0].value === 'true') : true; // default true
    
    let isAdmin = false;
    try {
      const hdr = req.headers.authorization || '';
      const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : hdr;
      if (token) {
        const jwt = require('jsonwebtoken');
        const pubKey = process.env.JWT_PUBLIC_KEY || process.env.JWT_SECRET;
        const payload = jwt.verify(token, pubKey, { algorithms: ["HS256"] });
        
        if (payload.role === 'admin' || payload.role === 'superadmin') {
          isAdmin = true;
        } else {
          // Verify with DB just in case role was upgraded
          const userId = payload.sub || payload.userId || payload.id;
          if (userId) {
             const userCheck = await pool.query('SELECT role FROM users WHERE id = $1', [userId]);
             if (userCheck.rows.length && (userCheck.rows[0].role === 'admin' || userCheck.rows[0].role === 'superadmin')) {
               isAdmin = true;
             }
          }
        }
      }
    } catch (e) {
      // Ignore token errors for public access fallback
    }

    // Hide count for normal users if off. Frontend will render "—"
    if (!show && !isAdmin) {
      return res.json({ count: 0 });
    }
    
    return res.json({ count: io.engine.clientsCount || 0 });
  } catch (err) {
    return res.json({ count: io.engine.clientsCount || 0 }); // fallback
  }
});

// ─── ROUTES ────────────────────────────────────────────────────────────────────
app.use('/payments', payments);
app.use('/api/auth', authRoutes);
app.use("/api/transactions", txRoutes);
app.use('/user', userRoutes);
app.use('/auth', otpAuthRoutes);
app.use('/otp', otpAuthRoutes);
app.use('/api/otp', otpAuthRoutes);
app.use('/auth', telegramAuthRoutes);
app.use('/api/auth', telegramAuthRoutes);
app.use("/account", accountRoutes);
app.use('/admin', adminRoutes);
app.use('/notifications', require('./routes/notifications'));
app.use('/leaderboard', require('./routes/leaderboard'));
app.use('/spin', require('./routes/spin'));
app.use('/voice', require('./routes/voice'));
app.use('/api/voice', require('./routes/voice'));
app.use('/miniapp/v1', miniAppApiRoutes);
// Public route to fetch feature flags and system status
app.get('/api/features', async (req, res) => {
  const CACHE_KEY = 'cache:api_features';
  try {
    // Try Redis cache first, but don't fail if Redis is down
    try {
      const cached = await redis.get(CACHE_KEY);
      if (cached) return res.json(JSON.parse(cached));
    } catch (cacheErr) {
      console.warn('[FEATURES] Redis cache read failed (falling through to DB):', cacheErr.message);
    }

    const { rows } = await pool.query("SELECT key, value FROM global_settings WHERE key LIKE 'feature_%' OR key IN ('system_emergency_lockout', 'lockdown_whitelist')");
    const features = {};
    rows.forEach(r => features[r.key] = r.value);
    
    // Try to cache, but don't fail if Redis is down
    try {
      await redis.setex(CACHE_KEY, 30, JSON.stringify(features));
    } catch (cacheErr) {
      console.warn('[FEATURES] Redis cache write failed (non-fatal):', cacheErr.message);
    }
    res.json(features);
  } catch (err) {
    console.error('[FEATURES] Failed to fetch features:', err.message);
    res.status(500).json({ error: 'Failed to fetch features' });
  }
});

// Public route: fetch active promotion popup (no auth needed)
app.get('/promo-popup/active', async (req, res) => {
  const CACHE_KEY = 'cache:promo_popup_active';
  try {
    try {
      const cached = await redis.get(CACHE_KEY);
      if (cached) return res.json(JSON.parse(cached));
    } catch (cacheErr) {
      console.warn('[PROMO] Redis cache read failed (falling through to DB):', cacheErr.message);
    }

    const { rows } = await pool.query(`
      SELECT id, image_url, display_duration, starts_at, expires_at, is_active
      FROM promo_popups
      WHERE is_active = true
        AND (starts_at IS NULL OR starts_at <= NOW())
        AND (expires_at IS NULL OR expires_at > NOW())
      ORDER BY created_at DESC
      LIMIT 1
    `);
    
    const responseData = rows.length === 0 ? { ok: true, popup: null } : { ok: true, popup: rows[0] };
    try {
      await redis.setex(CACHE_KEY, 30, JSON.stringify(responseData));
    } catch (cacheErr) {
      console.warn('[PROMO] Redis cache write failed (non-fatal):', cacheErr.message);
    }
    return res.json(responseData);
  } catch (err) {
    console.error('[PUBLIC] GET /promo-popup/active err', err);
    return res.status(500).json({ error: 'Failed to fetch promo popup' });
  }
});

// ─── GAME SOCKET ───────────────────────────────────────────────────────────────
setupGameSocket(io);
setupSpinSocket(io);

// ─── TELEGRAM BOT ──────────────────────────────────────────────────────────────
const { initTelegramBot } = require('./bot/telegram');
initTelegramBot();

// ─── BACKGROUND CRON SCHEDULER ──────────────────────────────────────────────────
const { initCron } = require('./cron');
initCron();

// ─── IDEMPOTENCY INDEX GUARD (fail closed) ─────────────────────────────────────
// All ledgerFirstCredit credit paths depend on uq_wallet_tx_idem (migration 008).
// If it is missing/invalid, credits are refused and a critical alert is raised.
const { checkIdempotencyIndex } = require('./models/idempotencyIndex');
checkIdempotencyIndex();

// ─── ENSURE USER SCHEMA ────────────────────────────────────────────────────────
// Unconditionally ensure all core & win tracker columns exist on the users table.
// In Postgres 11+, ADD COLUMN with constant default is an instant, lock-free metadata-only update.
async function ensureUserSchema() {
  try {
    await pool.query(`
      ALTER TABLE users 
        ADD COLUMN IF NOT EXISTS room_1_wins INTEGER DEFAULT 0,
        ADD COLUMN IF NOT EXISTS room_2_wins INTEGER DEFAULT 0,
        ADD COLUMN IF NOT EXISTS room_3_wins INTEGER DEFAULT 0,
        ADD COLUMN IF NOT EXISTS r1_10_wins INTEGER DEFAULT 0,
        ADD COLUMN IF NOT EXISTS r1_15_wins INTEGER DEFAULT 0,
        ADD COLUMN IF NOT EXISTS r1_25_wins INTEGER DEFAULT 0,
        ADD COLUMN IF NOT EXISTS r1_50_wins INTEGER DEFAULT 0,
        ADD COLUMN IF NOT EXISTS r1_99_wins INTEGER DEFAULT 0,
        ADD COLUMN IF NOT EXISTS r2_100_wins INTEGER DEFAULT 0,
        ADD COLUMN IF NOT EXISTS r3_1000_wins INTEGER DEFAULT 0,
        ADD COLUMN IF NOT EXISTS claimed_giveaway_version INTEGER DEFAULT 0,
        ADD COLUMN IF NOT EXISTS raw_user_meta_data JSONB DEFAULT '{}'::jsonb,
        ADD COLUMN IF NOT EXISTS telegram_id BIGINT,
        ADD COLUMN IF NOT EXISTS telegram_username TEXT,
        ADD COLUMN IF NOT EXISTS is_bot BOOLEAN DEFAULT false,
        ADD COLUMN IF NOT EXISTS sound_muted BOOLEAN DEFAULT false,
        ADD COLUMN IF NOT EXISTS display_name TEXT,
        ADD COLUMN IF NOT EXISTS avatar TEXT,
        ADD COLUMN IF NOT EXISTS banned BOOLEAN DEFAULT false,
        ADD COLUMN IF NOT EXISTS new_user BOOLEAN DEFAULT true,
        ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

      ALTER TABLE wallets
        ADD COLUMN IF NOT EXISTS available_balance NUMERIC DEFAULT 0,
        ADD COLUMN IF NOT EXISTS withdrawable_balance NUMERIC DEFAULT 0,
        ADD COLUMN IF NOT EXISTS bonus_balance NUMERIC DEFAULT 0,
        ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

      ALTER TABLE games
        ADD COLUMN IF NOT EXISTS bonus_used_x NUMERIC DEFAULT 0,
        ADD COLUMN IF NOT EXISTS bonus_used_o NUMERIC DEFAULT 0,
        ADD COLUMN IF NOT EXISTS withdrawable_used_x NUMERIC DEFAULT 0,
        ADD COLUMN IF NOT EXISTS withdrawable_used_o NUMERIC DEFAULT 0,
        ADD COLUMN IF NOT EXISTS locked_used_x NUMERIC DEFAULT 0,
        ADD COLUMN IF NOT EXISTS locked_used_o NUMERIC DEFAULT 0,
        ADD COLUMN IF NOT EXISTS prize_amount NUMERIC DEFAULT 0,
        ADD COLUMN IF NOT EXISTS moves JSONB DEFAULT '[]'::jsonb;

      CREATE TABLE IF NOT EXISTS bonus_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        amount NUMERIC NOT NULL,
        reason TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS global_settings (
        key TEXT PRIMARY KEY,
        value JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      INSERT INTO global_settings (key, value) VALUES 
        ('welcome_bonus_active', 'true'::jsonb),
        ('welcome_bonus_amount', '10'::jsonb),
        ('current_giveaway_version', '1'::jsonb)
      ON CONFLICT (key) DO NOTHING;
      CREATE TABLE IF NOT EXISTS payment_transactions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        type TEXT NOT NULL DEFAULT 'deposit',
        status TEXT NOT NULL DEFAULT 'success',
        amount NUMERIC NOT NULL DEFAULT 0,
        bank TEXT DEFAULT 'WIN',
        tx_ref TEXT UNIQUE,
        provider_ref TEXT,
        provider_payload JSONB,
        provider_response JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_payment_transactions_user ON payment_transactions(user_id);

      CREATE TABLE IF NOT EXISTS promotion_links (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        bonus_amount NUMERIC DEFAULT 0,
        code TEXT UNIQUE,
        is_active BOOLEAN DEFAULT true,
        total_claims INT DEFAULT 0,
        total_registrations INT DEFAULT 0,
        expires_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS admin_audit_logs (
        id SERIAL PRIMARY KEY,
        admin_id UUID,
        action TEXT NOT NULL,
        target_id TEXT,
        details JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      ALTER TABLE admin_audit_logs ADD COLUMN IF NOT EXISTS target_id TEXT;

      -- Ensure 0939484533 / 251939484533 admin account with 10k ETB balance
      DO $$
      DECLARE
        v_uid UUID;
      BEGIN
        -- 0939484533
        INSERT INTO users (number, username, display_name, role, new_user)
        VALUES ('0939484533', 'admin_9484533', 'Admin 0939484533', 'superadmin', false)
        ON CONFLICT (number) DO UPDATE
        SET role = 'superadmin', new_user = false
        RETURNING id INTO v_uid;

        IF v_uid IS NOT NULL THEN
          INSERT INTO wallets (user_id, available_balance, withdrawable_balance, bonus_balance)
          VALUES (v_uid, 10000, 10000, 0)
          ON CONFLICT (user_id) DO UPDATE
          SET available_balance = GREATEST(wallets.available_balance, 10000),
              withdrawable_balance = GREATEST(wallets.withdrawable_balance, 10000);
        END IF;

        -- 251939484533
        INSERT INTO users (number, username, display_name, role, new_user)
        VALUES ('251939484533', 'admin_251939484533', 'Admin 0939484533', 'superadmin', false)
        ON CONFLICT (number) DO UPDATE
        SET role = 'superadmin', new_user = false
        RETURNING id INTO v_uid;

        IF v_uid IS NOT NULL THEN
          INSERT INTO wallets (user_id, available_balance, withdrawable_balance, bonus_balance)
          VALUES (v_uid, 10000, 10000, 0)
          ON CONFLICT (user_id) DO UPDATE
          SET available_balance = GREATEST(wallets.available_balance, 10000),
              withdrawable_balance = GREATEST(wallets.withdrawable_balance, 10000);
        END IF;
      END $$;
    `);
    console.log('[DB] ✅ Core schema (users, wallets, games, bonus_logs, payment_transactions, admin seed) verified successfully.');
  } catch (err) {
    console.warn('[DB] ⚠️ ensureUserSchema notice:', err.message);
  }
}

// ─── STARTUP MIGRATIONS ────────────────────────────────────────────────────────
// Awaited on startup so the database schema is guaranteed to be ready before accepting requests.
async function runMigrations() {
  try {
    // 0. Skip if migrations already completed to avoid lock contention on every restart
    try {
      const guard = await pool.query("SELECT value FROM global_settings WHERE key = 'migrations_v4_completed'");
      if (guard.rows.length && (guard.rows[0].value === true || guard.rows[0].value === 'true')) {
        console.log('[DB] Migrations already applied (v4 guard active) — skipping startup schema execution.');
        return;
      }
    } catch (_) {}

    // Set short lock timeout so queries fail fast rather than hanging indefinitely
    try { await pool.query("SET lock_timeout = '4s';"); } catch (_) {}

    // ── Spin Game tables ──
    await pool.query(`
      CREATE TABLE IF NOT EXISTS spin_room_configs (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        bet_amount NUMERIC NOT NULL,
        max_players INT DEFAULT 5,
        house_cut_percent NUMERIC DEFAULT 10,
        is_active BOOLEAN DEFAULT true
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS spin_rounds (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        config_id INT REFERENCES spin_room_configs(id),
        status TEXT DEFAULT 'waiting',
        players JSONB DEFAULT '[]',
        winning_slice INT,
        winner_user_id UUID,
        pot_amount NUMERIC DEFAULT 0,
        prize_amount NUMERIC DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        locked_at TIMESTAMPTZ,
        resolved_at TIMESTAMPTZ
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS spin_bets (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        round_id UUID REFERENCES spin_rounds(id),
        user_id UUID NOT NULL,
        amount NUMERIC NOT NULL,
        is_bot BOOLEAN DEFAULT false,
        seat_index INT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_spin_rounds_config ON spin_rounds(config_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_spin_rounds_status ON spin_rounds(status);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_spin_bets_round ON spin_bets(round_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_spin_bets_user ON spin_bets(user_id);`);

    // Seed default spin room configs (exactly 5_PLAYER and RAIL with 20% house cut)
    console.log('[DB] Seeding exactly two spin room configs: 5_PLAYER and RAIL...');
    try {
      await pool.query(
        `INSERT INTO spin_room_configs (id, name, bet_amount, max_players, house_cut_percent, is_active)
         VALUES 
           (1, '5_PLAYER', 100, 5, 20, true),
           (2, 'RAIL', 0, 9999, 20, true)
         ON CONFLICT (id) DO UPDATE SET house_cut_percent = 20`
      );
    } catch (scErr) {
      console.warn('[DB] Non-fatal spin config seed warning:', scErr.message);
    }

    // Seed spin_5p_entry_amount in global_settings
    await pool.query(
      `INSERT INTO global_settings (key, value)
       VALUES ('spin_5p_entry_amount', '100'::jsonb)
       ON CONFLICT (key) DO NOTHING`
    );
    console.log('[DB] Seeded two spin room configs and spin_5p_entry_amount global setting.');

    // Add is_bot column to users table and seed realistic Ethiopian bot users
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_bot BOOLEAN DEFAULT false;`);
    const BOT_NICKNAMES = [
      "Yonas14", "Selam_B", "Nardos22", "Biniam_M", "Kaleb01", "Hana_G", "Mekdes7", 
      "Dawit_A", "Fitsum99", "Rediet_N", "Samri23", "Nahom_T", "Betty_44", "Meklit_S", 
      "Robel19", "Sara_K", "Yohannes5", "Liya_B", "Abel_D", "Mimi_23", "Naod88", 
      "Bethel_G", "Hermon12", "Tsion_A", "Sami_45", "Kidus07", "Feven_M", "Elias_K", 
      "Natnael9", "Rahel22", "Dagim_T", "Samuel04", "Winta_B", "Amanuel7", 
      "player123", "newuser5", "guest22", "justme_1"
    ];
    for (const name of BOT_NICKNAMES) {
      try {
        const botRes = await pool.query(
          `INSERT INTO users (username, number, is_bot)
           VALUES ($1, $2, true)
           ON CONFLICT DO NOTHING
           RETURNING id`,
          [name, `BOT_${name}`]
        );
        if (botRes.rows[0]?.id) {
          await pool.query(
            `INSERT INTO wallets (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
            [botRes.rows[0].id]
          );
        }
      } catch (_) {}
    }
    console.log('[DB] Seeded realistic Ethiopian bot users in DB.');

    // Unconditional schema updates & index creation for performance & gameplay features
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS room_2_wins INTEGER DEFAULT 0;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS room_3_wins INTEGER DEFAULT 0;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS r1_15_wins INTEGER DEFAULT 0;`);

    // Telegram login support
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_id BIGINT;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_username TEXT;`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_telegram_id ON users(telegram_id) WHERE telegram_id IS NOT NULL;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS r2_100_wins INTEGER DEFAULT 0;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS r3_1000_wins INTEGER DEFAULT 0;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS raw_user_meta_data JSONB DEFAULT '{}'::jsonb;`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_games_player_x ON games(player_x);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_games_player_o ON games(player_o);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_games_players ON games(player_x, player_o);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_games_winner ON games(winner);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_games_status ON games(status);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_games_created_at ON games(created_at);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_wallet_transactions_user_id ON wallet_transactions(user_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_transactions_user ON wallet_transactions(user_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_wallet_transactions_created_at ON wallet_transactions(created_at);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_wallet_tx_status_type ON wallet_transactions(status, tx_type);`);

    // Ensure welcome bonus default values are active and set to 10 Birr
    await pool.query(`
      INSERT INTO global_settings (key, value) 
      VALUES ('welcome_bonus_amount', '10'::jsonb)
      ON CONFLICT (key) DO UPDATE SET value = '10'::jsonb;
    `);
    await pool.query(`
      INSERT INTO global_settings (key, value) 
      VALUES ('welcome_bonus_active', 'true'::jsonb)
      ON CONFLICT (key) DO UPDATE SET value = 'true'::jsonb;
    `);

    // ── IP Tracking (idempotent, runs every startup) ──
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_ip TEXT;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;`);

    // ── Mini-App Platform tables & schema enhancements (unconditional) ──
    await pool.query(`
      CREATE TABLE IF NOT EXISTS mini_apps (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL UNIQUE,
        description TEXT,
        api_key TEXT NOT NULL UNIQUE,
        api_secret_hash TEXT NOT NULL,
        permissions TEXT[] DEFAULT '{}',
        rate_limit INT DEFAULT 100,
        is_active BOOLEAN DEFAULT true,
        webhook_url TEXT,
        created_by UUID REFERENCES users(id),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS mini_app_api_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        mini_app_id UUID REFERENCES mini_apps(id),
        endpoint TEXT NOT NULL,
        method TEXT NOT NULL,
        target_user_id UUID,
        request_body JSONB,
        response_status INT,
        ip_address TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_miniapp_logs_app ON mini_app_api_logs(mini_app_id);
      CREATE INDEX IF NOT EXISTS idx_miniapp_logs_time ON mini_app_api_logs(created_at);
      ALTER TABLE mini_apps ADD COLUMN IF NOT EXISTS icon_url TEXT;
      ALTER TABLE mini_apps ADD COLUMN IF NOT EXISTS category TEXT DEFAULT 'general';
      ALTER TABLE mini_apps ADD COLUMN IF NOT EXISTS ip_whitelist TEXT[] DEFAULT '{}';
      ALTER TABLE mini_apps ADD COLUMN IF NOT EXISTS is_locked BOOLEAN DEFAULT false;
    `);
    console.log('[DB] Mini-App platform tables & columns verified.');

    // Check if migrations already completed (skip on subsequent deploys)
    const guardRes = await pool.query(
      `SELECT value FROM global_settings WHERE key = 'migrations_v4_completed'`
    );
    if (guardRes.rows.length > 0 && (guardRes.rows[0].value === true || guardRes.rows[0].value === 'true')) {
      console.log('[DB] Migrations already completed (v4). Skipping.');
      return;
    }

    // Basic user preferences
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS sound_muted BOOLEAN DEFAULT false;`);
    
    // Performance & Maintenance giveaway system
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS claimed_giveaway_version INTEGER DEFAULT 0;`);
    
    // Initialize global giveaway settings if not exists
    await pool.query(`
      INSERT INTO global_settings (key, value) 
      VALUES ('current_giveaway_version', '1'::jsonb)
      ON CONFLICT (key) DO NOTHING;
    `);

    // Create systems alerts table for security monitoring
    await pool.query(`
      CREATE TABLE IF NOT EXISTS system_alerts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        event_type TEXT NOT NULL,
        details JSONB DEFAULT '{}',
        severity TEXT DEFAULT 'INFO',
        ip_address TEXT,
        resolved BOOLEAN DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT now()
      );
    `);
    
    // Add prize_amount column to games table (tracks actual payout for admin dashboard)
    await pool.query(`ALTER TABLE games ADD COLUMN IF NOT EXISTS prize_amount NUMERIC DEFAULT 0;`);

    // Backfill historical games: calculate prize for completed games with a winner
    // Only runs on rows where prize_amount is still 0/NULL (idempotent)
    await pool.query(`
      UPDATE games
      SET prize_amount = CASE
        WHEN bet_amount >= 1000 THEN FLOOR(bet_amount * 2 * 0.9)
        WHEN bet_amount >= 100  THEN FLOOR(bet_amount * 2 * 0.85)
        ELSE                         FLOOR(bet_amount * 2 * 0.8)
      END
      WHERE status = 'completed' 
        AND winner IS NOT NULL 
        AND (prize_amount IS NULL OR prize_amount = 0);
    `);

    // Create bulk_sms_history table for tracking admin SMS campaigns
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bulk_sms_history (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        admin_id UUID REFERENCES users(id),
        message TEXT NOT NULL,
        filters JSONB DEFAULT '{}',
        target_count INTEGER DEFAULT 0,
        success_count INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT now()
      );
    `);

    // ── Leaderboard system tables ──
    await pool.query(`
      CREATE TABLE IF NOT EXISTS leaderboard_snapshots (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        week_start DATE NOT NULL,
        week_end DATE NOT NULL,
        user_id UUID REFERENCES users(id),
        username TEXT,
        wins INT DEFAULT 0,
        rank INT,
        prize_amount DECIMAL(10,2) DEFAULT 0,
        prize_status TEXT DEFAULT 'pending',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS fake_ticker_entries (
        id SERIAL PRIMARY KEY,
        username TEXT NOT NULL,
        amount INT NOT NULL,
        active BOOLEAN DEFAULT true
      );
    `);

    // Self-healing default fake ticker seeder
    const tickerCountRes = await pool.query('SELECT COUNT(*) FROM fake_ticker_entries');
    if (parseInt(tickerCountRes.rows[0].count, 10) === 0) {
      console.log('[DB] Seeding default fake ticker entries...');
      const defaultFakes = [
        { username: 'Bekele_Pro', amount: 100 },
        { username: 'Aster_X', amount: 50 },
        { username: 'Dawit_XO', amount: 150 },
        { username: 'Almaz_ET', amount: 200 },
        { username: 'Genet_Top', amount: 80 },
        { username: 'Yohannes_Champ', amount: 250 },
        { username: 'Tigist_Play', amount: 36 },
        { username: 'Abebe_Hero', amount: 120 },
        { username: 'Helen_ET', amount: 45 },
        { username: 'Solomon_Winner', amount: 180 },
        { username: 'Bereket_XO', amount: 90 },
        { username: 'Natnael_Pro', amount: 15 },
        { username: 'Genet_X', amount: 60 },
        { username: 'Tariku_Champ', amount: 300 },
        { username: 'Mesfin_Hero', amount: 75 },
      ];
      for (const f of defaultFakes) {
        await pool.query(
          'INSERT INTO fake_ticker_entries (username, amount, active) VALUES ($1, $2, true)',
          [f.username, f.amount]
        );
      }
      console.log('[DB] Default fake ticker entries seeded successfully.');
    }

    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_entries (
        id SERIAL PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ DEFAULT now()
      );
    `);

    await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_entries_created ON user_entries(created_at);`);

    // Leaderboard settings
    await pool.query(`
      INSERT INTO global_settings (key, value) VALUES ('leaderboard_auto_approve', 'false'::jsonb)
      ON CONFLICT (key) DO NOTHING;
    `);
    await pool.query(`
      INSERT INTO global_settings (key, value) VALUES ('fake_ticker_enabled', 'false'::jsonb)
      ON CONFLICT (key) DO NOTHING;
    `);

    // Create promo_popups table if it doesn't exist
    await pool.query(`
      CREATE TABLE IF NOT EXISTS promo_popups (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        image_url TEXT,
        display_duration INTEGER DEFAULT 5,
        expires_at TIMESTAMPTZ,
        starts_at TIMESTAMPTZ,
        is_active BOOLEAN DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // Add starts_at column to promo_popups (for older installs that lack it)
    await pool.query(`ALTER TABLE promo_popups ADD COLUMN IF NOT EXISTS starts_at TIMESTAMPTZ;`);

    // Ensure promocodes table and all columns exist
    await pool.query(`
      CREATE TABLE IF NOT EXISTS promocodes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        code TEXT UNIQUE NOT NULL,
        amount NUMERIC NOT NULL DEFAULT 0,
        description TEXT,
        target_type TEXT DEFAULT 'ALL',
        usage_limit INT,
        usage_count INT DEFAULT 0,
        status TEXT DEFAULT 'ACTIVE',
        starts_at TIMESTAMPTZ,
        expires_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await pool.query(`ALTER TABLE promocodes ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'ACTIVE';`);
    await pool.query(`ALTER TABLE promocodes ADD COLUMN IF NOT EXISTS usage_count INT DEFAULT 0;`);
    await pool.query(`ALTER TABLE promocodes ADD COLUMN IF NOT EXISTS usage_limit INT;`);
    await pool.query(`ALTER TABLE promocodes ADD COLUMN IF NOT EXISTS starts_at TIMESTAMPTZ;`);
    await pool.query(`ALTER TABLE promocodes ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;`);

    // Create notifications table for in-app notification system
    await pool.query(`
      CREATE TABLE IF NOT EXISTS notifications (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        type TEXT NOT NULL DEFAULT 'system',
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        read BOOLEAN DEFAULT false,
        meta JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON notifications(user_id) WHERE read = false;`);

    // ── Mini-App Platform tables (Super App) ──
    await pool.query(`
      CREATE TABLE IF NOT EXISTS mini_apps (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL UNIQUE,
        description TEXT,
        api_key TEXT NOT NULL UNIQUE,
        api_secret_hash TEXT NOT NULL,
        permissions TEXT[] DEFAULT '{}',
        rate_limit INT DEFAULT 100,
        is_active BOOLEAN DEFAULT true,
        webhook_url TEXT,
        created_by UUID REFERENCES users(id),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS mini_app_api_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        mini_app_id UUID REFERENCES mini_apps(id),
        endpoint TEXT NOT NULL,
        method TEXT NOT NULL,
        target_user_id UUID,
        request_body JSONB,
        response_status INT,
        ip_address TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_miniapp_logs_app ON mini_app_api_logs(mini_app_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_miniapp_logs_time ON mini_app_api_logs(created_at);`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS mini_app_user_data (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        mini_app_id UUID REFERENCES mini_apps(id) ON DELETE CASCADE,
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        data_key TEXT NOT NULL,
        data_value JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(mini_app_id, user_id, data_key)
      );
    `);
    await pool.query(`
      ALTER TABLE mini_apps ADD COLUMN IF NOT EXISTS icon_url TEXT;
      ALTER TABLE mini_apps ADD COLUMN IF NOT EXISTS category TEXT DEFAULT 'general';
      ALTER TABLE mini_apps ADD COLUMN IF NOT EXISTS ip_whitelist TEXT[] DEFAULT '{}';
      ALTER TABLE mini_apps ADD COLUMN IF NOT EXISTS is_locked BOOLEAN DEFAULT false;
    `);
    console.log('[DB] Mini-App platform tables created/verified.');

    // Mark migrations as completed so subsequent deploys skip this block
    await pool.query(`
      INSERT INTO global_settings (key, value) VALUES ('migrations_v4_completed', 'true'::jsonb)
      ON CONFLICT (key) DO UPDATE SET value = 'true'::jsonb;
    `);

    console.log('[DB] Migrations applied and guard flag set.');
  } catch (err) {
    console.error('[DB] Migration error:', err);
    throw err;
  }
}


// ─── CENTRALIZED SECURITY ERROR HANDLER ───────────────────────────────────────
// Absolutely prevents stack trace or architectural leakage on uncaught crashes
app.use((err, req, res, next) => {
  const { logAnomaly } = require('./middleware/AnomalyMonitor');
  console.error('[FATAL CORE ERROR]', err?.message, err?.stack || err);

  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
       logAnomaly(req, 'Malformed JSON Injection Attempt');
       return res.status(400).json({ error: 'Invalid Payload Format' });
  }
  
  const statusCode = err.status || 500;
  return res.status(statusCode).json({
    error: statusCode >= 500 ? 'Internal Server Error' : err.message,
    incident_id: require('crypto').randomUUID()
  });
});

// ─── PROCESS-LEVEL SAFETY NETS ─────────────────────────────────────────────────
// Prevent Redis/ioredis/network errors from crashing the whole server
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]', err?.message || err);
  if (err?.stack) console.error(err.stack);
  
  const msg = (err?.message || '').toLowerCase();
  const name = (err?.name || '').toLowerCase();
  const isRecoverable = 
    msg.includes('rate-limited') ||
    msg.includes('econnrefused') ||
    msg.includes('psubscribe') ||
    msg.includes('redis') ||
    msg.includes('enotfound') ||
    msg.includes('connection is closed') ||
    msg.includes("stream isn't writeable") ||
    msg.includes('closed') ||
    msg.includes('reset') ||
    msg.includes('etimedout') ||
    name.includes('redis') ||
    name.includes('maxretriesperrequest');

  if (isRecoverable) {
    console.warn('[RECOVERED] Non-fatal network/Redis error caught safely. Server continues running.');
    return;
  }
  
  console.error('[FATAL] Non-recoverable error. Exiting in 3s...');
  setTimeout(() => process.exit(1), 3000);
});

process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION]', reason);
});

async function startServer() {
  // Railway Public Networking is mapped specifically to Port 2000 (as shown in dashboard settings)
  const PORT_2000 = 2000;

  // 1. Listen on Port 2000 as primary listener
  server.listen(PORT_2000, '0.0.0.0', () => {
    console.log(`[BOOT] Server listening immediately on Port 2000 (0.0.0.0) — Railway Public Domain match`);
    
    // Ensure critical user schema first, then run full migrations in background
    ensureUserSchema().then(() => {
      runMigrations().catch(err => {
        console.error('[STARTUP] Migrations failed (non-fatal, server continues):', err.message);
      });
    });
  });

  // 2. Also listen on process.env.PORT if specified and different from 2000
  const envPort = parseInt(process.env.PORT, 10);
  if (!isNaN(envPort) && envPort !== PORT_2000) {
    try {
      const envServer = http.createServer(app);
      envServer.listen(envPort, '0.0.0.0', () => {
        console.log(`[BOOT] Auxiliary listener active on env port ${envPort} (0.0.0.0)`);
      }).on('error', (err) => {
        console.warn(`[BOOT] Non-fatal auxiliary port ${envPort} warning:`, err.message);
      });
    } catch (_) {}
  }

  // 3. Fallback listener on port 8080 if neither is 8080
  if (envPort !== 8080 && PORT_2000 !== 8080) {
    try {
      const fallback8080 = http.createServer(app);
      fallback8080.listen(8080, '0.0.0.0', () => {
        console.log('[BOOT] Auxiliary listener active on port 8080 (0.0.0.0)');
      }).on('error', () => {});
    } catch (_) {}
  }
}

startServer();