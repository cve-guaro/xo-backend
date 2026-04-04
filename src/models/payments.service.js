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

      const amountEtb = Math.round(Number(amount));

      // PENDING deposit, no idempotency needed here
      const { rows } = await client.query(SQL.applyTx, [
        userId,
        "deposit",
        amountEtb,
        "pending",
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
      console.error("[ERROR] initDeposit internal failure:", err);
      throw new Error(`Deposit service error: ${err.message}`);
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

    console.log(`[DB TEST] Processing txId: ${txId} for userId: ${userId}`);

    await client.query(SQL.markTxCompletedById, [providerRef, "CHAPA", txId]);
    console.log(`[DB TEST] Transaction ${txId} marked as COMPLETED.`);

    await client.query(SQL.applyExistingTx, [providerRef]); // providerRef == tx_id
    console.log(`[DB TEST] Balance applied to userId: ${userId} via providerRef: ${providerRef}`);

    // 4) Fetch wallet by userId (you need userId for this query)
    const walletRes = await client.query(SQL.getWalletByUserId, [userId]);
    const finalBalance = walletRes.rows[0]?.available_balance;
    console.log(`[DB TEST] Final Available Balance for userId ${userId}: ${finalBalance}`);

    return { txId: txId, wallet: walletRes.rows[0] };
  });
}



// ----------- Prize / Won money (available + withdrawable) -----------
async function creditPrize({ userId, amount, meta }) {
  console.warn('prize called')
  const sourceRef = (meta && meta.sourceRef) || crypto.randomUUID();
  const idem = makeIdempotencyKey("PRIZE", userId, sourceRef);

  console.log(userId, amount)
  return withTx(async (client) => {
    try {

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

  const amountEtb = Math.round(Number(amount));

  // STEP 1: Reserve funds in DB (committed immediately, separate from Chapa)
  const { reserveTxId, withdrawRequest, wallet } = await withTx(async (client) => {
    await client.query(SQL.ensureWallet, [userId]);

    const txRes = await client.query(SQL.applyTx, [
      userId,
      "withdraw_request",
      amountEtb,
      "success",
      idem,
      null,
      null,
      { payoutMethod, payoutDestination },
    ]);

    const reserveTxId = txRes.rows[0].tx_id;

    const reqRes = await client.query(SQL.createWithdrawRequest, [
      userId,
      amountEtb,
      payoutMethod,
      payoutDestination,
      reserveTxId,
    ]);

    const walletRes = await client.query(SQL.getWallet, [userId]);
    return { reserveTxId, withdrawRequest: reqRes.rows[0], wallet: walletRes.rows[0] };
  });

  // STEP 2: Attempt Chapa payout OUTSIDE the DB transaction
  // If Chapa fails, the withdrawal is still recorded as pending for admin manual processing
  let chapaStatus = 'pending_manual';
  let checkout_url = null;
  try {
    const chapaRes = await initChapaPayout(
      reserveTxId,          // tx_ref (UUID)
      amountEtb,            // amount in ETB
      payoutDestination,    // account_number (phone)
      payoutMethod,         // bank code
      "xoet user",          // account_name
      undefined             // use default CHAPA.secret from env
    );
    chapaStatus = 'submitted';
    // If Chapa returns a checkout URL (for some payout methods)
    if (chapaRes?.data?.checkout_url) {
      checkout_url = chapaRes.data.checkout_url;
    }
  } catch (chapaErr) {
    // Log for admin review — do NOT throw, the DB state is still committed
    console.error('[WITHDRAW] Chapa payout failed — marked as pending_manual for admin:', chapaErr?.response || chapaErr?.message);
  }

  return { withdrawRequest, wallet, chapaStatus, checkout_url };
}
  } catch (chapaErr) {
    // Log for admin review — do NOT throw, the DB state is still committed
    console.error('[WITHDRAW] Chapa payout failed — marked as pending_manual for admin:', chapaErr?.response || chapaErr?.message);
  }

  return { withdrawRequest, wallet, chapaStatus, checkout_url };
}

  return { withdrawRequest, wallet, chapaStatus };
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
