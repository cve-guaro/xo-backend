const { body } = require("express-validator");
const { completeDeposit } = require("./payments.service.js");
const { CHAPA } = require("../env.js");
require('dotenv').config();
const crypto = require('crypto');
const { pool } = require("../db/index");

// Map provider payload -> { eventType, userId, amount, providerRef }
function parseProviderEvent(body) {
  // CHANGE THIS to match your provider payload
  const event = body && body.event;
  const providerRef = body && body.tx_ref;

  return { event, providerRef };
}

function verifyChapaWebhookSignature(headers, rawBodyBuffer, secretKey) {
  if (!secretKey) throw new Error("Missing CHAPA secret key");

  const expectedSig = headers["chapa-signature"] || headers["x-chapa-signature"] || headers["Chapa-Signature"];
  
  console.log("[WEBHOOK DEBUG] Signature header:", expectedSig || "NONE");
  console.log("[WEBHOOK DEBUG] Raw body exists:", !!rawBodyBuffer, "| Length:", rawBodyBuffer?.length || 0);

  // If Chapa doesn't send a signature header, allow but log warning
  if (!expectedSig) {
    console.warn("[WEBHOOK] No signature header from Chapa — allowing webhook through.");
    return true;
  }

  // Chapa signs webhooks using SHA256(secretKey), NOT HMAC(body, secretKey)
  // The signature is a fixed hash of your webhook secret key
  const hash = crypto.createHash('sha256').update(secretKey).digest('hex');
  console.log("[WEBHOOK DEBUG] SHA256(secret):", hash, "| Expected:", expectedSig);
  
  return (hash === expectedSig);
};

async function handleWebhook(req, res) {
  try {
    const isValid = verifyChapaWebhookSignature(req.headers, req.rawBody, CHAPA.webhookSecret);
    if (!isValid) {
      const details = {
        headers: req.headers,
        reason: 'Signature mismatch',
        bodyShort: JSON.stringify(req.body || {}).slice(0, 200)
      };
      
      // Log critical security alert
      await pool.query(
        `INSERT INTO system_alerts (event_type, details, severity, ip_address) 
         VALUES ($1, $2, $3, $4)`,
        ['WEBHOOK_SIGNATURE_MISMATCH', details, 'CRITICAL', req.ip || req.headers['x-forwarded-for']]
      ).catch(e => console.error('[ALERTS] Failed to log alert:', e));

      return res.status(403).json({ error: "Forbidden: Signature Mismatch" });
    }

    const { event, providerRef } = parseProviderEvent(req.body);
    if (!event || !providerRef) {
      return res.status(400).json({ detail: "Invalid webhook payload" });
    }

    if (event === "charge.success") {
      console.log("[LOCAL TEST] Event is charge.success. Processing deposit for ref: ", providerRef);
      const out = await completeDeposit(providerRef, "CHAPA");
      console.log("[LOCAL TEST] Deposit processed successfully: ", out);
      return res.json({ ok: true, ...out });
    }

    return res.json({ ok: true, ignored: true });
  } catch (e) {
    console.error("Webhook error:", e);
    return res.status(500).json({ detail: "Webhook failed" });
  }
}


module.exports = {
  handleWebhook,
};
