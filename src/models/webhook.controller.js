const { body } = require("express-validator");
const { completeDeposit } = require("./payments.service.js");
const { CHAPA } = require("../env.js");
require('dotenv').config();
const crypto = require('crypto');

// Map provider payload -> { eventType, userId, amount, providerRef }
function parseProviderEvent(body) {
  // CHANGE THIS to match your provider payload
  const event = body && body.event;
  const providerRef = body && body.tx_ref;

  return { event, providerRef };
}

function verifyChapaWebhookSignature(headers, rawBodyBuffer, secretKey) {
  if (!secretKey) throw new Error("Missing CHAPA secret key");

  const expectedSig = headers["chapa-signature"] || headers["x-chapa-signature"];
  if (!expectedSig) return false;

  // Hash the pure raw Buffer directly. DO NOT use JSON.stringify()
  const hash = crypto.createHmac('sha256', secretKey).update(rawBodyBuffer).digest('hex');
  
  return (hash === expectedSig);
};

async function handleWebhook(req, res) {
  try {
    const isValid = verifyChapaWebhookSignature(req.headers, req.rawBody, CHAPA.secret);
    if (!isValid) {
      console.warn("[WEBHOOK] Invalid signature detected. Request blocked.");
      return res.status(400).json({ detail: "Invalid Webhook Signature" });
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
