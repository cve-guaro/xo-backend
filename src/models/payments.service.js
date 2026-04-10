const crypto = require("crypto");
const { withTx } = require("../db/index.js");
const { SQL } = require("./payments.sql.js");
const { initChapaDeposit, initChapaPayout } = require("./Chapa.js");
const { CHAPA } = require("../env.js");

function hash20(s) {
  return crypto.createHash("sha256").update(String(s)).digest("hex").slice(0, 20);
}

function makeIdempotencyKey(prefix, userId, anchor) {
  // same input -> same key (good for webhooks)
  return `${prefix}:${userId}:${hash20(`${userId}:${anchor}`)}`;
}

// ----------- Deposit (init) -----------
// payments.service.js
async function initDeposit({ userId, phoneNumber, amount, provider, username, email, returnUrl, isWeb }) {
  return withTx(async (client) => {
    try {
      await client.query(SQL.ensureWallet, [userId]);

      const amountEtb = Math.round(Number(amount));

      // PENDING deposit, no idempotency needed here
      const { rows } = await client.query(SQL.applyTx, [
        userId,
        "DEPOSIT",
        amountEtb,
        "PENDING",
        crypto.randomUUID(), // internal only
        "CHAPA",
        null,
        { isWeb },
      ]);

      const paymentData = rows[0];
      const callbackUrl = CHAPA.callbackUrl || 'https://xo-et-backend-production.up.railway.app/payments/webhook';

      const deposit = await initChapaDeposit(
        paymentData.tx_id,
        amount,
        phoneNumber,
        provider,
        callbackUrl,
        '', // use default secret from env
        { id: userId, username, email },
        returnUrl
      );

      const url = (deposit && deposit.data && deposit.data.checkout_url) || null;

      return { txId: rows[0].tx_id, checkout_url: url };
    } catch (err) {
      // Surface Chapa's actual error message for easier debugging
      const chapaMsg = err.response?.message || err.response?.data?.message || err.message;
      console.error("[ERROR] initDeposit failure:", chapaMsg, err.response || '');
      const errorInfo = new Error(`Deposit service error: ${chapaMsg}`);
      errorInfo.status = 400;
      throw errorInfo;
    }
  });
}


// ----------- Deposit (complete via webhook) -----------
// payments.service.js
async function completeDeposit(providerRef, provider) {
  return withTx(async (client) => {
    // 1) Find the deposit tx row using providerRef (which is our tx_id sent to Chapa)
    const found = await client.query(SQL.findDepositTxByProviderRef, [provider, providerRef]);
    const txRow = found.rows[0];

    if (!txRow) {
      // This means you never created a DEPOSIT tx row with tx_id = providerRef
      throw new Error(`Deposit tx not found for providerRef=${providerRef}`);
    }

    const txId = txRow.id; // internal UUID primary key
    const userId = txRow.user_id;
    const txRef = txRow.tx_id; // the UUID we sent to Chapa

    console.log(`[WEBHOOK] Processing txId: ${txId} for userId: ${userId} (tx_ref: ${txRef})`);

    // 2. Mark the transaction as COMPLETED
    await client.query(SQL.markTxCompletedById, [txId, provider]);
    console.log(`[WEBHOOK] Transaction ${txId} marked as COMPLETED.`);

    // 3. Apply the balance using the tx_id (UUID we sent Chapa, used as idempotency key in fn)
    // fn_wallet_apply_existing_tx uses tx_id to credit the wallet
    await client.query(SQL.applyExistingTx, [txRef || txId]);
    console.log(`[WEBHOOK] Balance applied to userId: ${userId} via txRef: ${txRef || txId}`);

    // 4) Fetch wallet by userId
    const walletRes = await client.query(SQL.getWalletByUserId, [userId]);
    const finalBalance = walletRes.rows[0]?.available_balance;
    console.log(`[WEBHOOK] Final Available Balance for userId ${userId}: ${finalBalance}`);

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
  const amountEtb = Math.round(Number(amount));
  
  // Validation
  if (!amountEtb || amountEtb < 10) {
    const err = new Error("Minimum withdrawal is 10 ETB");
    err.status = 400;
    throw err;
  }
  if (!payoutMethod || !payoutDestination) {
    const err = new Error("Payout method and destination (phone) are required");
    err.status = 400;
    throw err;
  }

  const anchor = `${payoutMethod}:${payoutDestination}:${amountEtb}:${Date.now()}`;
  const idem = makeIdempotencyKey("WREQ", userId, anchor);

    // STEP 1: Reserve funds in DB (committed immediately, separate from Chapa)
  const { reserveTxId, withdrawRequest, wallet } = await withTx(async (client) => {
    await client.query(SQL.ensureWallet, [userId]);
    
    // 1) Verify user has played at least one match
    const { rows: gameCountRows } = await client.query(
      `SELECT COUNT(*) AS total FROM games WHERE player_x = $1 OR player_o = $1`, 
      [userId]
    );
    const totalGames = Number(gameCountRows[0]?.total || 0);

    if (totalGames === 0) {
      const err = new Error("You must play at least one match before withdrawing funds.");
      err.status = 400;
      throw err;
    }

    // 2) Check balance - must exclude the 10 ETB bonus
    const walletCheck = await client.query(SQL.getWallet, [userId]);
    const walletData = walletCheck.rows[0];
    const available = Number(walletData?.available_balance || 0);
    
    // The user can withdraw (Available - 10 Bonus)
    const currentWithdrawable = Math.max(0, available - 10);
    
    if (currentWithdrawable < amountEtb) {
      const err = new Error("Insufficient withdrawable balance (Registration bonus is not withdrawable).");
      err.status = 400;
      throw err;
    }

    const txRes = await client.query(SQL.applyTx, [
      userId,
      "WITHDRAW_REQUEST",
      amountEtb,
      "COMPLETED", // Immediately complete so the balance cuts instantly
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
  const cleanDestination = String(payoutDestination).replace(/\D/g, "");
  const finalDestination = cleanDestination.length >= 7 ? cleanDestination : "251900000000";

  try {
    const chapaRes = await initChapaPayout(
      reserveTxId,          // tx_ref (UUID)
      amountEtb,            // amount in ETB
      finalDestination,     // account_number (phone/account)
      payoutMethod,         // bank key (e.g. TELEBIRR, CBE_BIRR)
      "XO ET User",         // account_name
      undefined             // use default CHAPA.secret from env
    );
    chapaStatus = 'submitted';
    if (chapaRes?.data?.checkout_url) {
      checkout_url = chapaRes.data.checkout_url;
    }
  } catch (chapaErr) {
    const chapaMsg = String(chapaErr?.response?.message || chapaErr?.message || '');
    console.error('[WITHDRAW] Chapa payout failed — marked as pending_manual for admin:', chapaErr?.response || chapaErr?.message);
    
    // Surface critical Chapa errors back to user
    if (chapaMsg.toLowerCase().includes('insufficient') || chapaMsg.toLowerCase().includes('balance')) {
      const e = new Error('CHAPA_INSUFFICIENT_BALANCE');
      e.status = 503;
      throw e;
    }
    if (chapaMsg.toLowerCase().includes('invalid account') || chapaMsg.toLowerCase().includes('account not found')) {
      const e = new Error('CHAPA_INVALID_ACCOUNT');
      e.status = 422;
      throw e;
    }
    // Non-critical: log but continue — DB committed, admin manually processes
    chapaStatus = 'pending_manual';
  }

  return { withdrawRequest, wallet, chapaStatus, checkout_url };
}

module.exports = {
  initDeposit,
  completeDeposit,
  creditPrize,
  requestWithdraw,
  // exporting helpers is optional; remove if you don't want them public
  makeIdempotencyKey,
  hash20,
};
