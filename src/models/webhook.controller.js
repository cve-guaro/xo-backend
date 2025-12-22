const { completeDeposit } = require("./payments.service.js");

// Map provider payload -> { eventType, userId, amount, providerRef }
function parseProviderEvent(body) {
  // CHANGE THIS to match your provider payload
  const eventType = body && body.type;
  const userId =
    body &&
    body.data &&
    body.data.metadata &&
    body.data.metadata.userId;

  const amount = Number(body && body.data && body.data.amount);
  const providerRef = body && body.data && body.data.txId;

  return { eventType, userId, amount, providerRef };
}

async function handleWebhook(req, res) {
  try {
    const body = req.body;

    // TODO: verify webhook signature here (provider-specific)
    const { eventType, userId, amount, providerRef } =
      parseProviderEvent(body);

    if (!eventType || !userId || !amount || !providerRef) {
      return res.status(400).json({ detail: "Invalid webhook payload" });
    }

    if (eventType === "deposit.succeeded") {
      const out = await completeDeposit({
        userId,
        amount,
        provider: "YOUR_PROVIDER",
        providerRef,
      });

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
