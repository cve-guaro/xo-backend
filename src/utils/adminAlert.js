/**
 * adminAlert.js — operator notification hook for critical money events.
 *
 * Sends to Telegram when a bot token + admin chat id are configured
 * (TELEGRAM_BOT_TOKEN + TELEGRAM_ADMIN_CHAT_ID env vars). Otherwise logs the
 * alert so it is never silently lost. Tests stub this module.
 */
let sentCount = 0;

async function sendAdminAlert(eventType, message, meta = {}) {
  sentCount++;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_ADMIN_CHAT_ID;
  const text = `⚠️ [${eventType}] ${message}${meta && Object.keys(meta).length ? '\n' + JSON.stringify(meta) : ''}`;

  if (token && chatId) {
    try {
      const axios = require('axios');
      await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
        chat_id: chatId,
        text,
        parse_mode: 'HTML'
      }, { timeout: 8000 });
      return { delivered: 'telegram' };
    } catch (e) {
      console.error(`[ADMIN ALERT] Telegram send failed for ${eventType}:`, e.message);
    }
  }
  // Always log so the alert exists even without Telegram configured
  console.error(`[ADMIN ALERT] ${text}`);
  return { delivered: 'log' };
}

function adminAlertCount() { return sentCount; }

module.exports = { sendAdminAlert, adminAlertCount };
