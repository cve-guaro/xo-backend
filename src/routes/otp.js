// auth.otp.routes.js
const express = require('express');
const jwt = require('jsonwebtoken');
const { pool, withTx } = require('../db/index');

const router = express.Router();

const OTP_TTL = Number(process.env.OTP_TTL_SECONDS || 300); // 5 min
const MAX_TRIES = Number(process.env.MAX_OTP_TRIES || 5);

function genOtp() {
  // 0000 - 9999 (4 digits with leading zeros)
  return String(Math.floor(Math.random() * 10000)).padStart(4, '0');
}

function normalizeNumber(n) {
  // very light normalization; adjust to your country rules
  return String(n).replace(/\s+/g, '');
}

// Placeholder: integrate your SMS gateway here
async function sendOtpSMS(number, code) {
  // TODO: plug in Chapa SMS or any provider you use
  console.log(`[SMS] Sending OTP ${code} to ${number}`);
}

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

    const number = String(raw).replace(/\s+/g, '');
    const code = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
    const ttl = Number(process.env.OTP_TTL_SECONDS || 300);

    // Log the OTP for debugging
    console.log(`[DEBUG] OTP for ${number}: ${code} (valid for ${ttl}s)`);

    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();

    await withTx(async (client) => {
      await client.query(
        `INSERT INTO users (number) VALUES ($1)
         ON CONFLICT (number) DO NOTHING`,
        [number]
      );

      await client.query(
        `INSERT INTO otps (number, code, expires_at)
         VALUES ($1, $2, $3)`,
        [number, code, expiresAt]
      );
    });

    // send SMS here...
    return res.json({ ok: true, message: 'OTP sent' });
  } catch (err) {
    console.error(err);
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
  if (!raw || !code) return res.status(400).json({ error: 'number and code are required' });

  const number = String(raw).replace(/\s+/g, '');
  const secret = process.env.JWT_SECRET;
  if (!secret) return res.status(500).json({ error: 'server jwt misconfigured' });

  try {
    const result = await withTx(async (client) => {
      // 1) Find latest active OTP and lock it
      const { rows } = await client.query(
        `SELECT * FROM otps
         WHERE number = $1 AND used = FALSE AND expires_at > now()
         ORDER BY created_at DESC
         LIMIT 1`,
        [number]
      );
      if (!rows.length) {
        return { ok: false, reason: 'no_active_otp' }; // don't throw—let tx commit
      }
      const otp = rows[0];
      await client.query(`SELECT id FROM otps WHERE id=$1 FOR UPDATE`, [otp.id]);

      // 2) Check tries limit (don’t throw to avoid rollback)
      if (Number(otp.tried) >= Number(process.env.MAX_OTP_TRIES || 5)) {
        return { ok: false, reason: 'too_many_attempts' };
      }

      // 3) Match code
      if (otp.code !== code) {
        // increment tried on wrong code
        await client.query(`UPDATE otps SET tried = tried + 1 WHERE id = $1`, [otp.id]);
        return { ok: false, reason: 'invalid_code' };
      }

      // 4) Success: mark used and ensure user exists
      await client.query(`UPDATE otps SET used = TRUE WHERE id = $1`, [otp.id]);

      const { rows: userRows } = await client.query(
        `INSERT INTO users (number)
           VALUES ($1)
         ON CONFLICT (number)
           DO UPDATE SET number = EXCLUDED.number
         RETURNING id, number, username, avatar, new_user`,
        [number]
      );
      const user = userRows[0];

      return { ok: true, user };
    });

    // After COMMIT, decide the HTTP response based on the result
    if (!result.ok) {
      if (result.reason === 'no_active_otp') {
        return res.status(400).json({ error: 'No active OTP or it expired' });
      }
      if (result.reason === 'too_many_attempts') {
        return res.status(429).json({ error: 'Too many attempts' });
      }
      if (result.reason === 'invalid_code') {
        return res.status(400).json({ error: 'Invalid code' });
      }
      return res.status(400).json({ error: 'Verification failed' });
    }

    // Issue token for success
    console.log(secret)
    console.log("user info: ", result.user)
    const token = jwt.sign({ sub: result.user.id, number: result.user.number, username: result.user.username }, secret, { expiresIn: '30d' });
    console.log("generated token: ",token)
    return res.json({
      token,
      user: {
        id: result.user.id,
        number: result.user.number,
        username: result.user.username,
        avatar: result.user.avatar,
        new_user: result.user.new_user,
      },
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'verify failed' });
  }
});


module.exports = router;
