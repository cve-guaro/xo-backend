const crypto = require("crypto");
const { withTx } = require("../db/index.js");
const { SQL } = require("./payments.sql.js");
const { initChapaDeposit, initChapaPayout } = require("./Chapa.js");

function hash20(s) {
  return crypto.createHash("sha256").update(String(s)).digest("hex").slice(0, 20);
}

function makeIdempotencyKey(prefix, userId, anchor) {
  // same input -> same key (good for webhooks)
  return `${prefix}:${userId}:${hash20(`${userId}:${anchor}`)}`;
}

// ----------- Deposit (init) -----------
// payments.service.js
async function initDeposit({ userId, phoneNumber, amount, provider }) {
  return withTx(async (client) => {
    try {
      await client.query(SQL.ensureWallet, [userId]);

      // PENDING deposit, no idempotency needed here
      const { rows } = await client.query(SQL.applyTx, [
        userId,
        "DEPOSIT",
        Number(amount),
        "PENDING",
        crypto.randomUUID(), // internal only
        "CHAPA",
        null,
        {},
      ]);

      const paymentData = rows[0]

      const deposit = await initChapaDeposit(
        paymentData.tx_id,
        amount,
        phoneNumber,
        provider,
        'https://test.com',
        ''
      )

      const url = deposit.data.checkout_url || null

      return { txId: rows[0].tx_id, checkout_url: url };
    } catch (err) {
      throw new Error("deposit failed");
    }
  });
}


// ----------- Deposit (complete via webhook) -----------
// payments.service.js
async function completeDeposit(providerRef, provider) {
  return withTx(async (client) => {
    // 1) Find the deposit tx row using providerRef
    const found = await client.query(SQL.findDepositTxByProviderRef, [provider, providerRef]);
    const txRow = found.rows[0];

    if (!txRow) {
      // This means you never created a DEPOSIT tx row with provider_ref = providerRef
      throw new Error(`Deposit tx not found for providerRef=${providerRef}`);
    }

    const txId = txRow.id;
    const userId = txRow.user_id;

    await client.query(SQL.markTxCompletedById, [providerRef, "CHAPA", txId]);
    await client.query(SQL.applyExistingTx, [providerRef]); // providerRef == tx_id

    // 4) Fetch wallet by userId (you need userId for this query)
    const walletRes = await client.query(SQL.getWalletByUserId, [userId]);

    return { txId: txId, wallet: walletRes.rows[0] };
  });
}



// ----------- Prize / Won money (available + withdrawable) -----------
async function creditPrize({ userId, amount, meta }) {
  console.warn('prize called')
  const sourceRef = (meta && meta.sourceRef) || crypto.randomUUID();
  const idem = makeIdempotencyKey("PRIZE", userId, sourceRef);

  return withTx(async (client) => {
    try {
      await client.query(SQL.ensureWallet, [userId]);

      const { rows } = await client.query(SQL.applyTx, [
        userId,
        "PRIZE",
        Number(amount),
        "COMPLETED",
        idem,
        null,
        sourceRef,
        meta || {},
      ]);

      const walletRes = await client.query(SQL.getWallet, [userId]);
      console.warn('prize finished')
      return { txId: rows[0].tx_id, wallet: walletRes.rows[0] };
    } catch (err) {
      console.warn(err)
      throw new Error("crediting prize failed");
    }
  });
}

// ----------- Withdraw request (reserve funds immediately) -----------
async function requestWithdraw({ userId, phoneNumber, amount, payoutMethod, payoutDestination }) {
  const anchor = `${payoutMethod}:${payoutDestination}:${amount}:${Date.now()}`;
  const idem = makeIdempotencyKey("WREQ", userId, anchor);

  return withTx(async (client) => {
    try {
      await client.query(SQL.ensureWallet, [userId]);

      // Reserve funds right now (COMPLETED -> apply)
      const txRes = await client.query(SQL.applyTx, [
        userId,
        "WITHDRAW_REQUEST",
        Number(amount),
        "COMPLETED",
        idem,
        null,
        null,
        { payoutMethod, payoutDestination },
      ]);

      const reserveTxId = txRes.rows[0].tx_id;
      const paymentData = txRes.rows[0]

      const reqRes = await client.query(SQL.createWithdrawRequest, [
        userId,
        Number(amount),
        payoutMethod,
        payoutDestination,
        reserveTxId,
      ]);

      const withdraw = await initChapaPayout(
        paymentData.tx_id,
        amount,
        phoneNumber,
        payoutMethod,
        "xoet user",
        'https://test.com',
        ''
      )

      const walletRes = await client.query(SQL.getWallet, [userId]);
      return { withdrawRequest: reqRes.rows[0], wallet: walletRes.rows[0] };
    } catch (err) {
      console.log(err)
      throw new Error("withdraw failed");
    }
  });
}

module.exports = {
  initDeposit,
  completeDeposit,
  creditPrize,
  requestWithdraw,
  // exporting helpers is optional; remove if you don’t want them public
  makeIdempotencyKey,
  hash20,
};
