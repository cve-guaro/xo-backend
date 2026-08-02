// utils/sms.js — Shared GeezSMS sender
const axios = require('axios');

const GEEZ_SMS_URL = "https://api.geezsms.com/api/v1/sms/send";
const GEEZ_SMS_TOKEN = process.env.GEEZ_SMS_TOKEN || '';

// Circuit breaker: stop hammering GeezSMS when balance is depleted
let consecutiveFailures = 0;
let circuitOpenUntil = 0;
const MAX_FAILURES = 5;
const COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Send SMS via GeezSMS
 * @param {string} phone - Recipient phone number
 * @param {string} message - SMS body
 * @returns {Promise<boolean>} - true if sent
 */
async function sendSMS(phone, message) {
  if (!GEEZ_SMS_TOKEN || GEEZ_SMS_TOKEN.length < 10) {
    console.warn('[SMS] GeezSMS token not configured, skipping SMS');
    return false;
  }

  // Circuit breaker check
  if (Date.now() < circuitOpenUntil) {
    // Silently skip — don't log every single one
    return false;
  }

  try {
    const res = await axios.post(GEEZ_SMS_URL, {
      token: GEEZ_SMS_TOKEN,
      phone,
      msg: message,
    }, { timeout: 10000 });
    console.log(`[SMS] Sent to ${phone}: ${res.status}`);
    consecutiveFailures = 0; // Reset on success
    return true;
  } catch (e) {
    const msg = e.response?.data?.msg || e.response?.data?.message || e.message;
    if (typeof msg === 'string' && msg.includes('Safaricom')) {
      console.warn(`[SMS] Safaricom number not supported by GeezSMS sender ID: ${phone}`);
      return false;
    }
    consecutiveFailures++;
    
    // Check for "Insufficient amount" = balance depleted
    if (msg.includes('Insufficient') || consecutiveFailures >= MAX_FAILURES) {
      circuitOpenUntil = Date.now() + COOLDOWN_MS;
      console.error(`[SMS] ⛔ Circuit breaker OPEN — ${consecutiveFailures} failures (${msg}). SMS disabled for 10 min.`);
    } else {
      console.error(`[SMS] Failed (${consecutiveFailures}/${MAX_FAILURES}):`, msg);
    }
    return false;
  }
}

/**
 * Send withdrawal congratulations SMS in Amharic
 * @param {string} phone - User phone
 * @param {number} amount - ETB amount withdrawn
 * @param {string} [username] - User's display name
 */
async function sendWithdrawalSMS(phone, amount, username) {
  const name = username || 'ተጠቃሚ';
  const msg = `${name}! ስኬቶን official groupአችን\n 👉https://t.me/xoethiopia1 \nላይ በscreenshot በማጋራት ከዚም በላይ እንድናድግ ይርዱን እናመሰግናለን🙏`;
  return sendSMS(phone, msg);
}

/**
 * Send deposit success SMS in Amharic
 * @param {string} phone - User phone
 * @param {number} amount - ETB amount deposited
 * @param {string} [username] - User's display name
 */
async function sendDepositSMS(phone, amount, username) {
  const name = username || '\u1270\u1320\u1243\u121A';
  const msg = `\u2705 ${name}! ${Number(amount).toLocaleString()} \u1265\u122D \u12C8\u12F0 XOET \u1218\u1208\u12EB\u12CE \u1308\u1265\u1277\u120D!\nXO Ethiopia \u1235\u1208\u1270\u1320\u1240\u1219 \u12A5\u1293\u1218\u1230\u130D\u1293\u1208\u1295 \uD83C\uDFAE\n\u12A0\u1201\u1295 \u12ED\u132B\u12C8\u1271: xoethiopia.com`;
  return sendSMS(phone, msg);
}

module.exports = { sendSMS, sendWithdrawalSMS, sendDepositSMS };
