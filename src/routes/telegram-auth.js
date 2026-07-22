// src/routes/telegram-auth.js
// API endpoints for the Telegram login flow (init + poll)
const express = require('express');
const rateLimit = require('express-rate-limit');
const {
  createTelegramLoginSession,
  pollTelegramLoginSession,
} = require('../bot/telegram');

const router = express.Router();

// Rate limit: prevent session flooding
const initLimiter = rateLimit({
  windowMs: 60_000,       // 1 minute
  max: 10,                // 10 inits per IP per minute
  message: { error: 'Too many login attempts. Please wait a moment.' },
});

// Rate limit: prevent poll spamming
const pollLimiter = rateLimit({
  windowMs: 60_000,
  max: 120,               // 120 polls per minute (2/sec is fine)
  message: { error: 'Too many requests.' },
});

/**
 * POST /auth/telegram-init
 * 
 * Creates a new login session and returns a Telegram deep link.
 * The app opens this link → user goes to Telegram → shares phone → login completes.
 * 
 * Response: { ok: true, sessionToken: "uuid", deepLink: "https://t.me/Xoethiopiabot?start=uuid" }
 */
router.post('/telegram-init', initLimiter, async (req, res) => {
  try {
    const { sessionToken, deepLink } = await createTelegramLoginSession();

    console.log(`[TG_AUTH] Session created: ${sessionToken}`);

    return res.json({
      ok: true,
      sessionToken,
      deepLink,
    });
  } catch (err) {
    console.error('[TG_AUTH] Init error:', err.message);
    return res.status(500).json({ error: 'Failed to create login session' });
  }
});

/**
 * GET /auth/telegram-poll?session=<token>
 * 
 * The app polls this endpoint every 2 seconds after opening Telegram.
 * Returns the login status:
 *   - { status: "waiting" }  → still waiting for user to share phone
 *   - { status: "done", token, refreshToken, user }  → login complete!
 *   - { status: "expired" }  → session timed out (5 min)
 */
router.get('/telegram-poll', pollLimiter, async (req, res) => {
  try {
    const sessionToken = req.query.session;
    if (!sessionToken || sessionToken.length > 200) {
      return res.status(400).json({ error: 'session parameter required' });
    }

    const result = await pollTelegramLoginSession(sessionToken);

    return res.json(result);
  } catch (err) {
    console.error('[TG_AUTH] Poll error:', err.message);
    return res.status(500).json({ error: 'Poll failed' });
  }
});

module.exports = router;
