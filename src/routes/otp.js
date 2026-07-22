// auth.otp.routes.js
const express = require('express');
const jwt = require('jsonwebtoken');
const axios = require("axios");
const crypto = require("crypto");
const { pool, withTx, getGlobalSetting, redis } = require('../db/index');
const { applyNewUserGiveaways } = require('../models/payments.service');

const router = express.Router();

const OTP_TTL = Number(process.env.OTP_TTL_SECONDS || 300); // 5 min
const MAX_TRIES = Number(process.env.MAX_OTP_TRIES || 5);
const GEEZ_SMS_URL = "https://api.geezsms.com/api/v1/sms/send";
const GEEZ_SMS_TOKEN = process.env.GEEZ_SMS_TOKEN || '';
const SUPER_ADMIN_NUMBERS = (process.env.SUPER_ADMIN_NUMBERS || '').split(',').map(n => n.trim()).filter(Boolean);

// Per-phone rate limiter (Redis-backed for multi-instance). Defaults tuned so a legitimate
// user who doesn't receive the first SMS can resend a few times before being throttled.
// Note: a FAILED SMS send rolls back this counter (see /request-otp), so only delivered
// codes consume the quota.
const OTP_RATE_WINDOW_SEC = Number(process.env.OTP_RATE_WINDOW_SEC || 10 * 60); // 10 minutes
const OTP_RATE_MAX = Number(process.env.OTP_RATE_MAX || 6);
async function checkPhoneRateLimit(phone) {
  const key = `otp_rate:${phone}`;
  try {
    const current = await redis.incr(key);
    if (current === 1) {
      await redis.expire(key, OTP_RATE_WINDOW_SEC);
    }
    return current <= OTP_RATE_MAX;
  } catch (err) {
    console.error('[OTP_RATE] Redis error, allowing request:', err.message);
    return true; // Fail open on Redis error
  }
}


async function sendGeezSMS({ userId, phone, message }) {
  if (!phone || !message) {
    throw new Error("phone and message are required");
  }

  if (!GEEZ_SMS_TOKEN || GEEZ_SMS_TOKEN.length < 10) {
    console.error("[OTP_SMS] GEEZ_SMS_TOKEN not configured — cannot send OTP");
    return { success: false, error: "SMS_NOT_CONFIGURED" };
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

    // GeezSMS can return HTTP 200 with an error body (e.g. insufficient balance,
    // invalid number). Treat the body's error flag as authoritative, not the HTTP status.
    const body = res.data || {};
    const failed =
      body.error === true ||
      body.error === "true" ||
      (typeof body.status === "string" && body.status.toLowerCase() === "error");

    if (failed) {
      console.error("[OTP_SMS] GeezSMS returned error body:", body);
      return { success: false, error: body.msg || body.message || "SMS_PROVIDER_ERROR" };
    }

    return { success: true, data: body };
  } catch (err) {
    const errorPayload = err.response?.data || err.message;
    console.error("[OTP_SMS] GeezSMS request failed:", errorPayload);
    return { success: false, error: errorPayload };
  }
}


function genOtp(phoneNumber) {
  // Generate random 4-digit OTP
  const n = crypto.randomInt(0, 10000);
  return String(n).padStart(4, "0");
}

// ✅ Redis connection for Refresh Tokens & Blacklisting



function normalizeNumber(n) {
  // Canonical format: 251XXXXXXXXX (12 digits, no leading +)
  let digits = String(n || '').replace(/[^0-9]/g, '');

  // +251 or 251 prefix (12 digits)
  if (/^251\d{9}$/.test(digits)) return digits;

  // 0-prefixed local format (10 digits): 09xxxxxxxx → 251xxxxxxxxx
  if (/^0\d{9}$/.test(digits)) return `251${digits.slice(1)}`;

  // Bare 9-digit local: 9xxxxxxxx → 2519xxxxxxxx
  if (/^\d{9}$/.test(digits)) return `251${digits}`;

  // Fallback: return as-is (will likely fail validation downstream)
  return digits;
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
    const allowed = await checkPhoneRateLimit(number);
    if (!allowed) {
      console.warn('[REQUEST_OTP] Rate limited by phone', { number });
      return res.status(429).json({ error: 'TOO_MANY_REQUESTS', message: 'Too many OTP requests. Please wait 15 minutes.' });
    }

    const code = genOtp(number);
    const ttl = OTP_TTL;

    if (process.env.NODE_ENV !== 'production') {
      console.log(`\n==================================================`);
      console.log(`[DEVELOPMENT] OTP Code requested for ${number}`);
      console.log(`👉 CODE: ${code}`);
      console.log(`👉 BYPASS CODE: ${SUPER_ADMIN_NUMBERS.includes(number) ? '0000' : '1111'}`);
      console.log(`==================================================\n`);
    }

    // ── DB work only (no network I/O inside the transaction — keeps pool connections free) ──
    const { userId } = await withTx(async (client) => {
      // 1️⃣ Ensure user exists
      const userResult = await client.query(
        `INSERT INTO users (number)
         VALUES ($1)
         ON CONFLICT (number) DO NOTHING
         RETURNING id, new_user`,
        [number]
      );

      let uid;
      if (userResult.rows.length > 0) {
        uid = userResult.rows[0].id;
      } else {
        const existingUser = await client.query(
          `SELECT id, new_user FROM users WHERE number = $1`,
          [number]
        );
        uid = existingUser.rows[0].id;
      }

      // 2️⃣ Ensure wallet exists
      await client.query(
        `INSERT INTO wallets (user_id)
         VALUES ($1)
         ON CONFLICT (user_id) DO NOTHING`,
        [uid]
      );

      // 3️⃣ INSERT OTP (welcome bonus is applied on verify, not here)
      await client.query(
        `INSERT INTO otps (number, code, expires_at)
         VALUES ($1, $2, now() + ($3 || ' seconds')::interval)`,
        [number, code, ttl]
      );

      return { userId: uid };
    });

    // ── Send SMS: Send real SMS whenever GEEZ_SMS_TOKEN is set ──
    const hasGeezToken = GEEZ_SMS_TOKEN && GEEZ_SMS_TOKEN.length >= 10;
    if (hasGeezToken) {
      const smsResult = await sendGeezSMS({ userId, phone: number, message: `your OTP is: ${code}` });
      if (!smsResult.success) {
        console.error('[REQUEST_OTP] SMS delivery failed', { number, error: smsResult.error });
        
        // In production, block request on SMS failure
        if (process.env.NODE_ENV === 'production') {
          await redis.decr(`otp_rate:${number}`).catch(() => {});
          return res.status(502).json({
            error: 'SMS_DELIVERY_FAILED',
            message: 'Could not send the OTP right now. Please try again in a moment.',
          });
        } else {
          console.log(`[DEVELOPMENT] Real SMS send failed (${smsResult.error}). Fallback OTP Code: ${code} (or bypass code '${SUPER_ADMIN_NUMBERS.includes(number) ? '0000' : '1111'}')`);
        }
      } else {
        console.log(`[OTP_SENT] Successfully sent SMS to ${number}`);
      }
    } else {
      const bypassCode = SUPER_ADMIN_NUMBERS.includes(number) ? '0000' : '1111';
      console.log(`[DEVELOPMENT] GEEZ_SMS_TOKEN not configured. OTP Code is: ${code} (Bypass code: '${bypassCode}')`);
    }

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

  if (process.env.NODE_ENV !== 'production') {
    console.log('[VERIFY_OTP] Incoming request', { raw, hasCode: !!code, ip: req.ip });
  }

  if (!raw || !code) {
    return res.status(400).json({ error: 'number and code are required' });
  }

  const number = normalizeNumber(raw);
  const secret = process.env.JWT_SECRET;

  if (!secret) {
    console.error('[VERIFY_OTP] JWT secret missing');
    return res.status(500).json({ error: 'server jwt misconfigured' });
  }

  try {
    const result = await withTx(async (client) => {
      const isDev = process.env.NODE_ENV !== 'production';

      // 1) Find latest active OTP
      const { rows } = await client.query(
        `SELECT * FROM otps
         WHERE number = $1 AND used = FALSE AND expires_at > now()
         ORDER BY created_at DESC
         LIMIT 1`,
        [number]
      );

      const otp = rows[0];

      const isAdmin = SUPER_ADMIN_NUMBERS.includes(number);
      const isBypass = isDev && (
        (isAdmin && code === '0000') ||
        (!isAdmin && code === '1111')
      );

      if (!otp) {
        // In local development, bypass missing or expired OTPs if they use the dev bypass code
        if (isBypass) {
          console.log(`[VERIFY_OTP] Dev bypass: no active OTP found in DB, but code is ${code}. Proceeding to resolve user.`);
        } else {
          console.warn('[VERIFY_OTP] No active OTP found', { number });
          return { ok: false, reason: 'no_active_otp' };
        }
      } else {
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
        if (otp.code !== code && !isBypass) {
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

        console.log('[VERIFY_OTP] OTP verified successfully');

        // 4) Success
        await client.query(`UPDATE otps SET used = TRUE WHERE id = $1`, [otp.id]);
      }

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

      // 6) Mark new_user flag and capture it for post-tx bonus processing
      const isNewUser = !!user.new_user;
      if (user.new_user) {
        await client.query(`UPDATE users SET new_user = false WHERE id = $1`, [user.id]);
        // Keep user.new_user = true for the response so frontend can show welcome popup
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

      return { ok: true, user, isNewUser };
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
      { expiresIn: '7d' }
    );

    const refreshToken = crypto.randomBytes(40).toString('hex');
    try {
      await redis.set(`refresh_token:${refreshToken}`, result.user.id, 'EX', 7 * 24 * 60 * 60);
    } catch (redisErr) {
      console.warn('[VERIFY_OTP] Redis refresh token store failed (non-fatal):', redisErr.message);
      // Login still works — user gets a JWT. Refresh token won't work until Redis recovers.
    }

    console.log('[VERIFY_OTP] Tokens generated successfully');

     // ---- FIRE-AND-FORGET: Apply bonuses AFTER login succeeds ----
     if (result.isNewUser) {
       const bonusUserId = result.user.id;
       const sanitizeParam = (val) => (val && val !== 'undefined' && val !== 'null' && String(val).trim() !== '') ? val : null;
       const refParam = sanitizeParam(req.body?.ref || req.query?.ref);
       const promoParam = sanitizeParam(req.body?.promo || req.query?.promo);
       setImmediate(async () => {
         try {
           console.log(`[BONUS] Processing bonuses for new user ${bonusUserId}...`);
           
           // A) Apply giveaway-table promotions — always apply welcome bonus to every new user
           await applyNewUserGiveaways(bonusUserId).catch(err => console.error('[GIVEAWAY_ERR]', err.message));
           
           // B) Process referral bonus
           if (refParam) {
             try {
                // Check if referral system is enabled (cached in Redis)
                const enabled = await getGlobalSetting('referral_enabled', true);
                const bonusAmount = Number(await getGlobalSetting('referral_bonus_amount', 2)) || 2;

               if (enabled) {
                 // Find referrer by first 8 chars of their UUID
                 const refCode = String(refParam).toUpperCase();
                 const { rows: referrerRows } = await pool.query(
                   `SELECT id FROM users WHERE UPPER(SUBSTRING(id::text, 1, 8)) = $1 LIMIT 1`,
                   [refCode]
                 );

                 if (referrerRows.length > 0) {
                   const referrerId = referrerRows[0].id;
                   
                   // Don't allow self-referral
                   if (referrerId !== bonusUserId) {
                     // Use a transaction with a wallet lock to prevent race conditions
                     const client = await pool.connect();
                     try {
                       await client.query('BEGIN');

                       // 🔒 Lock referrer's wallet row to prevent duplicate credits
                       await client.query(`SELECT 1 FROM wallets WHERE user_id = $1 FOR UPDATE`, [referrerId]);

                       // Check if this referred user was already recorded (safe under lock)
                       const { rowCount } = await client.query(
                         `SELECT 1 FROM referrals WHERE referred_id = $1`, [bonusUserId]
                       );
                       
                       if (rowCount === 0) {
                         // Record the referral
                         await client.query(
                           `INSERT INTO referrals (referrer_id, referred_id, bonus_amount) VALUES ($1, $2, $3)`,
                           [referrerId, bonusUserId, bonusAmount]
                         );

                         // Credit referrer — bonus goes to available_balance and bonus_balance (NOT withdrawable)
                         await client.query(`
                           UPDATE wallets 
                           SET available_balance = available_balance + $1,
                               bonus_balance     = bonus_balance + $1,
                               updated_at        = now()
                           WHERE user_id = $2
                         `, [bonusAmount, referrerId]);

                         // Log it
                         await client.query(
                           `INSERT INTO bonus_logs (user_id, amount, reason) VALUES ($1, $2, $3)`,
                           [referrerId, bonusAmount, `Referral bonus (invited user ${bonusUserId.slice(0,8)})`]
                         );

                         console.log(`[REFERRAL] Credited ${bonusAmount} ETB to referrer ${referrerId} for new user ${bonusUserId}`);
                       }

                       await client.query('COMMIT');
                     } catch (txErr) {
                       await client.query('ROLLBACK');
                       console.error('[REFERRAL_TX_ERR]', txErr.message);
                     } finally {
                       client.release();
                     }
                   }
                 }
               }
             } catch (refErr) {
               console.error('[REFERRAL_ERR]', refErr.message);
             }
           }

           // C) Process promotion link bonus
           if (promoParam) {
             try {
               const promoCode = String(promoParam).toUpperCase();
               const { rows: promoRows } = await pool.query(`
                 SELECT * FROM promotion_links 
                 WHERE UPPER(code) = $1 
                   AND is_active = true
                   AND (expires_at IS NULL OR expires_at > NOW())
               `, [promoCode]);

               if (promoRows.length > 0) {
                 const promo = promoRows[0];
                 const promoAmount = Number(promo.bonus_amount);

                 // Use transaction to prevent double claims
                 const client = await pool.connect();
                 try {
                   await client.query('BEGIN');

                   // Check if already claimed
                   const { rowCount } = await client.query(`
                     SELECT 1 FROM promotion_claims 
                     WHERE promotion_link_id = $1 AND user_id = $2
                   `, [promo.id, bonusUserId]);

                   if (rowCount === 0) {
                     // Record claim
                     await client.query(`
                       INSERT INTO promotion_claims (promotion_link_id, user_id) VALUES ($1, $2)
                     `, [promo.id, bonusUserId]);

                     // Update promotion counter
                     await client.query(`
                       UPDATE promotion_links 
                       SET total_claims = total_claims + 1,
                           total_registrations = total_registrations + 1
                       WHERE id = $1
                     `, [promo.id]);

                     // Credit user bonus
                     await client.query(`
                       UPDATE wallets 
                       SET available_balance = available_balance + $1,
                           bonus_balance     = bonus_balance + $1,
                           updated_at        = now()
                       WHERE user_id = $2
                     `, [promoAmount, bonusUserId]);

                     // Log bonus
                     await client.query(`
                       INSERT INTO bonus_logs (user_id, amount, reason) VALUES ($1, $2, $3)
                     `, [bonusUserId, promoAmount, `Promotion bonus: ${promo.name} (${promo.code})`]);

                     console.log(`[PROMO] Credited ${promoAmount} ETB to new user ${bonusUserId} via promotion ${promo.code}`);
                   }

                   await client.query('COMMIT');
                 } catch (txErr) {
                   await client.query('ROLLBACK');
                   console.error('[PROMO_TX_ERR]', txErr.message);
                 } finally {
                   client.release();
                 }
               }
             } catch (promoErr) {
               console.error('[PROMO_ERR]', promoErr.message);
             }
           }
         } catch (bonusErr) {
           console.error('[BONUS] Post-login bonus processing failed:', bonusErr.message);
         }
       });
     }

    return res.json({
      token,
      refreshToken,
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
    let userId = null;
    try {
      userId = await redis.get(`refresh_token:${refreshToken}`);
    } catch (redisErr) {
      console.warn('[REFRESH] Redis read failed:', redisErr.message);
      return res.status(503).json({ error: 'Session service temporarily unavailable. Please log in again.' });
    }
    if (!userId) {
      return res.status(401).json({ error: 'Invalid or expired refresh token' });
    }

    // Fetch latest user data to ensure claims (like role) are fresh
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
    if (!rows.length) return res.status(401).json({ error: 'User no longer exists' });
    const user = rows[0];
    if (user.banned) return res.status(403).json({ error: 'Account suspended' });

    // Invalidate the old refresh token (Token Rotation for theft detection)
    try {
      await redis.del(`refresh_token:${refreshToken}`);
    } catch (redisErr) {
      console.warn('[REFRESH] Redis del failed (non-fatal):', redisErr.message);
    }

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
      { expiresIn: '7d' }
    );

    // Generate new Refresh Token
    const newRefreshToken = crypto.randomBytes(40).toString('hex');
    try {
      await redis.set(`refresh_token:${newRefreshToken}`, user.id, 'EX', 7 * 24 * 60 * 60);
    } catch (redisErr) {
      console.warn('[REFRESH] Redis set failed (non-fatal):', redisErr.message);
    }

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
      try {
        if (decoded && decoded.exp) {
          const ttl = Math.max(0, decoded.exp - Math.floor(Date.now() / 1000));
          if (ttl > 0) {
            await redis.set(`jwt_bl:${token}`, 'revoked', 'EX', ttl);
          }
        } else {
          // Fallback if unable to decode cleanly
          await redis.set(`jwt_bl:${token}`, 'revoked', 'EX', 15 * 60); 
        }
      } catch (redisErr) {
        console.warn('[LOGOUT] Redis blacklist failed (non-fatal):', redisErr.message);
      }
    }

    if (refreshToken) {
      try {
        await redis.del(`refresh_token:${refreshToken}`);
      } catch (redisErr) {
        console.warn('[LOGOUT] Redis refresh token del failed (non-fatal):', redisErr.message);
      }
    }

    return res.json({ ok: true, message: 'Logged out securely' });
  } catch (err) {
    console.error('[LOGOUT] Error:', err);
    return res.status(500).json({ error: 'Failed to logout securely' });
  }
});

module.exports = router;

