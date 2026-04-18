const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const Redis = require('ioredis');
const bodyParser = require("body-parser"); 
const cors = require('cors');
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
const { pool } = require('./db/index');


const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);

// ─── SECURITY HEADERS ─────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https://xoethiopia.com", "https://www.xoethiopia.com", "https://xo-et-frontend.vercel.app", "https://xoet-pro-frontend.vercel.app"],
      connectSrc: ["'self'", "https://xo-et-frontend.vercel.app", "https://xoet-pro-frontend.vercel.app", "https://xoethiopia.com", "https://www.xoethiopia.com"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: []
    }
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" },
  crossOriginOpenerPolicy: { policy: "same-origin" },
  hsts: {
    maxAge: 31536000, // 1 year
    includeSubDomains: true,
    preload: true
  },
  xssFilter: true,
  noSniff: true,
  frameguard: { action: 'deny' }, // Block iframe embedding (clickjacking)
  referrerPolicy: { policy: "strict-origin-when-cross-origin" }
}));

// Manually applying Permissions-Policy since helmet doesn't support it natively yet
app.use((req, res, next) => {
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  next();
});

// ─── STRICT CORS ───────────────────────────────────────────────────────────────
// Hardcoded whitelist — no dynamic origin reflection
const ALLOWED_ORIGINS = [
  "https://xoethiopia.com",
  "https://www.xoethiopia.com",
  "https://xo-et-frontend.vercel.app",
  "https://xoet-pro-frontend.vercel.app",
];
// Only allow localhost in development
if (process.env.NODE_ENV !== 'production') {
  ALLOWED_ORIGINS.push("http://localhost:3000", "http://localhost:8081");
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

// ─── SOCKET.IO & REDIS ADAPTER ─────────────────────────────────────────────────
const io = new Server(server, {
  cors: { origin: ALLOWED_ORIGINS, methods: ["GET", "POST"], credentials: true }
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
  max: 500, // Increased to 500 to prevent proxy-related IP exhaustion
  message: {
    error: "TOO_MANY_REQUESTS",
    message: "Too many login attempts. For security, please wait 15 minutes before trying again."
  },
  standardHeaders: true,
  legacyHeaders: false,
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
app.use(express.raw({ type: 'application/json' }));
app.use((req, res, next) => {
  if (req.body instanceof Buffer) {
    req.rawBody = req.body; // Store exact raw buffer for HMAC checks
    try {
      req.body = JSON.parse(req.body.toString());
    } catch (e) {
      req.body = {}; // Handle malformed JSON gracefully
    }
  }
  next();
});

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
        const payload = jwt.verify(token, pubKey);
        
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

// ─── GAME SOCKET ───────────────────────────────────────────────────────────────
setupGameSocket(io);

// ─── BACKGROUND CRON SCHEDULER ──────────────────────────────────────────────────
const { initCron } = require('./cron');
initCron();

// ─── STARTUP MIGRATIONS ────────────────────────────────────────────────────────
(async () => {
  try {
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
    
    console.log('[DB] Migrations applied.');
  } catch (err) {
    console.error('[DB] Migration error:', err);
  }
})();

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

let PORT = parseInt(process.env.PORT, 10);
if (isNaN(PORT)) PORT = 2000;
server.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));