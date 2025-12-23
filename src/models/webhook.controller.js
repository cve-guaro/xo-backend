const { body } = require("express-validator");
const { completeDeposit } = require("./payments.service.js");
require('dotenv').config();
const crypto = require('crypto')

// Map provider payload -> { eventType, userId, amount, providerRef }
function parseProviderEvent(body) {
  // CHANGE THIS to match your provider payload
  const event = body && body.event;
  const providerRef = body && body.tx_ref;

  return { event, providerRef };
}

function verifyChapaWebhookSignature(headers, rawBodyBuffer, secretKey) {
  if (!secretKey) throw new Error("Missing CHAPA secret key");

  const sigA = headers["Chapa-Signature"];
  const sigB = headers["x-chapa-signature"];

  if (!sigA && !sigB) {
    throw new Error("Missing chapa-signature and x-chapa-signature");
  }
  const hash = crypto.createHmac('sha256', secretKey).update(secretKey).digest('hex');
  console.log(hash, secretKey, sigA)
  return (hash === sigA)
};

async function handleWebhook(req, res) {
  try {

    const body = req.body;
    const verify = verifyChapaWebhookSignature(req.headers, body, ('jNHpBla8CcJVile0ZtTngl4z'));
    if (!verify) return res.status(400).json("sig failed")
    const { event, providerRef } = parseProviderEvent(body);
    if (!event || !providerRef) {
      return res.status(400).json({ detail: "Invalid webhook payload" });
    }

    if (event === "charge.success") {
      const out = await completeDeposit(providerRef, "CHAPA");
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
