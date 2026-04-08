const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bodyParser = require("body-parser"); 
const cors = require('cors');
require('dotenv').config();
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
    console.log('[DB] Migrations applied.');
  } catch (err) {
    console.error('[DB] Migration error:', err);
  }
})();

let PORT = parseInt(process.env.PORT, 10);
if (isNaN(PORT)) PORT = 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));