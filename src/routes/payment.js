// payments.routes.js
const express = require('express');
const { randomUUID } = require('crypto');
const { withTx, pool } = require('../db/index');
const { METHODS, LIMITS, CHAPA, toCents } = require('../env');
const { auth } = require('../middleware/Auth');
const { initDeposit, requestWithdraw } = require("../models/payments.service");
const { handleWebhook } = require("../models/webhook.controller");
const { validate, schemas } = require('../middleware/Validation');

const router = express.Router();


// Utility: assert bank enabled
function assertBankEnabled(bank) {
  if (!['TELEBIRR_USSD', 'CBE_BIRR', 'WEB_CHECKOUT'].includes(bank)) {
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

router.get('/methods', auth, async (req, res) => {
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
// Chapa Return Page — After payment completes, redirect to home page
router.get('/chapa-return', async (req, res) => {
  const { tx_ref, status } = req.query;
  if (process.env.NODE_ENV !== 'production' && tx_ref && status === 'success') {
    try {
      const { completeDeposit } = require('../models/payments.service');
      await completeDeposit(tx_ref, 'CHAPA', 'MOCK_REF_' + Date.now());
    } catch (e) {
      console.log('[DEV MOCK DEPOSIT COMPLETE LOG]', e.message);
    }
  }
  const homeUrl = process.env.NODE_ENV === 'production'
    ? 'https://xoethiopia.com/home/gameplay'
    : 'http://localhost:8081/home/gameplay';
  res.redirect(homeUrl);
});

// Intermediate Bounce Page for Telegram/WebView CSRF Fix
router.get('/chapa-bounce', async (req, res) => {
  try {
    const url = req.query.url;
    let isValidChapaUrl = false;
    try {
      const parsed = new URL(url);
      isValidChapaUrl = parsed.hostname === 'checkout.chapa.co' && parsed.protocol === 'https:';
    } catch (_) { }
    if (!url || !isValidChapaUrl) {
      return res.status(400).send('Invalid Chapa checkout URL');
    }

    // Sanitize URL to prevent XSS — only allow validated Chapa URLs
    const safeUrl = encodeURI(url).replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <meta http-equiv="refresh" content="0; url=${safeUrl}">
        <title>Redirecting to Secure Payment...</title>
      </head>
      <body style="background: #060814; color: #fff; font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0;">
        <div style="text-align: center;">
           <p style="font-weight: bold; font-size: 16px;">Connecting to secure payment...</p>
           <p style="font-size: 13px; color: #888;">If you are not redirected automatically, <a href="${safeUrl}" style="color: #a78bfa;">click here</a>.</p>
        </div>
        <script>
           setTimeout(function() {
              window.location.href = "${safeUrl}";
           }, 200);
        </script>
      </body>
      </html>
    `);
  } catch (e) {
    res.status(500).send('Error redirecting');
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
router.post('/deposit', auth, validate(schemas.deposit), async (req, res) => {
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
    // After Chapa payment finishes, redirect to our chapa-return page which closes the popup and refreshes the main app
    const backendUrl = (process.env.BACKEND_URL || (process.env.NODE_ENV === 'production' ? 'https://xogpt-production.up.railway.app' : `http://localhost:${process.env.PORT || 2000}`)).replace(/\/$/, '');
    const platformReturnUrl = req.isWeb
      ? `${backendUrl}/payments/chapa-return`
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
    return res.status(e.status || 500).json({ detail: errorMsg });
  }
});

// 1b) CANCEL DEPOSIT (When user closes Chapa popup)
router.post('/cancel-deposit', auth, async (req, res) => {
  try {
    const { txId } = req.body;
    if (!txId) return res.status(400).json({ detail: "txId required" });

    // Mark as failed only if it belongs to the user and is still pending
    const result = await pool.query(`
      UPDATE wallet_transactions
      SET status = 'FAILED',
          meta = COALESCE(meta, '{}'::jsonb) || '{"failed_reason": "User cancelled checkout"}'::jsonb
      WHERE id = $1 AND user_id = $2 AND status = 'PENDING'
      RETURNING id
    `, [txId, req.user.id]);

    if (result.rowCount === 0) {
      return res.status(404).json({ detail: "Pending deposit not found" });
    }

    return res.json({ success: true, message: "Deposit cancelled" });
  } catch (e) {
    console.error("[DEPOSIT CANCEL] Error:", e);
    return res.status(500).json({ detail: "Failed to cancel deposit" });
  }
});


// 2) WITHDRAW
router.post('/withdraw', auth, validate(schemas.withdraw), async (req, res) => {
  try {
    const userId = req.user.id;
    const { amount, payoutMethod, payoutDestination } = req.body || {};

    const amt = Number(amount);
    if (!amt || amt <= 0) {
      return res.status(400).json({ detail: "Invalid amount" });
    }

    // Dynamic withdrawal limit check
    const limitQuery = await pool.query(`SELECT value FROM global_settings WHERE key = 'min_withdraw_amount'`);
    const dynMin = (limitQuery.rows.length && limitQuery.rows[0].value) ? Number(limitQuery.rows[0].value) : LIMITS.minPayout;

    if (amt < dynMin) {
      return res.status(400).json({ detail: `Minimum withdrawal is ${dynMin} ETB` });
    }

    // Respect the user's provided payout destination; fallback to registered phone only if destination is null/undefined/empty
    const phone = req.user.phone_number || req.user.number || '';
    const destination = (payoutDestination && String(payoutDestination).trim() !== "")
      ? payoutDestination
      : (phone || '251911000000');

    const out = await requestWithdraw({
      userId,
      amount: amt,
      phoneNumber: phone || destination,
      payoutMethod: payoutMethod || "TELEBIRR",
      payoutDestination: destination,
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


router.post('/withdrawal/approve', auth, async (req, res) => {
  // Placeholder for admin approval logic — protected with auth
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

    // Find up to 2 most recent pending deposits for this user within the last 24 hours
    const { rows } = await pool.query(
      `SELECT id AS tx_id 
         FROM wallet_transactions 
         WHERE user_id = $1 AND tx_type = 'DEPOSIT' AND status = 'PENDING' AND created_at > now() - interval '24 hours'
         ORDER BY created_at DESC LIMIT 2`,
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
        // Small delay between verify requests to prevent 429
        await new Promise((r) => setTimeout(r, 600));
      } catch (e) {
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
