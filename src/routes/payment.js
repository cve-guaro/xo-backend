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

// 0) GET BANK CODES DIRECTLY FROM CHAPA
router.get('/chapa-banks', async (req, res) => {
  try {
    const authKey = String(CHAPA.secret || '').trim();
    if (!authKey) return res.status(500).json({ detail: "No Chapa secret configured" });
    
    // Using global fetch (Node 18+)
    const r = await fetch('https://api.chapa.co/v1/banks', {
      headers: { 'Authorization': `Bearer ${authKey}` }
    });
    
    const d = await r.json();
    return res.json(d);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ detail: "failed to fetch chapa banks", error: e.message });
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

    // Lock payout destination to user's registered phone number to prevent money laundering
    const userPhone = req.user.phone_number || req.user.number;
    if (!userPhone) return res.status(400).json({ detail: "User phone number is missing." });
    
    const out = await requestWithdraw({
      userId,
      amount: amt,
      phoneNumber: userPhone,
      payoutMethod: payoutMethod || "chapa",
      payoutDestination: userPhone,
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

    if (e.status === 400) {
      return res.status(400).json({ detail: msg || "Invalid withdrawal request" });
    }

    console.error("[WITHDRAW] Error:", e);
    return res.status(e.status || 500).json({ detail: msg || "Withdraw failed" });
  }
});

// 3) WEBHOOK (Chapa -> we finalize here)

router.post("/webhook", handleWebhook);


router.post('/withdrawal/approve', async (req, res) => {
  // Placeholder for admin approval logic
  console.log('Approve withdrawal endpoint hit');
  return res.status(200).json({ status: 'Not implemented' });
});

router.get('/verify/:txRef', auth, async (req, res) => {
  try {
     const { verifyTx } = require('../models/Chapa');
     const { completeDeposit } = require('../models/payments.service');
     const txRef = req.params.txRef;

     // Verify via Chapa
     const chapaVer = await verifyTx(txRef);
     
     if (chapaVer?.status === 'success' && chapaVer?.data?.status === 'success') {
         try {
             // If this succeeds, it was PENDING and is now COMPLETED
             const out = await completeDeposit(txRef, "CHAPA");
             return res.json({ ok: true, status: 'COMPLETED', ...out });
         } catch (e) {
             // If it throws "Deposit tx not found", it means it's already COMPLETED by a webhook
             if (e.message && e.message.includes('not found')) {
                 return res.json({ ok: true, status: 'ALREADY_COMPLETED' });
             }
             throw e;
         }
     }
     
     return res.json({ ok: false, status: 'PENDING' });
  } catch (e) {
     console.error("[VERIFY API] Error:", e);
     return res.status(500).json({ detail: "Verification failed" });
  }
});

router.get('/verify-pending', auth, async (req, res) => {
  try {
     const { verifyTx } = require('../models/Chapa');
     const { completeDeposit } = require('../models/payments.service');
     const { pool } = require('../db/index');
     
     // Find all pending deposits for this user
     const { rows } = await pool.query(
        "SELECT id AS tx_id FROM wallet_transactions WHERE user_id = $1 AND tx_type = 'DEPOSIT' AND status = 'PENDING'",
        [req.user.id]
     );
     
     let completedCount = 0;
     for (const row of rows) {
         try {
             // Query Chapa to see if it actually succeeded
             const chapaVer = await verifyTx(row.tx_id);
             if (chapaVer?.status === 'success' && chapaVer?.data?.status === 'success') {
                 try {
                     await completeDeposit(row.tx_id, "CHAPA");
                     completedCount++;
                 } catch (e) { } // Ignore if already completed concurrently
             }
         } catch(e) {
             console.error(`[VERIFY PENDING] Error verifying tx ${row.tx_id}`);
         }
     }
     
     return res.json({ ok: true, completedCount });
  } catch (e) {
     console.error("[VERIFY PENDING] Fatal Error:", e);
     return res.status(500).json({ detail: "Background verification failed" });
  }
});

module.exports = router;
