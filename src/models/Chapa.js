// chapa.js
const crypto = require('crypto');
const { Readable } = require('stream');
const { CHAPA } = require('../env'); // Import CHAPA config

const CHAPA_BASE = 'https://api.chapa.co/v1';

async function chapaFetch(path, method, bodyJson, secretKey) {
  // Use passed key or fallback to env, trimming whitespace explicitly
  const authKey = String(secretKey || CHAPA.secret || '').trim();
  
  const res = await fetch(`${CHAPA_BASE}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${authKey}`,
      'Content-Type': 'application/json',
    },
    body: bodyJson ? JSON.stringify(bodyJson) : undefined,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    console.error(`[CHAPA ERROR] ${method} ${path} | Status: ${res.status}`, json);
    const err = new Error(`Chapa ${method} ${path} failed: ${json?.message || res.statusText}`);
    err.response = json;
    err.status = res.status;
    throw err;
  }
  return json;
}

/**
 * Initialize a DEPOSIT with Chapa
 * Returns provider response (often includes checkout URL or instructions).
 */
function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function initChapaDeposit(tx_ref, amount, mobile, bank, callback_url, secretKey, user = {}, return_url ) {
  // Map internal bank code to Chapa payment channel (adjust if your account differs)
  const methodMap = {
    TELEBIRR_USSD: 'telebirr',
    CBE_BIRR: 'cbe',
    WEB_CHECKOUT: 'card', // generic checkout
  };
  const payment_method = methodMap[bank] || 'card';
  
  // Always guarantee a valid email — Chapa strictly validates this field
  const safeEmail = isValidEmail(user.email) 
    ? user.email 
    : `xoetuser${String(user.id || Date.now())}@gmail.com`;

  // Chapa requires email, first_name, last_name for initialization
  const payload = {
    amount,
    currency: 'ETB',
    tx_ref,
    email: safeEmail,
    first_name: user.username || 'XOET',
    last_name: 'User',
    phone_number: mobile,
    callback_url,
    return_url,
    payment_method,
    customization: { title: 'Wallet Top-up', description: `Deposit via ${bank}` },
  };

  console.log('[CHAPA DEBUG] Payload email:', safeEmail, '| user.email was:', user.email);
  return chapaFetch('/transaction/initialize', 'POST', payload, secretKey);
}

async function initChapaPayout(tx_ref, amount, account_number, bank, account_name, secretKey) {
  // Chapa Bank Codes: CBE = 855, Telebirr = 856 (approx, check Chapa docs for latest)
  const bankCodeMap = {
    'CBE_BIRR': '855',
    'TELEBIRR_USSD': '856', // Telebirr code in Chapa
  };
  const bank_code = bankCodeMap[bank] || '855';

  console.log('payout data: ', tx_ref, amount, account_name, account_number, bank_code)
  const body = {
    "amount": amount,
    "reference": tx_ref,
    "bank_code": bank_code,
    "account_name": account_name || "xo user",
    "account_number": account_number
  };
  return chapaFetch('/transfers', 'POST', body, secretKey);
}

/**
 * Verify a transaction by tx_ref (for webhook safety).
 */
async function verifyTx(tx_ref, secretKey) {
  return chapaFetch(`/transaction/verify/${encodeURIComponent(tx_ref)}`, 'GET', null, secretKey);
}

async function getChapaBalance(secretKey) {
  return chapaFetch('/accounts/balance', 'GET', null, secretKey);
}

module.exports = { initChapaDeposit, initChapaPayout, verifyTx, getChapaBalance };
