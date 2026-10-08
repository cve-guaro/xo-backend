// src/bot/telegram.js
// Telegram Bot for XO ET — handles login via phone number sharing
const TelegramBot = require('node-telegram-bot-api').TelegramBot || require('node-telegram-bot-api');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { pool, redis, withTx, getGlobalSetting } = require('../db/index');
const { applyNewUserGiveaways } = require('../models/payments.service');

// Sanitize env values — dotenv may include literal quotes if the .env value was quoted
const BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').replace(/^"|"$/g, '').trim();
const _rawUsername = (process.env.TELEGRAM_BOT_USERNAME || '').replace(/^"|"$/g, '').trim();
const BOT_USERNAME = (_rawUsername && _rawUsername !== 'Xoethiopia_Dev_Bot') ? _rawUsername : 'XoethiopiaBot';
const JWT_SECRET = process.env.JWT_SECRET;
const SUPER_ADMIN_NUMBERS = (process.env.SUPER_ADMIN_NUMBERS || '').split(',').map(n => n.trim()).filter(Boolean);

const SESSION_TTL = 300;     // 5 minutes — how long a login session lives
const RESULT_TTL  = 120;     // 2 minutes — how long the completed result stays for polling

let bot = null;
// In-memory fallback for Telegram login sessions when Redis circuit breaker is open
const memoryTgSessions = new Map();

/**
 * Normalize phone number to the canonical 251XXXXXXXXX format
 * used everywhere in the system (frontend, OTP route, DB).
 * Telegram sends phones like "+251912345678".
 */
function normalizeTelegramPhone(phone) {
  let cleaned = String(phone).replace(/[^0-9]/g, '');

  // Already in 251 format (12 digits)
  if (/^251\d{9}$/.test(cleaned)) return cleaned;

  // 0-prefixed local format (10 digits): 09... → 2519...
  if (/^0\d{9}$/.test(cleaned)) return `251${cleaned.slice(1)}`;

  // Bare 9-digit local: 9... → 2519...
  if (/^\d{9}$/.test(cleaned)) return `251${cleaned}`;

  // Fallback
  return cleaned;
}

/**
 * Initialize the Telegram bot. Call once on server startup.
 */
function initTelegramBot() {
  if (!BOT_TOKEN) {
    console.warn('[TELEGRAM] No TELEGRAM_BOT_TOKEN configured — bot disabled.');
    return null;
  }

  const proxyUrl = process.env.TELEGRAM_PROXY;
  let requestOptions = {};
  if (proxyUrl) {
    console.log(`[TELEGRAM] Routing bot traffic through proxy: ${proxyUrl}`);
    const { HttpsProxyAgent } = require('https-proxy-agent');
    const { SocksProxyAgent } = require('socks-proxy-agent');
    
    if (proxyUrl.startsWith('socks')) {
      requestOptions.agent = new SocksProxyAgent(proxyUrl);
    } else {
      requestOptions.agent = new HttpsProxyAgent(proxyUrl);
    }
  }

  bot = new TelegramBot(BOT_TOKEN, {
    polling: false, // Don't autostart until webhook is cleared
    request: proxyUrl ? requestOptions : undefined
  });

  // Track whether this instance is the polling leader
  let isPollingLeader = false;
  let renewInterval = null;
  const lockKey = "tg_bot_poller_leader";
  const instanceId = `${process.pid}_${Math.random().toString(36).substring(2, 7)}`;

  // Clear any existing WebHook and acquire Redis leader lock before polling
  const clearWebhookAndStart = async () => {
    try {
      // Ensure only 1 server instance polls Telegram in multi-container / cluster setups
      let acquired = false;
      try {
        const result = await redis.set(lockKey, instanceId, "EX", 25, "NX");
        acquired = !!result; // NX returns null if key exists, "OK" if set
      } catch (redisErr) {
        // If Redis is unavailable, allow local polling instance to proceed
        console.warn("[TELEGRAM] Redis set lock check failed, proceeding with local bot poller:", redisErr.message);
        acquired = true;
      }
      
      if (!acquired) {
        console.log("[TELEGRAM] Another active server instance is polling leader. Standing by...");
        return;
      }

      isPollingLeader = true;

      // Keep lock alive while server runs
      if (renewInterval) clearInterval(renewInterval);
      renewInterval = setInterval(async () => {
        try {
          const val = await redis.get(lockKey).catch(() => null);
          if (val === instanceId) {
            await redis.expire(lockKey, 25).catch(() => {});
          } else if (val) {
            // Another instance stole the lock — stop polling
            console.log("[TELEGRAM] Lost leader lock to another instance. Stopping polling.");
            isPollingLeader = false;
            clearInterval(renewInterval);
            renewInterval = null;
            bot.stopPolling().catch(() => {});
          }
        } catch (_) {}
      }, 12000);

      // Always clear existing webhook and pending updates before starting polling
      await bot.deleteWebhook({ drop_pending_updates: true }).catch(() => {});

      await bot.startPolling({ params: { timeout: 10 } }).catch((pollErr) => {
        console.warn("[TELEGRAM] Polling start notice:", pollErr.message);
      });
    } catch (err) {
      console.warn("[TELEGRAM] Fallback polling attempt:", err.message);
      bot.startPolling({ params: { timeout: 10 } }).catch(() => {});
    }
  };

  clearWebhookAndStart().then(() => {
    // Health-check: verify the token is valid by calling getMe
    if (bot) {
      bot.getMe().then(me => {
        console.log(`[TELEGRAM] ✅ Bot identity verified: @${me.username} (id=${me.id})`);
        if (me.username !== BOT_USERNAME) {
          console.warn(`[TELEGRAM] ⚠️  BOT_USERNAME env (${BOT_USERNAME}) does not match actual bot (@${me.username}). Deep links may break!`);
        }
      }).catch(err => {
        console.error(`[TELEGRAM] ❌ Bot token verification FAILED: ${err.message}`);
        console.error('[TELEGRAM] Check TELEGRAM_BOT_TOKEN in .env — the token may be invalid or Telegram API may be blocked.');
      });
    }
  });

  // Log all incoming messages for debugging
  bot.on('message', (msg) => {
    console.log(`[TELEGRAM] Raw message received: chat=${msg.chat.id}, text="${msg.text || ''}"`);
  });

  // Handle polling errors cleanly
  bot.on('polling_error', async (err) => {
    if (err.message && err.message.includes('409 Conflict')) {
      // Another instance is polling — stop permanently & stand by silently.
      console.log(`[TELEGRAM] Standby mode active — another server instance is primary poller.`);
      isPollingLeader = false;
      if (renewInterval) { clearInterval(renewInterval); renewInterval = null; }
      try { await bot.stopPolling(); } catch (_) {}
      // Release the Redis lock if we held it
      try {
        const val = await redis.get(lockKey).catch(() => null);
        if (val === instanceId) await redis.del(lockKey).catch(() => {});
      } catch (_) {}
      return;
    }
    console.error('[TELEGRAM] Polling error (non-fatal):', err.message);
  });

  // ── In-memory chat↔session mapping (fallback when Redis is down) ─────────
  const memoryChatSessions = new Map();   // chatId → sessionToken
  const processedStarts = new Map();       // sessionToken → timestamp (dedup)

  // ── Handle /start <sessionToken> ──────────────────────────────────────────
  bot.onText(/\/start (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const sessionToken = match[1];

    // ── DEDUPLICATION: Prevent duplicate /start for the same session ──
    const now = Date.now();
    if (processedStarts.has(sessionToken)) {
      const lastTime = processedStarts.get(sessionToken);
      if (now - lastTime < 10000) { // within 10s → skip duplicate
        console.log(`[TELEGRAM] Ignoring duplicate /start for session ${sessionToken.slice(0, 8)}…`);
        return;
      }
    }
    processedStarts.set(sessionToken, now);
    // Cleanup old entries every 100 calls
    if (processedStarts.size > 200) {
      for (const [key, ts] of processedStarts) {
        if (now - ts > 300000) processedStarts.delete(key);
      }
    }

    try {
      // Verify session exists — check Redis first, then memory fallback
      let sessionData = await redis.get(`tg_login:${sessionToken}`).catch(() => null);

      if (!sessionData && memoryTgSessions.has(sessionToken)) {
        const mem = memoryTgSessions.get(sessionToken);
        if (Date.now() <= mem.expiresAt) {
          sessionData = mem.data;
        } else {
          memoryTgSessions.delete(sessionToken);
        }
      }

      if (!sessionData) {
        return bot.sendMessage(chatId,
          '❌ ጊዜው ያለፈበት ሊንክ ነው።\n\nLink expired. Please go back to XO ET and try again.');
      }

      // Store chat↔session mapping in MEMORY (always available) + Redis (best-effort)
      memoryChatSessions.set(String(chatId), sessionToken);

      redis.set(`tg_login:${sessionToken}:chat`, String(chatId), 'EX', SESSION_TTL).catch(() => {});
      redis.set(`tg_chat_session:${chatId}`, sessionToken, 'EX', SESSION_TTL).catch(() => {});

      // Show the special "Share Phone Number" keyboard button
      await bot.sendMessage(chatId,
        '🎮 *XO ET — Login*\n\n' +
        'ወደ XO ET ለመግባት የስልክ ቁጥርዎን ያጋሩ።\n' +
        'Share your phone number to log in.\n\n' +
        '⬇️ ከታች ያለውን ቁልፍ ይጫኑ / Tap the button below:',
        {
          parse_mode: 'Markdown',
          reply_markup: {
            keyboard: [[{
              text: '📱 ስልክ ቁጥር አጋራ / Share Phone Number',
              request_contact: true,
            }]],
            one_time_keyboard: true,
            resize_keyboard: true,
          },
        }
      );
    } catch (err) {
      console.error('[TELEGRAM] /start handler error:', err.message);
      bot.sendMessage(chatId, '❌ ችግር ተፈጥሯል። እባክዎ እንደገና ይሞክሩ።').catch(() => {});
    }
  });

  // ── Handle plain /start (no session token) ────────────────────────────────
  bot.onText(/^\/start$/, async (msg) => {
    const chatId = msg.chat.id;
    await bot.sendMessage(chatId,
      '🎮 *XO Ethiopia Bot*\n\n' +
      'ይህ ቦት ወደ XO ET ለመግባት ይጠቅማል።\n' +
      'This bot is used to log in to XO ET.\n\n' +
      '👉 xoethiopia.com ላይ "Login with Telegram" ይጫኑ።\n' +
      '👉 Tap "Login with Telegram" on xoethiopia.com.',
      { parse_mode: 'Markdown' }
    ).catch(() => {});
  });

  // ── Helper to process phone login for both contact & text messages ────────
  async function processPhoneLogin(chatId, phone, msg) {
    try {
      // Direct reverse lookup — try Redis first, then memory fallback
      let sessionToken = null;
      try {
        sessionToken = await redis.get(`tg_chat_session:${chatId}`);
      } catch (redisErr) {
        console.warn('[TELEGRAM] Redis get chat session failed:', redisErr.message);
      }

      // Memory fallback if Redis was unavailable
      if (!sessionToken && memoryChatSessions.has(String(chatId))) {
        sessionToken = memoryChatSessions.get(String(chatId));
        console.log(`[TELEGRAM] Used memory fallback for chat ${chatId} → session ${sessionToken?.slice(0, 8)}…`);
      }

      if (!sessionToken) {
        return bot.sendMessage(chatId,
          '❌ ጊዜው ያለፈበት ነው። ወደ XO ET ተመልሰው እንደገና ይሞክሩ።\n' +
          'Session expired. Go back to XO ET and try again.',
          { reply_markup: { remove_keyboard: true } }
        );
      }

      // Verify the session is still active — check Redis first, then memory
      let sessionCheck = await redis.get(`tg_login:${sessionToken}`).catch(() => null);
      if (!sessionCheck && memoryTgSessions.has(sessionToken)) {
        const mem = memoryTgSessions.get(sessionToken);
        if (Date.now() <= mem.expiresAt) {
          sessionCheck = mem.data;
        }
      }
      if (!sessionCheck) {
        return bot.sendMessage(chatId,
          '❌ Session expired. Go back to XO ET and try again.',
          { reply_markup: { remove_keyboard: true } }
        );
      }

      const telegramId = msg.from.id;
      const telegramUsername = msg.from.username || null;
      const normalizedPhone = normalizeTelegramPhone(phone);

      console.log(`[TELEGRAM] Processing phone login: phone=${normalizedPhone} tgId=${telegramId} tgUser=${telegramUsername}`);

      // ── Replicate the same login flow as otp.js verify-otp ──────────────
      const result = await withTx(async (client) => {
        // 1) Find or create user by phone number & store telegram_id in ONE query
        const { rows: userRows } = await client.query(
          `INSERT INTO users (number, telegram_id, telegram_username)
           VALUES ($1, $2, $3)
           ON CONFLICT (number)
           DO UPDATE SET 
             telegram_id = COALESCE(EXCLUDED.telegram_id, users.telegram_id),
             telegram_username = COALESCE(EXCLUDED.telegram_username, users.telegram_username)
           RETURNING id, number, username, avatar, new_user, role, sound_muted`,
          [normalizedPhone, telegramId, telegramUsername]
        );

        const user = userRows[0];

        // 2) Ensure wallet exists
        await client.query(
          `INSERT INTO wallets (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
          [user.id]
        );

        // 3) Capture and clear new_user flag
        const isNewUser = !!user.new_user;
        if (user.new_user) {
          await client.query(`UPDATE users SET new_user = false WHERE id = $1`, [user.id]);
        }

        // 4) Ensure super-admin
        if (SUPER_ADMIN_NUMBERS.includes(normalizedPhone) && user.role !== 'superadmin') {
          await client.query(`UPDATE users SET role = 'superadmin' WHERE id = $1`, [user.id]);
          user.role = 'superadmin';
        }

        return { user, isNewUser };
      });

      const { user, isNewUser } = result;

      // 5) Generate JWT (same claims as otp.js)
      const token = jwt.sign(
        {
          sub: user.id,
          number: user.number,
          username: user.username,
          role: user.role || 'user',
        },
        JWT_SECRET,
        { expiresIn: '7d' }
      );

      // 6) Generate refresh token
      const refreshToken = crypto.randomBytes(40).toString('hex');
      redis.set(`refresh_token:${refreshToken}`, user.id, 'EX', 7 * 24 * 60 * 60).catch(() => {});

      // 7) Store completed login result for the app to poll IMMEDIATELY
      const doneResult = JSON.stringify({
        status: 'done',
        token,
        refreshToken,
        user: {
          id: user.id,
          number: user.number,
          username: user.username,
          avatar: user.avatar,
          new_user: isNewUser,
          role: user.role || 'user',
          sound_muted: user.sound_muted,
        },
      });

      // Write to local in-memory session map FIRST (instant local response)
      memoryTgSessions.set(sessionToken, {
        data: doneResult,
        expiresAt: Date.now() + RESULT_TTL * 1000,
      });

      // Write to Redis concurrently
      redis.set(`tg_login:${sessionToken}`, doneResult, 'EX', RESULT_TTL).catch(err =>
        console.warn('[TELEGRAM] Redis set completed login failed:', err.message)
      );

      // Clean up the chat mapping (both directions — Redis + memory)
      memoryChatSessions.delete(String(chatId));
      redis.del(`tg_login:${sessionToken}:chat`).catch(() => {});
      redis.del(`tg_chat_session:${chatId}`).catch(() => {});

      console.log(`[TELEGRAM] Login completed INSTANTLY: user=${user.id} phone=${normalizedPhone} isNew=${isNewUser}`);

      // 8) Send success message back to user on Telegram without blocking the login polling
      const baseUrl = process.env.APP_URL || (process.env.NODE_ENV === 'production' ? 'https://xoethiopia.com' : 'http://localhost:8081');
      const returnUrl = `${baseUrl}/home/account`;
      bot.sendMessage(chatId,
        '✅ *ምዝገባው/መግባቱ ተሳክቷል! / Login Successful!*\n\n' +
        'አሁን ተመልሰው ወደ ጨዋታው መግባት ይችላሉ።\n' +
        'Tap the button below to return to XO Ethiopia:',
        { 
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[
              { text: '🎮 Return to XO ET Game / ወደ ጨዋታው ተመለስ', url: returnUrl }
            ]]
          }
        }
      ).catch(() => {});

      // 10) FIRE-AND-FORGET: Apply welcome bonuses for new users
      if (isNewUser) {
        setImmediate(async () => {
          try {
            console.log(`[TELEGRAM_BONUS] Processing bonuses for new user ${user.id}...`);
            await applyNewUserGiveaways(user.id).catch(err =>
              console.error('[TELEGRAM_GIVEAWAY_ERR]', err.message)
            );
          } catch (bonusErr) {
            console.error('[TELEGRAM_BONUS] Failed:', bonusErr.message);
          }
        });
      }

    } catch (err) {
      console.error('[TELEGRAM] Contact handler error:', err);
      bot.sendMessage(chatId,
        '❌ ችግር ተፈጥሯል። እባክዎ እንደገና ይሞክሩ።\nAn error occurred. Please try again.',
        { reply_markup: { remove_keyboard: true } }
      ).catch(() => {});
    }
  }

  // ── Handle contact sharing ────────────────────────────────────────────────
  bot.on('contact', async (msg) => {
    const chatId = msg.chat.id;
    const contact = msg.contact;

    // CRITICAL SECURITY: Verify the sender IS the contact owner
    if (!contact.user_id || contact.user_id !== msg.from.id) {
      return bot.sendMessage(chatId,
        '⚠️ የራስዎን ስልክ ቁጥር ብቻ ያጋሩ።\n' +
        'Please share YOUR OWN phone number, not someone else\'s.',
        { reply_markup: { remove_keyboard: true } }
      );
    }

    await processPhoneLogin(chatId, contact.phone_number, msg);
  });

  // ── Handle text messages containing phone numbers ─────────────────────────
  bot.on('message', async (msg) => {
    if (msg.contact || !msg.text || msg.text.startsWith('/')) return;
    const text = msg.text.trim();
    const phoneMatch = text.match(/^(?:\+251|251|0)?([97]\d{8})$/);
    if (phoneMatch) {
      const chatId = msg.chat.id;
      console.log(`[TELEGRAM] Phone number text received: ${text}`);
      await processPhoneLogin(chatId, text, msg);
    }
  });

  console.log(`[TELEGRAM] Bot @${BOT_USERNAME} initialized and polling.`);
  return bot;
}

/**
 * Create a new login session. Returns { sessionToken, deepLink }.
 */
async function createTelegramLoginSession() {
  const sessionToken = crypto.randomUUID();
  const sessionObj = { status: 'waiting' };

  memoryTgSessions.set(sessionToken, {
    data: JSON.stringify(sessionObj),
    expiresAt: Date.now() + SESSION_TTL * 1000,
  });

  try {
    await redis.set(
      `tg_login:${sessionToken}`,
      JSON.stringify(sessionObj),
      'EX',
      SESSION_TTL
    );
  } catch (err) {
    console.warn('[TELEGRAM] Redis set tg_login failed, using memory fallback:', err.message);
  }

  const envUsername = process.env.TELEGRAM_BOT_USERNAME;
  const username = (envUsername && envUsername !== 'Xoethiopia_Dev_Bot') ? envUsername : 'XoethiopiaBot';
  const deepLink = `https://t.me/${username}?start=${sessionToken}`;

  return { sessionToken, deepLink };
}

/**
 * Poll a login session. Returns the current state.
 */
async function pollTelegramLoginSession(sessionToken) {
  let raw = await redis.get(`tg_login:${sessionToken}`).catch(() => null);

  if (!raw && memoryTgSessions.has(sessionToken)) {
    const mem = memoryTgSessions.get(sessionToken);
    if (Date.now() <= mem.expiresAt) {
      raw = mem.data;
    } else {
      memoryTgSessions.delete(sessionToken);
    }
  }

  if (!raw) return { status: 'expired' };

  try {
    return JSON.parse(raw);
  } catch {
    return { status: 'error' };
  }
}

module.exports = {
  initTelegramBot,
  createTelegramLoginSession,
  pollTelegramLoginSession,
};
