const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bodyParser = require("body-parser"); 
const cors = require('cors');
require('dotenv').config();
const rateLimit = require('express-rate-limit');
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
const { pool } = require('./db/index');


const app = express();
const server = http.createServer(app);

// ─── NUCLEAR CORS ──────────────────────────────────────────────────────────────
// Must be FIRST, before any routes or other middleware.
const corsOptions = {
  origin: "*",
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "x-access-token", "x-platform"],
  credentials: false,
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
  max: 100, // Limit each IP to 100 requests per window
  message: { error: "Too many requests, please try again later." }
});

const paymentLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 5, // Limit each IP to 5 payment requests per minute
  message: { error: "Security alert: Too many payment attempts. Please wait 1 minute." }
});

app.use('/payments/withdraw', paymentLimiter);
app.use('/payments/deposit', paymentLimiter);
app.use('/auth', paymentLimiter);
app.use(generalLimiter);

// ─── BODY PARSERS ──────────────────────────────────────────────────────────────
app.use(express.json({
  verify: (req, res, buf) => {
    if (req.originalUrl.includes('/webhook')) {
      req.rawBody = buf; // Store the exact raw buffer exclusively for webhooks
    }
  }
}));

// ─── DETECTION ─────────────────────────────────────────────────────────────────
app.use(platformDetection);

// ─── HEALTH CHECK ──────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok', timestamp: new Date() }));

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
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS sound_muted BOOLEAN DEFAULT false;`);
    
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
if (isNaN(PORT)) PORT = 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));