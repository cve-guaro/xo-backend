// src/bot/telegram.js
// Telegram Bot for XO ET — handles login via phone number sharing
const TelegramBot = require('node-telegram-bot-api').TelegramBot || require('node-telegram-bot-api');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { pool, redis, withTx, getGlobalSetting } = require('../db/index');
const { applyNewUserGiveaways } = require('../models/payments.service');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const BOT_USERNAME = (process.env.TELEGRAM_BOT_USERNAME && process.env.TELEGRAM_BOT_USERNAME !== 'Xoethiopia_Dev_Bot') ? process.env.TELEGRAM_BOT_USERNAME : 'XoethiopiaBot';
const JWT_SECRET = process.env.JWT_SECRET;
const SUPER_ADMIN_NUMBERS = (process.env.SUPER_ADMIN_NUMBERS || '').split(',').map(n => n.trim()).filter(Boolean);

const SESSION_TTL = 300;     // 5 minutes — how long a login session lives
const RESULT_TTL  = 120;     // 2 minutes — how long the completed result stays for polling

let bot = null;

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
    polling: {
      autoStart: true,
      params: { timeout: 10 },
    },
    request: proxyUrl ? requestOptions : undefined
  });

  // Clear any existing WebHook to avoid conflict
  bot.deleteWebHook().catch(() => {});

  // Log all incoming messages for debugging
  bot.on('message', (msg) => {
    console.log(`[TELEGRAM] Raw message received: chat=${msg.chat.id}, text="${msg.text || ''}"`);
  });

  let lastConflictLog = 0;
  // Swallow polling errors to prevent server crash (throttles 409 multi-instance logs)
  bot.on('polling_error', (err) => {
    if (err.message && err.message.includes('409 Conflict')) {
      const now = Date.now();
      if (now - lastConflictLog > 60000) { // Log at most once per minute
        lastConflictLog = now;
        console.warn('[TELEGRAM] 409 Conflict: Another bot instance or old Railway container is polling. Active instance will auto-recover once previous container stops.');
      }
      return;
    }
    console.error('[TELEGRAM] Polling error (non-fatal):', err.message);
  });

  // ── Handle /start <sessionToken> ──────────────────────────────────────────
  bot.onText(/\/start (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const sessionToken = match[1];

    try {
      // Verify session exists in Redis
      const sessionData = await redis.get(`tg_login:${sessionToken}`);
      if (!sessionData) {
        return bot.sendMessage(chatId,
          '❌ ጊዜው ያለፈበት ሊንክ ነው።\n\nLink expired. Please go back to XO ET and try again.');
      }

      // Store which chat is linked to this session (forward + reverse lookup)
      await redis.set(`tg_login:${sessionToken}:chat`, String(chatId), 'EX', SESSION_TTL);
      await redis.set(`tg_chat_session:${chatId}`, sessionToken, 'EX', SESSION_TTL);

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
      // Direct reverse lookup — we stored chatId→sessionToken in /start handler
      let sessionToken = null;
      try {
        sessionToken = await redis.get(`tg_chat_session:${chatId}`);
      } catch (redisErr) {
        console.warn('[TELEGRAM] Redis get chat session failed:', redisErr.message);
      }

      if (!sessionToken) {
        return bot.sendMessage(chatId,
          '❌ ጊዜው ያለፈበት ነው። ወደ XO ET ተመልሰው እንደገና ይሞክሩ።\n' +
          'Session expired. Go back to XO ET and try again.',
          { reply_markup: { remove_keyboard: true } }
        );
      }

      // Verify the session is still active
      const sessionCheck = await redis.get(`tg_login:${sessionToken}`);
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
        // 1) Find or create user by phone number
        const { rows: userRows } = await client.query(
          `INSERT INTO users (number)
           VALUES ($1)
           ON CONFLICT (number)
           DO UPDATE SET number = EXCLUDED.number
           RETURNING id, number, username, avatar, new_user, role, sound_muted`,
          [normalizedPhone]
        );

        const user = userRows[0];

        // 2) Save Telegram identity on the user
        await client.query(
          `UPDATE users SET telegram_id = $1, telegram_username = $2 WHERE id = $3`,
          [telegramId, telegramUsername, user.id]
        );

        // 3) Ensure wallet exists
        await client.query(
          `INSERT INTO wallets (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
          [user.id]
        );

        // 4) Capture and clear new_user flag
        const isNewUser = !!user.new_user;
        if (user.new_user) {
          await client.query(`UPDATE users SET new_user = false WHERE id = $1`, [user.id]);
        }

        // 5) Ensure super-admin
        if (SUPER_ADMIN_NUMBERS.includes(normalizedPhone) && user.role !== 'superadmin') {
          await client.query(`UPDATE users SET role = 'superadmin' WHERE id = $1`, [user.id]);
          user.role = 'superadmin';
        }

        return { user, isNewUser };
      });

      const { user, isNewUser } = result;

      // 6) Generate JWT (same claims as otp.js)
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

      // 7) Generate refresh token
      const refreshToken = crypto.randomBytes(40).toString('hex');
      try {
        await redis.set(`refresh_token:${refreshToken}`, user.id, 'EX', 7 * 24 * 60 * 60);
      } catch (redisErr) {
        console.warn('[TELEGRAM] Refresh token store failed (non-fatal):', redisErr.message);
      }

      // 8) Store completed login result for the app to poll
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

      memoryTgSessions.set(sessionToken, {
        data: doneResult,
        expiresAt: Date.now() + RESULT_TTL * 1000,
      });

      try {
        await redis.set(`tg_login:${sessionToken}`, doneResult, 'EX', RESULT_TTL);
      } catch (err) {
        console.warn('[TELEGRAM] Redis set completed login failed, using memory fallback:', err.message);
      }

      // Clean up the chat mapping (both directions)
      await redis.del(`tg_login:${sessionToken}:chat`).catch(() => {});
      await redis.del(`tg_chat_session:${chatId}`).catch(() => {});

      console.log(`[TELEGRAM] Login completed: user=${user.id} phone=${normalizedPhone} isNew=${isNewUser}`);

      // 9) Send success message with inline button back to the game
      const baseUrl = process.env.APP_URL || (process.env.NODE_ENV === 'production' ? 'https://xoethiopia.com' : 'http://localhost:8081');
      const returnUrl = `${baseUrl}/home/account`;
      await bot.sendMessage(chatId,
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
      );

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
// In-memory fallback for Telegram login sessions when Redis circuit breaker is open
const memoryTgSessions = new Map();

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
