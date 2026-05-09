// utils/sms.js — Shared GeezSMS sender
const axios = require('axios');

const GEEZ_SMS_URL = "https://api.geezsms.com/api/v1/sms/send";
const GEEZ_SMS_TOKEN = process.env.GEEZ_SMS_TOKEN || '';

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
  try {
    const res = await axios.post(GEEZ_SMS_URL, {
      token: GEEZ_SMS_TOKEN,
      phone,
      msg: message,
    }, { timeout: 10000 });
    console.log(`[SMS] Sent to ${phone}: ${res.status}`);
    return true;
  } catch (e) {
    console.error('[SMS] Failed:', e.message);
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
  const name = username || '\u1270\u1320\u1243\u121A';
  const msg = `${name}! \u12E8${Number(amount).toLocaleString()} \u1265\u122D withdraw \u1260\u1270\u1233\u12AB \u1201\u1294\u1273 \u12A0\u12CD\u1325\u1270\u12CB\u120D\u1362 Withdraw \u12EB\u12F0\u1228\u1309\u1275\u1295 screenshot\u1293 \u1235\u12AC\u1276\u1295 \u12E8telegram official group\u12A3\u127D\u1295 https://t.me/xoethiopia1\n\u120B\u12ED \u1260\u121B\u130B\u122B\u1275 \u12A8\u12DA\u121D \u1260\u120B\u12ED \u12A5\u1295\u12F5\u1293\u12F5\u130D \u12ED\u122D\u12F1\u1295\u1364\u12A5\u1293\u1218\u1230\u130D\u1293\u1208\u1295\uD83D\uDE4F`;
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
