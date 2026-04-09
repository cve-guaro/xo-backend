// env.js
require('dotenv').config();

function bool(v) { return String(v).toLowerCase() === 'true'; }
function toCents(etb) {
  return Number(parseInt(etb));
}


const METHODS = {
  TELEBIRR_USSD: bool(process.env.TELEBIRR_USSD_ENABLED),
  CBE_BIRR: bool(process.env.CBE_BIRR_ENABLED),
  WEB_CHECKOUT: bool(process.env.WEB_CHECKOUT_ENABLED),
};

const LIMITS = {
  minDeposit: toCents(process.env.MIN_DEPOSIT || 10),
  maxDeposit: toCents(process.env.MAX_DEPOSIT || 50000),
  minPayout: toCents(process.env.MIN_PAYOUT || 50),
  maxPayout: toCents(process.env.MAX_PAYOUT || 100000),
};

const CHAPA = {
  secret: (process.env.CHAPA_SECRET_KEY || 'test-key').trim(),
  publicKey: (process.env.CHAPA_PUBLIC_KEY || '').trim(),
  encryptionKey: (process.env.CHAPA_ENCRYPTION_KEY || '').trim(),
  webhookSecret: (process.env.CHAPA_WEBHOOK_SECRET || process.env.CHAPA_SECRET_KEY || 'test-key').trim(),
  callbackUrl: process.env.CHAPA_WEBHOOK_URL || 'https://xogpt-production.up.railway.app/payments/webhook',
};


if (!CHAPA.secret) throw new Error('CHAPA_SECRET_KEY is required');

module.exports = { METHODS, LIMITS, CHAPA, toCents };
