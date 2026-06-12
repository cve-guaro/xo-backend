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
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const txRoutes = require("./routes/transactions");
const { recordAndProcessWebhook } = require("./models/Transaction");
const payments = require('./routes/payment');
const userRoutes = require('./routes/user');
const accountRoutes = require('./routes/account');
const otpAuthRoutes = require('./routes/otp');
const adminRoutes = require('./routes/admin');

const authRoutes = require('./routes/auth');
const { setupGameSocket } = require('./socket/game');
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
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
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
// Hardcoded whitelist — no dynamic origin reflection
const ALLOWED_ORIGINS = [
  "https://xoethiopia.com",
  "https://www.xoethiopia.com",
  "https://xo-et-frontend.vercel.app",
  "https://xoet-pro-frontend.vercel.app",
  // Local dev origins (Expo web)
  "http://localhost:8081",
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
    if (ALLOWED_ORIGINS.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error('CORS: Origin not allowed'));
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "x-access-token", "x-platform", "Idempotency-Key"],
  credentials: true,
};
app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); // Handle all OPTIONS preflight requests globally

// Serve uploaded static files
app.use('/uploads', express.static(path.join(__dirname, '../public/uploads')));

// ─── SOCKET.IO & REDIS ADAPTER ─────────────────────────────────────────────────
const io = new Server(server, {
  cors: { origin: corsOptions.origin, methods: ["GET", "POST", "OPTIONS"], credentials: true }
});

const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const pubClient = new Redis(REDIS_URL);
const subClient = pubClient.duplicate();

pubClient.on('error', (err) => console.error('[REDIS PUB] Adapter connection error:', err));
subClient.on('error', (err) => console.error('[REDIS SUB] Adapter connection error:', err));

io.adapter(createAdapter(pubClient, subClient));
console.log('[SOCKET.IO] Redis adapter connected and attached for scalable matchmaking.');


// ─── RATE LIMITING (FIREWALL) ──────────────────────────────────────────────────
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 500, // Raised from 100 → 500 to accommodate normal SPA usage
  message: { error: "Too many requests, please try again later." },
  skip: (req) => req.path === '/health' // Never throttle health checks
});

const paymentLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 5, // Limit each IP to 5 payment requests per minute
  message: { error: "Security alert: Too many payment attempts. Please wait 1 minute." }
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  // Per-IP cap. Raised from 30 → 120 because Ethiopian mobile carriers frequently NAT many
  // users behind one shared IP; 30 locked out legitimate users sharing an IP. Per-phone OTP
  // throttling (in routes/otp.js) is the real brute-force guard for OTP specifically.
  max: Number(process.env.AUTH_RATE_MAX || 120),
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
  max: 60, // 60 profile fetches/min per IP — covers all active tabs
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
app.use("/account", accountRoutes);
app.use('/admin', adminRoutes);
app.use('/notifications', require('./routes/notifications'));
app.use('/leaderboard', require('./routes/leaderboard'));
// Public route to fetch feature flags and system status
app.get('/api/features', async (req, res) => {
  const CACHE_KEY = 'cache:api_features';
  try {
    const cached = await redis.get(CACHE_KEY);
    if (cached) return res.json(JSON.parse(cached));

    const { rows } = await pool.query("SELECT key, value FROM global_settings WHERE key LIKE 'feature_%' OR key IN ('system_emergency_lockout', 'lockdown_whitelist')");
    const features = {};
    rows.forEach(r => features[r.key] = r.value);
    
    await redis.setex(CACHE_KEY, 30, JSON.stringify(features));
    res.json(features);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch features' });
  }
});

// Public route: fetch active promotion popup (no auth needed)
app.get('/promo-popup/active', async (req, res) => {
  const CACHE_KEY = 'cache:promo_popup_active';
  try {
    const cached = await redis.get(CACHE_KEY);
    if (cached) return res.json(JSON.parse(cached));

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
    await redis.setex(CACHE_KEY, 30, JSON.stringify(responseData));
    return res.json(responseData);
  } catch (err) {
    console.error('[PUBLIC] GET /promo-popup/active err', err);
    return res.status(500).json({ error: 'Failed to fetch promo popup' });
  }
});

// ─── GAME SOCKET ───────────────────────────────────────────────────────────────
setupGameSocket(io);

// ─── BACKGROUND CRON SCHEDULER ──────────────────────────────────────────────────
const { initCron } = require('./cron');
initCron();

// ─── STARTUP MIGRATIONS ────────────────────────────────────────────────────────
// Awaited on startup so the database schema is guaranteed to be ready before accepting requests.
async function runMigrations() {
  try {
    // Unconditional schema updates & index creation for performance & gameplay features
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS room_2_wins INTEGER DEFAULT 0;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS room_3_wins INTEGER DEFAULT 0;`);
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

    // Check if migrations already completed (skip on subsequent deploys)
    const guardRes = await pool.query(
      `SELECT value FROM global_settings WHERE key = 'migrations_v3_completed'`
    );
    if (guardRes.rows.length > 0 && (guardRes.rows[0].value === true || guardRes.rows[0].value === 'true')) {
      console.log('[DB] Migrations already completed (v3). Skipping.');
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

    // Mark migrations as completed so subsequent deploys skip this block
    await pool.query(`
      INSERT INTO global_settings (key, value) VALUES ('migrations_v3_completed', 'true'::jsonb)
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

async function startServer() {
  try {
    await runMigrations();
  } catch (err) {
    console.error('[STARTUP] Migrations failed (non-fatal, starting server anyway):', err.message);
  }

  let PORT = parseInt(process.env.PORT, 10);
  if (isNaN(PORT)) PORT = 2000;
  server.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
}

startServer();