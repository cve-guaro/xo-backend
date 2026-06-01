// env.js
require('dotenv').config();

function bool(v) { return String(v).toLowerCase() === 'true'; }
function toCents(etb) {
  return Number(parseInt(etb));
}

// ─── STARTUP VALIDATION ────────────────────────────────────────────────────────
// Fail fast if critical secrets are missing — never run with broken config
const REQUIRED_VARS = [
  'JWT_SECRET',
  'DATABASE_URL',
  'CHAPA_SECRET_KEY',
];

if (process.env.NODE_ENV === 'production') {
  // Stricter checks in production
  REQUIRED_VARS.push('REDIS_URL', 'GEEZ_SMS_TOKEN', 'CHAPA_WEBHOOK_SECRET');
}

const missing = REQUIRED_VARS.filter(v => !process.env[v]);
if (missing.length > 0) {
  console.error(`\n🚨 FATAL: Missing required environment variables:\n   ${missing.join('\n   ')}\n`);
  console.error('   Set these in Railway (production) or .env (development).\n');
  process.exit(1);
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

