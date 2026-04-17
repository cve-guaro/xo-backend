// auth.otp.routes.js
const express = require('express');
const jwt = require('jsonwebtoken');
const axios = require("axios");
const crypto = require("crypto");
const { pool, withTx } = require('../db/index');
const { applyNewUserGiveaways } = require('../models/payments.service');

const router = express.Router();

const OTP_TTL = Number(process.env.OTP_TTL_SECONDS || 300); // 5 min
const MAX_TRIES = Number(process.env.MAX_OTP_TRIES || 5);
const GEEZ_SMS_URL = "https://api.geezsms.com/api/v1/sms/send";
const GEEZ_SMS_TOKEN = process.env.GEEZ_SMS_TOKEN || '';
const SUPER_ADMIN_NUMBERS = ['251961111106'];

// Per-phone rate limiter: max 5 OTP requests per phone per 15 min
const phoneOtpRequestCounts = new Map();
function checkPhoneRateLimit(phone) {
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  const maxRequests = 3;
  if (!phoneOtpRequestCounts.has(phone)) {
    phoneOtpRequestCounts.set(phone, []);
  }
  const times = phoneOtpRequestCounts.get(phone).filter(t => now - t < windowMs);
  if (times.length >= maxRequests) return false;
  times.push(now);
  phoneOtpRequestCounts.set(phone, times);
  return true;
}


async function sendGeezSMS({ userId, phone, message }) {
  if (!phone || !message) {
    throw new Error("phone and message are required");
  }

  try {
    const res = await axios.post(
      GEEZ_SMS_URL,
      {
        token: GEEZ_SMS_TOKEN,
        phone,
        msg: message,
      },
      {
        timeout: 10_000,
      }
    );

    return {
      success: true,
      data: res.data,
    };
  } catch (err) {
    const errorPayload = err.response?.data || err.message;

    console.error("GeezSMS error:", errorPayload);

    return {
      success: false,
      error: errorPayload,
    };
  }
}


function genOtp(phoneNumber) {
  console.log("-----------------------------------------");
  console.log("--- OTP Request (genOtp) ---");
  console.log("Phone Received:", phoneNumber);

  // Generate random 4-digit OTP
  const n = crypto.randomInt(0, 10000);
  return String(n).padStart(4, "0");
}

// ✅ Redis connection for Refresh Tokens & Blacklisting
const Redis = require('ioredis');
const redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379');


function normalizeNumber(n) {
  return String(n)
}

// // Placeholder: integrate your SMS gateway here
// async function sendOtpSMS(number, code) {
//   // TODO: plug in Chapa SMS or any provider you use
//   console.log(`[SMS] Sending OTP ${code} to ${number}`);
// }

/**
 * POST /auth/request-otp
 * Body: { number: "09xxxxxxxx" }
 * - Creates the user if not exists (unique number)
 * - Generates a new 4-digit OTP (expires in 5 min)
 * - Sends OTP via SMS
 */
router.post('/request-otp', async (req, res) => {
  try {
    const raw = req.body?.number;
    if (!raw) return res.status(400).json({ error: 'number is required' });

    const number = normalizeNumber(raw);

    // ─── Per-phone rate limit ───────────────────────
    if (!checkPhoneRateLimit(number)) {
      console.warn('[REQUEST_OTP] Rate limited by phone', { number });
      return res.status(429).json({ error: 'TOO_MANY_REQUESTS', message: 'Too many OTP requests. Please wait 15 minutes.' });
    }

    const code = genOtp(number);
    const ttl = OTP_TTL;

    console.log(`[DEBUG] OTP requested for ${number} (valid for ${ttl}s)`);

    await withTx(async (client) => {
      // 1️⃣ Ensure user exists
      const userResult = await client.query(
        `INSERT INTO users (number)
         VALUES ($1)
         ON CONFLICT (number) DO NOTHING
         RETURNING id, new_user`,
        [number]
      );

      let userId;
      let isNewUser = false;

      if (userResult.rows.length > 0) {
        userId = userResult.rows[0].id;
        isNewUser = true; // just created
      } else {
        const existingUser = await client.query(
          `SELECT id, new_user FROM users WHERE number = $1`,
          [number]
        );
        userId = existingUser.rows[0].id;
        isNewUser = existingUser.rows[0].new_user === true;
      }

      // 2️⃣ Ensure wallet exists
      await client.query(
        `INSERT INTO wallets (user_id)
         VALUES ($1)
         ON CONFLICT (user_id) DO NOTHING`,
        [userId]
      );

      /* 
         --- WELCOME BONUS MOVED TO VERIFY-OTP ---
         We only credit once they successfully verify.
      */

      // 4️⃣ INSERT OTP
      await client.query(
        `INSERT INTO otps (number, code, expires_at)
         VALUES ($1, $2, now() + ($3 || ' seconds')::interval)`,
        [number, code, ttl]
      );

      // 5️⃣ Send SMS
      await sendGeezSMS({ userId, phone: number, message: `your OTP is: ${code}` });
    });

    return res.json({ ok: true, message: 'OTP sent' });
  } catch (err) {
    console.error('[REQUEST_OTP] Error', err);
    return res.status(500).json({ error: 'failed to request otp' });
  }
});



/**
 * POST /auth/verify-otp
 * Body: { number: "09xxxxxxxx", code: "1234" }
 * - Finds the latest active OTP (unused, unexpired)
 * - Increments 'tried'
 * - If match: mark used, issue JWT; if not: return error
 */
// auth.otp.routes.js (replace your /verify-otp handler with this)
router.post('/verify-otp', async (req, res) => {
  const raw = req.body?.number;
  const code = req.body?.code;

  console.log('[VERIFY_OTP] Incoming request', {
    raw,
    hasCode: !!code,
    ip: req.ip,
  });

  if (!raw || !code) {
    console.warn('[VERIFY_OTP] Missing number or code');
    return res.status(400).json({ error: 'number and code are required' });
  }

  const number = normalizeNumber(raw);
  const secret = process.env.JWT_SECRET;

  if (!secret) {
    console.error('[VERIFY_OTP] JWT secret missing');
    return res.status(500).json({ error: 'server jwt misconfigured' });
  }

  try {
    console.log("-----------------------------------------");
    console.log("--- Login Attempt (verify-otp) ---");
    console.log("Phone Received:", number);
    console.log("Code Received:", code);

    console.log("ℹ️ User Path. Proceeding to standard OTP check.");
    const result = await withTx(async (client) => {
      console.log('[VERIFY_OTP] Looking for active OTP', { number });

      // 1) Find latest active OTP
      const { rows } = await client.query(
        `SELECT * FROM otps
         WHERE number = $1 AND used = FALSE AND expires_at > now()
         ORDER BY created_at DESC
         LIMIT 1`,
        [number]
      );

      if (!rows.length) {
        console.warn('[VERIFY_OTP] No active OTP found', { number });
        return { ok: false, reason: 'no_active_otp' };
      }

      const otp = rows[0];
      console.log('[VERIFY_OTP] OTP found', {
        otpId: otp.id,
        tried: otp.tried,
        expiresAt: otp.expires_at,
      });

      // Lock row
      await client.query(`SELECT id FROM otps WHERE id=$1 FOR UPDATE`, [otp.id]);

      // 2) Tries limit
      const maxTries = Number(process.env.MAX_OTP_TRIES || 5);
      if (Number(otp.tried) >= maxTries) {
        console.warn('[VERIFY_OTP] Too many attempts', {
          otpId: otp.id,
          tried: otp.tried,
        });
        return { ok: false, reason: 'too_many_attempts' };
      }

      // 3) Code match
      if (otp.code !== code) {
        console.warn('[VERIFY_OTP] Invalid OTP code', {
          otpId: otp.id,
          triedBefore: otp.tried,
        });

        await client.query(
          `UPDATE otps SET tried = tried + 1 WHERE id = $1`,
          [otp.id]
        );

        return { ok: false, reason: 'invalid_code' };
      }

      console.log('[VERIFY_OTP] OTP verified successfully', { otpId: otp.id });

      // 4) Success
      await client.query(`UPDATE otps SET used = TRUE WHERE id = $1`, [otp.id]);

      const { rows: userRows } = await client.query(
        `INSERT INTO users (number)
         VALUES ($1)
         ON CONFLICT (number)
         DO UPDATE SET number = EXCLUDED.number
         RETURNING id, number, username, avatar, new_user, role, sound_muted`,
        [number]
      );

      const user = userRows[0];

      // 5) Ensure wallet exists
      await client.query(
        `INSERT INTO wallets (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
        [user.id]
      );

      // 6) Robust Giveaway Engine: Apply any active NEW_USER giveaways
      if (user.new_user) {
        console.log(`[BONUS] Processing giveaways for ${user.number}...`);
        
        // --- PLATFORM CHECK: Only Web users get the bonus (as per existing logic) ---
        if (!req.isWeb) {
           console.log(`[BONUS] Mobile user ${user.id} skipped auto-giveaways.`);
           // We still mark them as no longer "new" so they don't get it later if they log in via Web
           await client.query(`UPDATE users SET new_user = false WHERE id = $1`, [user.id]);
           user.new_user = false;
        } else {
          // Use our new robust service
          await applyNewUserGiveaways(user.id).catch(err => console.error('[GIVEAWAY_ERR] Failed apply:', err));
          
          // Mark user as no longer "new" (handled inside applyNewUserGiveaways for each gift, 
          // but we do it globally here to stop the "new_user" status)
          await client.query(`UPDATE users SET new_user = false WHERE id = $1`, [user.id]);
          user.new_user = false;
        }
      }

      // Ensure hardcoded super-admin number always has role='superadmin'
      if (SUPER_ADMIN_NUMBERS.includes(number) && user.role !== 'superadmin') {
        await client.query(`UPDATE users SET role = 'superadmin' WHERE id = $1`, [user.id]);
        user.role = 'superadmin';
      }

      console.log('[VERIFY_OTP] User resolved', {
        userId: user.id,
        newUser: user.new_user,
        role: user.role,
      });

      return { ok: true, user };
    });

    // ---- After COMMIT ----
    if (!result.ok) {
      console.warn('[VERIFY_OTP] Verification failed', result.reason);

      const map = {
        no_active_otp: [400, 'No active OTP or it expired'],
        too_many_attempts: [429, 'Too many attempts'],
        invalid_code: [400, 'Invalid code'],
      };

      const [status, message] = map[result.reason] || [400, 'Verification failed'];
      return res.status(status).json({ error: message });
    }

    console.log('[VERIFY_OTP] Issuing JWT', {
      userId: result.user.id,
      number: result.user.number,
    });

    const token = jwt.sign(
      {
        sub: result.user.id,
        number: result.user.number,
        username: result.user.username,
        role: result.user.role || 'user',
      },
      secret,
      { expiresIn: '15m' } // ✅ Military-Grade: Short-lived access token
    );

    // ✅ Generate Cryptographically Secure Refresh Token (7 days)
    const refreshToken = crypto.randomBytes(40).toString('hex');
    await redis.set(`refresh_token:${refreshToken}`, result.user.id, 'EX', 7 * 24 * 60 * 60);

    console.log('[VERIFY_OTP] Tokens generated successfully');

    return res.json({
      token,
      refreshToken, // Frontend must now store and use this when 401s occur
      user: {
        id: result.user.id,
        number: result.user.number,
        username: result.user.username,
        avatar: result.user.avatar,
        new_user: result.user.new_user,
        role: result.user.role || 'user',
        sound_muted: result.user.sound_muted,
      },
    });
  } catch (err) {
    console.error('[VERIFY_OTP] Fatal error', {
      message: err.message,
      stack: err.stack,
    });

    return res.status(500).json({ error: 'verify failed' });
  }
});

/**
 * POST /auth/refresh
 * Exchanges a valid refresh token for a new 15m access token and rotates the refresh token.
 */
router.post('/refresh', async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(400).json({ error: 'refreshToken required' });

  try {
    const userId = await redis.get(`refresh_token:${refreshToken}`);
    if (!userId) {
      return res.status(401).json({ error: 'Invalid or expired refresh token' });
    }

    // Fetch latest user data to ensure claims (like role) are fresh
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
    if (!rows.length) return res.status(401).json({ error: 'User no longer exists' });
    const user = rows[0];
    if (user.banned) return res.status(403).json({ error: 'Account suspended' });

    // Invalidate the old refresh token (Token Rotation for theft detection)
    await redis.del(`refresh_token:${refreshToken}`);

    // Generate new Access Token
    const secret = process.env.JWT_SECRET;
    const newToken = jwt.sign(
      {
        sub: user.id,
        number: user.number,
        username: user.username,
        role: user.role || 'user',
      },
      secret,
      { expiresIn: '15m' }
    );

    // Generate new Refresh Token
    const newRefreshToken = crypto.randomBytes(40).toString('hex');
    await redis.set(`refresh_token:${newRefreshToken}`, user.id, 'EX', 7 * 24 * 60 * 60);

    return res.json({ token: newToken, refreshToken: newRefreshToken });
  } catch (err) {
    console.error('[REFRESH] Error:', err);
    return res.status(500).json({ error: 'Server error during refresh' });
  }
});

/**
 * POST /auth/logout
 * Strictly revokes the access token (via Redis blacklist) and deletes the refresh token.
 */
router.post('/logout', async (req, res) => {
  const hdr = req.headers.authorization || '';
  const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : hdr;
  const { refreshToken } = req.body;

  try {
    if (token) {
      // Decode without verifying just to get expiry time and minimize Redis bloat
      const decoded = jwt.decode(token);
      if (decoded && decoded.exp) {
        const ttl = Math.max(0, decoded.exp - Math.floor(Date.now() / 1000));
        if (ttl > 0) {
           await redis.set(`jwt_bl:${token}`, 'revoked', 'EX', ttl);
        }
      } else {
        // Fallback if unable to decode cleanly
        await redis.set(`jwt_bl:${token}`, 'revoked', 'EX', 15 * 60); 
      }
    }

    if (refreshToken) {
      await redis.del(`refresh_token:${refreshToken}`);
    }

    return res.json({ ok: true, message: 'Logged out securely' });
  } catch (err) {
    console.error('[LOGOUT] Error:', err);
    return res.status(500).json({ error: 'Failed to logout securely' });
  }
});

module.exports = router;

