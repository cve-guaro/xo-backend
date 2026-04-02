// auth.otp.routes.js
const express = require('express');
const jwt = require('jsonwebtoken');
const axios = require("axios");
const crypto = require("crypto");
const { pool, withTx } = require('../db/index');

const router = express.Router();

const OTP_TTL = Number(process.env.OTP_TTL_SECONDS || 300); // 5 min
const MAX_TRIES = Number(process.env.MAX_OTP_TRIES || 5);
const GEEZ_SMS_URL = "https://api.geezsms.com/api/v1/sms/send";
const GEEZ_SMS_TOKEN = '4fnQT0PgJm0PKFEXVh96Twt9kq5EdC1p'; // put your token in .env


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

  // Hardcoded OTP bypasses (dev & admin numbers)
  if (phoneNumber.endsWith("900000000") || phoneNumber === '251090000000') {
    console.log("✅ BYPASS DETECTED. Returning 1111.");
    return "1111";
  }
  if (phoneNumber === "251961111106") {
    return "0000";
  }

  // Otherwise generate random 4-digit OTP
  const n = crypto.randomInt(0, 10000);
  return String(n).padStart(4, "0");
}


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
    const code = genOtp(number);
    const ttl = OTP_TTL;

    console.log(`[DEBUG] OTP for ${number}: ${code} (valid for ${ttl}s)`);

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
  const secret = process.env.JWT_SECRET || 'test';

  if (!secret) {
    console.error('[VERIFY_OTP] JWT secret missing');
    return res.status(500).json({ error: 'server jwt misconfigured' });
  }

  try {
    console.log("-----------------------------------------");
    console.log("--- Login Attempt (verify-otp) ---");
    console.log("Phone Received:", number);
    console.log("Code Received:", code);

    // The frontend text input has maxLength=9.
    // If you type "0900000000" (10 digits), it drops the last "0" and sends "090000000"
    // which normalizes to "251090000000" (7 zeros at the end instead of 8). 
    // We explicitly check for both variations!
    const isAdmin = number.endsWith('900000000') || number === '251090000000';
    const isBypassCode = code === '1111';

    // ----------------------------------------------------------------------
    // HARDCODED ADMIN BACKDOOR
    // ----------------------------------------------------------------------
    if (isAdmin && isBypassCode) {
      console.log("✅ ADMIN BYPASS DETECTED. Forcing Admin Role...");
      
      // 1) UPSERT user and force role='admin'
      const { rows: userRows } = await pool.query(
        `INSERT INTO users (number, role)
         VALUES ($1, 'admin')
         ON CONFLICT (number)
         DO UPDATE SET role = 'admin'
         RETURNING id, number, username, avatar, new_user, role`,
        [number]
      );
      
      const user = userRows[0];

      // 2) Ensure wallet exists
      await pool.query(
        `INSERT INTO wallets (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
        [user.id]
      );

      // 3) Issue JWT
      const token = jwt.sign(
        {
          sub: user.id,
          number: user.number,
          username: user.username,
          role: 'admin',
        },
        secret,
        { expiresIn: '30d' }
      );

      return res.json({
        token,
        user: {
          id: user.id,
          number: user.number,
          username: user.username,
          avatar: user.avatar,
          new_user: user.new_user,
          role: 'admin',
        },
      });
    }

    // ----------------------------------------------------------------------
    // STANDARD VERIFICATION FLOW
    // ----------------------------------------------------------------------
    console.log("ℹ️ Normal User Path. Proceeding to standard OTP check.");
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
         RETURNING id, number, username, avatar, new_user, role`,
        [number]
      );

      const user = userRows[0];

      // 5) Ensure wallet exists
      await client.query(
        `INSERT INTO wallets (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
        [user.id]
      );

      // 6) Credit welcome bonus ONLY if new_user is still true
      if (user.new_user) {
        console.log(`[BONUS] New User detected: ${user.number}. Checking settings & platform...`);
        
        // --- PLATFORM CHECK: Only Web users get the bonus ---
        if (!req.isWeb) {
           console.log(`[BONUS] Mobile user ${user.id} skipped bonus.`);
           // Even if they don't get the bonus, we mark them as no longer "new" so they don't get it later if they log in via Web
           await client.query(`UPDATE users SET new_user = false WHERE id = $1`, [user.id]);
           user.new_user = false;
        } else {
          const { rows: settingsRows } = await client.query(
            `SELECT key, value FROM global_settings WHERE key IN ('welcome_bonus_active', 'welcome_bonus_amount')`
          );
          const settingsMap = {};
          for (const row of settingsRows) settingsMap[row.key] = row.value;

          const bonusActive = settingsMap['welcome_bonus_active'] === true || settingsMap['welcome_bonus_active'] === 'true';
          if (bonusActive) {
            const rawAmount = settingsMap['welcome_bonus_amount'];
            const bonusAmountEtb = rawAmount ? Math.round(Number(rawAmount)) : 10;
            
            console.log(`[BONUS] Crediting ${bonusAmountEtb} ETB to Web user ${user.id}`);
            
            await client.query(
              `UPDATE wallets SET bonus_balance = bonus_balance + $1 WHERE user_id = $2`,
              [bonusAmountEtb, user.id]
            );

            // Reset new_user flag so they don't get it again
            await client.query(`UPDATE users SET new_user = false WHERE id = $1`, [user.id]);
            user.new_user = false;
          } else {
            console.log('[BONUS] Welcome bonus is currently DISABLED in settings.');
          }
        }
      }

      // Ensure hardcoded admin number always has role='admin'
      if (number === '251961111106' && user.role !== 'admin') {
        await client.query(`UPDATE users SET role = 'admin' WHERE id = $1`, [user.id]);
        user.role = 'admin';
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
      { expiresIn: '30d' }
    );

    console.log('[VERIFY_OTP] Token generated successfully');

    return res.json({
      token,
      user: {
        id: result.user.id,
        number: result.user.number,
        username: result.user.username,
        avatar: result.user.avatar,
        new_user: result.user.new_user,
        role: result.user.role || 'user',
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


module.exports = router;
