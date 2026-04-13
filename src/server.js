const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
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
  contentSecurityPolicy: false, // Disable to prevent breaking existing inline scripts
  crossOriginEmbedderPolicy: false
}));

// ─── NUCLEAR CORS ──────────────────────────────────────────────────────────────
// Must be FIRST, before any routes or other middleware.
const corsOptions = {
  origin: ["https://xo-et-frontend.vercel.app", "http://localhost:3000", "http://localhost:8081"],
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "x-access-token", "x-platform", "Idempotency-Key"],
  credentials: true,
};
app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); // Handle all OPTIONS preflight requests globally

// ─── SOCKET.IO ─────────────────────────────────────────────────────────────────
const io = new Server(server, {
  cors: { origin: "*" }
});

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
  max: 30, // 30 OTP attempts per 15 min is plenty
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
app.get('/players/online', (_, res) => res.json({ count: io.engine.clientsCount || 0 }));

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

let PORT = parseInt(process.env.PORT, 10);
if (isNaN(PORT)) PORT = 2000;
server.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));