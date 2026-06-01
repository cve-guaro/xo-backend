const { completeDeposit } = require("./payments.service.js");
const { CHAPA } = require("../env.js");
require('dotenv').config();
const crypto = require('crypto');
const { pool } = require("../db/index");
const { sendDepositSMS, sendWithdrawalSMS } = require("../utils/sms.js");

// Map provider payload -> { eventType, providerRef, realReference }
function parseProviderEvent(body) {
  const event = body && body.event;
  const data = body && body.data;

  // Internal Ref (what we sent as tx_ref)
  const internalRef = (data && data.tx_ref) || (body && body.tx_ref) || (data && data.reference) || (body && body.reference);
  
  // Real Provider Ref (what Chapa uses for receipts)
  const realRef = (data && data.reference) || (body && body.reference) || internalRef;

  return { event, providerRef: internalRef, realReference: realRef };
}

/**
 * Chapa Webhook Signature Verification
 * 
 * According to Chapa's official docs (https://developer.chapa.co/docs/webhooks/):
 * 
 * There are TWO signature headers:
 *   1. `chapa-signature`   = HMAC-SHA256 of the SECRET KEY ITSELF, signed with the secret key
 *   2. `x-chapa-signature` = HMAC-SHA256 of the EVENT PAYLOAD, signed with the secret key
 * 
 * Chapa's own example code uses the API SECRET KEY (CHASECK_...) as the signing key,
 * NOT the webhook secret hash from the dashboard:
 * 
 *   var secret = process.env.SECRET_KEY;
 *   const hash = crypto.createHmac('sha256', secret)
 *     .update(JSON.stringify(req.body)).digest('hex');
 *   if (hash == req.headers['x-chapa-signature']) { ... }
 */
function verifyChapaWebhookSignature(headers, rawBodyBuffer, parsedBody) {
  // Collect both signature headers
  const chapaSig = headers["chapa-signature"];
  const xChapaSig = headers["x-chapa-signature"];
  const anySig = chapaSig || xChapaSig;

  if (!anySig) {
    console.warn("[WEBHOOK] No signature header from Chapa — skipping verification.");
    return false;
  }

  console.log("[WEBHOOK VERIFY] Headers present:",
    chapaSig ? "chapa-signature=YES" : "chapa-signature=NO",
    xChapaSig ? "x-chapa-signature=YES" : "x-chapa-signature=NO"
  );

  // The keys to try: API secret key (from Chapa docs example) AND webhook hash
  const apiKey = CHAPA.secret;           // CHASECK_...
  const webhookHash = CHAPA.webhookSecret; // the hash from dashboard Settings > Webhooks

  // Build the body string for HMAC computation
  const bodyStr = rawBodyBuffer
    ? rawBodyBuffer.toString("utf8")
    : JSON.stringify(parsedBody || {});
  const jsonStr = JSON.stringify(parsedBody || {});

  // ------ Attempt all known Chapa signing strategies ------

  const results = {};

  // Strategy 1: x-chapa-signature = HMAC(apiKey, JSON.stringify(body))  <-- Chapa's official example
  if (apiKey) {
    results["HMAC(APIKey, JSON.stringify)"] = crypto.createHmac("sha256", apiKey).update(jsonStr).digest("hex");
  }

  // Strategy 2: x-chapa-signature = HMAC(apiKey, rawBody)
  if (apiKey && rawBodyBuffer) {
    results["HMAC(APIKey, rawBody)"] = crypto.createHmac("sha256", apiKey).update(rawBodyBuffer).digest("hex");
  }

  // Strategy 3: HMAC(webhookHash, JSON.stringify(body))
  if (webhookHash) {
    results["HMAC(WebhookHash, JSON.stringify)"] = crypto.createHmac("sha256", webhookHash).update(jsonStr).digest("hex");
  }

  // Strategy 4: HMAC(webhookHash, rawBody)
  if (webhookHash && rawBodyBuffer) {
    results["HMAC(WebhookHash, rawBody)"] = crypto.createHmac("sha256", webhookHash).update(rawBodyBuffer).digest("hex");
  }

  // Strategy 5: chapa-signature self-check = HMAC(webhookHash, webhookHash)
  if (webhookHash) {
    results["HMAC(WebhookHash, WebhookHash) [self]"] = crypto.createHmac("sha256", webhookHash).update(webhookHash).digest("hex");
  }

  // Strategy 6: chapa-signature self-check = HMAC(apiKey, apiKey)
  if (apiKey) {
    results["HMAC(APIKey, APIKey) [self]"] = crypto.createHmac("sha256", apiKey).update(apiKey).digest("hex");
  }

  // Check ALL strategies against BOTH headers
  const sigToCheck = xChapaSig || chapaSig;
  let matchedStrategy = null;

  for (const [name, hash] of Object.entries(results)) {
    if (hash.toLowerCase() === sigToCheck.toLowerCase()) {
      matchedStrategy = name;
      break;
    }
    // Also check chapa-signature separately if both exist
    if (chapaSig && chapaSig !== xChapaSig && hash.toLowerCase() === chapaSig.toLowerCase()) {
      matchedStrategy = `${name} [via chapa-signature]`;
      break;
    }
  }

  if (matchedStrategy) {
    console.log(`[WEBHOOK VERIFY] ✅ Signature VALID via strategy: ${matchedStrategy}`);
    return true;
  }

  // No match — log everything for debugging
  console.error("[WEBHOOK VERIFY] ❌ Signature mismatch! None of the strategies matched.");
  console.error(`  Received signature: ${sigToCheck}`);
  console.error(`  Payload size: ${bodyStr.length} bytes`);
  for (const [name, hash] of Object.entries(results)) {
    const match = hash.toLowerCase() === sigToCheck.toLowerCase() ? "✅" : "❌";
    console.error(`  ${match} ${name}: ${hash}`);
  }
  console.error(`  API Key (last 4): ****${(apiKey || "").slice(-4)}`);
  console.error(`  Webhook Hash (last 4): ****${(webhookHash || "").slice(-4)}`);

  return false;
}

async function handleWebhook(req, res) {
  try {
    const isValid = verifyChapaWebhookSignature(req.headers, req.rawBody, req.body);
    if (!isValid) {
      const details = {
        reason: 'Webhook signature mismatch — REJECTED for security',
        bodyShort: JSON.stringify(req.body || {}).slice(0, 200),
        headers: {
          'chapa-signature': req.headers['chapa-signature'] ? 'present' : 'missing',
          'x-chapa-signature': req.headers['x-chapa-signature'] ? 'present' : 'missing',
        }
      };

      await pool.query(
        `INSERT INTO system_alerts (event_type, details, severity, ip_address)
         VALUES ($1, $2, $3, $4)`,
        ['WEBHOOK_SIGNATURE_REJECTED', details, 'CRITICAL', req.ip || req.headers['x-forwarded-for']]
      ).catch(e => console.error('[ALERTS] Failed to log alert:', e));

      console.error("[WEBHOOK SECURITY] ❌ Signature mismatch — REJECTING webhook. Alert logged. Deposit-verify cron will pick up legitimate payments.");
      return res.status(401).json({ error: 'Invalid webhook signature' });
    }

    const { event, providerRef, realReference } = parseProviderEvent(req.body);
    if (!event || !providerRef) {
      console.warn("[WEBHOOK] Missing event or providerRef. Body:", JSON.stringify(req.body).slice(0, 300));
      return res.status(400).json({ detail: "Invalid webhook payload" });
    }

    console.log(`[WEBHOOK] Event: ${event} | InternalRef: ${providerRef} | ProviderRef: ${realReference}`);

    if (event === "charge.success") {
      console.log("[WEBHOOK] Processing charge.success deposit for ref:", providerRef);
      // Pass the real provider reference (e.g. 'CHAPA-xxxx') and the full body as meta
      const out = await completeDeposit(providerRef, "CHAPA", realReference, req.body);
      console.log("[WEBHOOK] Deposit completed:", out);

      // Send SMS notification ONLY if this is the first time completing (not a duplicate)
      // NOTE: Deposit SMS disabled per admin request — only withdrawal SMS is active
      // if (!out.alreadyCompleted) {
      //   try {
      //     const txRow = await pool.query('SELECT user_id, amount FROM wallet_transactions WHERE id::text = $1::text OR provider_ref::text = $1::text', [providerRef]);
      //     if (txRow.rows[0]) {
      //       const userRow = await pool.query('SELECT number, display_name, username FROM users WHERE id = $1', [txRow.rows[0].user_id]);
      //       const phone = userRow.rows[0]?.number;
      //       const uname = userRow.rows[0]?.display_name || userRow.rows[0]?.username;
      //       if (phone) {
      //         sendDepositSMS(phone, Number(txRow.rows[0].amount), uname).catch(e => console.error('[SMS] Deposit SMS failed:', e.message));
      //       }
      //     }
      //   } catch (smsErr) { console.error('[SMS] Deposit SMS prep error:', smsErr.message); }
      // }

      return res.json({ ok: true, ...out });
    }

    if (event === "payout.success") {
      console.log("[WEBHOOK] Payout success for ref:", providerRef, "— updating transaction status to COMPLETED.");
      
      const updateResult = await pool.query(
        `UPDATE wallet_transactions 
         SET status = 'COMPLETED', updated_at = now() 
         WHERE id = $1 AND status = 'PENDING'
         RETURNING id, user_id, amount`,
        [providerRef]
      );

      // Only send SMS if the UPDATE actually changed a row (first time processing)
      if (updateResult.rowCount > 0) {
        try {
          const row = updateResult.rows[0];
          const userRow = await pool.query('SELECT number, display_name, username FROM users WHERE id = $1', [row.user_id]);
          const phone = userRow.rows[0]?.number;
          const uname = userRow.rows[0]?.display_name || userRow.rows[0]?.username;
          if (phone) {
            sendWithdrawalSMS(phone, Number(row.amount), uname).catch(e => console.error('[SMS] Withdrawal SMS failed:', e.message));
          }
        } catch (smsErr) { console.error('[SMS] Withdrawal SMS prep error:', smsErr.message); }
      } else {
        console.log("[WEBHOOK] Skipping withdrawal SMS — already completed (duplicate webhook).");
      }
      
      return res.json({ ok: true, event: "payout.success", ref: providerRef });
    }

    // Unknown event — acknowledge to stop retries
    console.log(`[WEBHOOK] Unhandled event type: ${event} — acknowledging.`);
    return res.json({ ok: true, ignored: true });
  } catch (e) {
    console.error("[WEBHOOK] Error:", e);
    return res.status(500).json({ detail: "Webhook failed" });
  }
}


module.exports = {
  handleWebhook,
};
