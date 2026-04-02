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

  const sigA = headers["chapa-signature"];
  const sigB = headers["x-chapa-signature"];

  if (!sigA && !sigB) {
    console.log('sig a: ', sigA)
    throw new Error("Missing chapa-signature and x-chapa-signature");
  }
  // IMPORTANT: Chapa signs the raw JSON request body, not the secret
  const hash = crypto.createHmac('sha256', secretKey).update(JSON.stringify(rawBodyBuffer)).digest('hex');
  console.log('computed:', hash, 'received:', sigA);
  return (hash === sigA || hash === sigB);
};

async function handleWebhook(req, res) {
  try {
    console.log(req.headers)
    const body = req.body;
    const verify = true; // verifyChapaWebhookSignature(req.headers, body, CHAPA.secret);
    console.log("[LOCAL TEST] Webhook received. Bypassing signature check: ", verify);
    // TODO: Restore verifyChapaWebhookSignature for production
    if (!verify) return res.status(400).json("sig failed")
    const { event, providerRef } = parseProviderEvent(body);
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
