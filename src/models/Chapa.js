// chapa.js
const crypto = require('crypto');
const { Readable } = require('stream');

const CHAPA_BASE = 'https://api.chapa.co/v1';

async function chapaFetch(path, method, bodyJson, secretKey) {
  const res = await fetch(`${CHAPA_BASE}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${secretKey}`,
      'Content-Type': 'application/json',
    },
    body: bodyJson ? JSON.stringify(bodyJson) : undefined,
  });
  const json = await res.json().catch(() => null);
  console.log(json);
  console.log(res)
  if (!res.ok) {
    const err = new Error(`Chapa ${method} ${path} failed`);
    err.response = json;
    throw err;
  }
  return json;
}

/**
 * Initialize a DEPOSIT with Chapa
 * Returns provider response (often includes checkout URL or instructions).
 */
async function initDeposit({ tx_ref, amountCents, mobile, bank, callback_url, secretKey }) {
  // Chapa expects amount in ETB string; we convert cents -> birr
  const amount = amountCents;
  // Map internal bank code to Chapa payment channel (adjust if your account differs)
  const methodMap = {
    TELEBIRR_USSD: 'telebirr',
    CBE_BIRR: 'cbe',
    WEB_CHECKOUT: 'card', // generic checkout
  };
  const payment_method = methodMap[bank] || 'card';

  const payload = {
    amount,
    currency: 'ETB',
    tx_ref,
    // Optional customer info (if you have it)
    // email, first_name, last_name, phone_number,
    phone_number: mobile,
    callback_url,
    // Some providers accept specifying payment channel
    // For Chapa, "payment_method" is supported for some channels
    payment_method,
    customization: { title: 'Wallet Top-up', description: `Deposit via ${bank}` },
  };

  return chapaFetch('/transaction/initialize', 'POST', payload, secretKey);
}

/**
 * Initiate a PAYOUT (withdrawal) with Chapa Business payouts.
 * You must have payouts enabled. Adjust fields to your KYC scope.
 */
async function initPayout({ tx_ref, amountCents, bank, account_name, account_number, secretKey }) {
  const amount = (amountCents / 100).toFixed(2);
  const methodMap = {
    TELEBIRR_USSD: 'telebirr',
    CBE_BIRR: 'cbe',
    WEB_CHECKOUT: 'card', // generic checkout
  };
  const payment_method = methodMap[bank] || 'card';
  console.log(tx_ref, tx_ref.length)
  const body = {
    "amount": 20,
    "reference": tx_ref,
    "bank_code": 855,
    "account_name": account_name,
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

module.exports = { initDeposit, initPayout, verifyTx };
