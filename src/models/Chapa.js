// chapa.js
const crypto = require('crypto');
const { Readable } = require('stream');

const CHAPA_BASE = 'https://api.chapa.co/v1';

async function chapaFetch(path, method, bodyJson, secretKey) {
  const res = await fetch(`${CHAPA_BASE}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer CHASECK-gn0RFezIBSCzmMnZyrb2rGgTCfQCLBVy`,
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
async function initChapaDeposit(tx_ref, amount, mobile, bank, callback_url, secretKey ) {
  // Map internal bank code to Chapa payment channel (adjust if your account differs)
  const methodMap = {
    TELEBIRR_USSD: 'telebirr',
    CBE_BIRR: 'cbe',
    WEB_CHECKOUT: 'card', // generic checkout
  };
  const payment_method = methodMap[bank] || 'card';
  console.log(amount, tx_ref, mobile)

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

  return chapaFetch('/transaction/initialize', 'POST', payload, 'CHASECK-gn0RFezIBSCzmMnZyrb2rGgTCfQCLBVy');
}

/**
 * Initiate a PAYOUT (withdrawal) with Chapa Business payouts.
 * You must have payouts enabled. Adjust fields to your KYC scope.
 */
async function initChapaPayout(tx_ref, amount, account_number, bank, account_name, secretKey) {
  const methodMap = {
    TELEBIRR_USSD: 'telebirr',
    CBE_BIRR: 'cbe',
    WEB_CHECKOUT: 'card', // generic checkout
  };
  const payment_method = methodMap[bank] || 'card';
  // console.log(tx_ref, tx_ref.length)
  console.log('dwithdraw data: ', tx_ref, amount, account_name, account_number)
  const body = {
    "amount": amount,
    "reference": tx_ref,
    "bank_code": 855,
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

module.exports = { initChapaDeposit, initChapaPayout, verifyTx };
