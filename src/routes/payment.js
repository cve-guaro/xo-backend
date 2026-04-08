// payments.routes.js
const express = require('express');
const { randomUUID } = require('crypto');
const { withTx, pool } = require('../db/index');
const { METHODS, LIMITS, CHAPA, toCents } = require('../env');
const { auth } = require('../middleware/Auth');
const { initDeposit, requestWithdraw } = require("../models/payments.service");
const { handleWebhook } = require("../models/webhook.controller");

const router = express.Router();


// Utility: assert bank enabled
function assertBankEnabled(bank) {
  if (!['TELEBIRR_USSD','CBE_BIRR','WEB_CHECKOUT'].includes(bank)) {
    const e = new Error('Unsupported bank'); e.status = 400; throw e;
  }
  if (!METHODS[bank]) {
    const e = new Error(`${bank} is disabled`); e.status = 400; throw e;
  }
}

function assertAmountForDeposit(amountCents) {
  if (amountCents < LIMITS.minDeposit || amountCents > LIMITS.maxDeposit) {
    const e = new Error('Amount out of deposit limits'); e.status = 400; throw e;
  }
}
function assertAmountForPayout(amountCents) {
    console.log(LIMITS)
  if (amountCents < LIMITS.minPayout || amountCents > LIMITS.maxPayout) {
    const e = new Error('Amount out of payout limits'); e.status = 400; throw e;
  }
}

// Ensure wallet exists
async function ensureWallet(client, userId) {
  await client.query(
    `INSERT INTO wallets (user_id) VALUES ($1)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId]
  );
}

router.get('/methods', async (req, res) => {
  try {
const METHODS = [
  {
    key: "CHAPA",
    label: "Chapa",
    subtitle: "Card & bank checkout",
    colors: ["#7C3AED", "#22D3EE"],
    icon: "card",
    // ✅ add your image asset here:
    // put a png in: assets/images/payment/chapa.png
    imageUrl: 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcQ0f2iB3_eSklK4Hc4DyH2IiG3vUM_bdm2sWA&s',
  },
]

    return res.json(METHODS);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ detail: "failed to return payment methods" });
  }
});

// 1) DEPOSIT
router.post('/deposit', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { amount, provider, clientRef } = req.body || {};

    const amt = Number(amount);

    if (!Number.isFinite(amt) || amt < 10) {
      return res.status(400).json({ detail: "Invalid amount" });
    }

    // after validation → normalize
    const amountStr = amt.toFixed(2); // "10.00", "25.50"


    // 1. Determine the return destination
    // If web, go to Vercel. If mobile, let Chapa stay in the closed loop/handle return natively.
    const platformReturnUrl = req.isWeb 
       ? process.env.FRONTEND_URL 
       : undefined; // Safer to pass undefined for mobile if no scheme is ready

    const out = await initDeposit({
      userId,
      phoneNumber: req.user.phone_number,
      amount: amountStr,
      provider: provider || "UNKNOWN",
      clientRef,
      username: req.user.username,
      email: req.user.email,
      returnUrl: platformReturnUrl, // Pass the branched URL here
      isWeb: req.isWeb
    });

    return res.json(out);
  } catch (e) {
    const errorMsg = e.response?.message || e.message || "Deposit init failed";
    console.error("[DEPOSIT] Error:", e.response || e);
    return res.status(e.status || 500).json({ detail: errorMsg });
  }
});


// 2) WITHDRAW
router.post('/withdraw', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { amount, payoutMethod, payoutDestination } = req.body || {};

    const amt = Number(amount);
    if (!amt || amt <= 0) {
      return res.status(400).json({ detail: "Invalid amount" });
    }

    const out = await requestWithdraw({
      userId,
      amount: amt,
      phoneNumber: req.user.phone_number,
      payoutMethod: payoutMethod || "chapa",
      payoutDestination: payoutDestination || req.user.phone_number || "251900000000",
    });

    return res.json(out);
  } catch (e) {
    const msg = String(e && e.message ? e.message : "");

    if (msg.includes("Insufficient withdrawable")) {
      return res.status(409).json({ detail: "Insufficient withdrawable balance" });
    }
    if (msg.includes("Insufficient available")) {
      return res.status(409).json({ detail: "Insufficient available balance" });
    }

    console.error(e);
    return res.status(500).json({ detail: "Withdraw failed" });
  }
});

// 3) WEBHOOK (Chapa -> we finalize here)

router.post("/webhook", handleWebhook);


router.post('/withdrawal/approve', async (req, res) => {
  // Placeholder for admin approval logic
  console.log('Approve withdrawal endpoint hit');
  return res.status(200).json({ status: 'Not implemented' });
});

module.exports = router;
