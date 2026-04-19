const crypto = require("crypto");
const { pool, withTx } = require("../db/index.js");
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
async function completeDeposit(txIdOrRef, provider, realReference = null) {
  return withTx(async (client) => {
    // 1) Find the deposit tx row using txIdOrRef (which is our internal UUID sent to Chapa as tx_ref)
    const found = await client.query(SQL.findDepositTxByProviderRef, [provider, txIdOrRef]);
    const txRow = found.rows[0];

    if (!txRow) {
      throw new Error(`Deposit tx not found for providerRef=${txIdOrRef}`);
    }

    const txId = txRow.id; // internal UUID primary key
    const userId = txRow.user_id;
    const txRef = txRow.tx_id; // the UUID we sent to Chapa
    const currentStatus = txRow.status;

    // IDEMPOTENCY: If already completed, don't throw, just return success
    if (currentStatus === 'COMPLETED' || currentStatus === 'success') {
      console.log(`[WEBHOOK] Idempotency triggered: Transaction ${txId} already COMPLETED.`);
      const walletRes = await client.query(SQL.getWalletByUserId, [userId]);
      return { txId: txId, wallet: walletRes.rows[0], alreadyCompleted: true };
    }

    console.log(`[WEBHOOK] Processing txId: ${txId} for userId: ${userId} (tx_ref: ${txRef}) | New Ref: ${realReference || 'N/A'}`);

    // 2. Mark the transaction as COMPLETED & Store the REAL provider reference
    // We use realReference if provided, otherwise fallback to provider (e.g. 'CHAPA') which is old behaviour
    const referenceToStore = realReference || provider; 
    await client.query(SQL.markTxCompletedById, [txId, referenceToStore, null]);
    console.log(`[WEBHOOK] Transaction ${txId} marked as COMPLETED with ref: ${referenceToStore}`);

    // 3. Apply the balance using the tx_id (UUID we sent Chapa, used as idempotency key in fn)
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
  const { reserveTxId, withdrawRequest, wallet, requiresManualReview, reviewReason } = await withTx(async (client) => {
    await client.query(SQL.ensureWallet, [userId]);
    
    // 1) Verify user has played at least one match
    const { rows: gameCountRows } = await client.query(
      `SELECT COUNT(*) AS total FROM games WHERE player_x = $1 OR player_o = $1`, 
      [userId]
    );
    const totalGames = Number(gameCountRows[0]?.total || 0);

    if (totalGames === 0) {
      const err = new Error("You need to play at least one game to enable withdraw");
      err.status = 400;
      throw err;
    }

    // 2) Check balance — ONLY withdrawable_balance counts (bonus is NOT withdrawable)
    const walletCheck = await client.query(SQL.getWallet, [userId]);
    const walletData = walletCheck.rows[0];
    const withdrawable = Number(walletData?.withdrawable_balance || 0);
    
    if (withdrawable < amountEtb) {
      const err = new Error("Insufficient withdrawable balance.");
      err.status = 400;
      throw err;
    }

    // AML & Security Rules — only the auto-payout threshold matters
    const settingsRes = await client.query(`SELECT key, value FROM global_settings WHERE key IN ('is_manual_approval_enabled', 'auto_payout_threshold')`);
    let manualApproval = false;
    let autoPayoutLimit = 2000;
    
    settingsRes.rows.forEach(r => {
      if (r.key === 'is_manual_approval_enabled') manualApproval = (r.value === true || r.value === 'true');
      if (r.key === 'auto_payout_threshold') autoPayoutLimit = Number(r.value);
    });

    let requiresManualReview = false;
    let reviewReason = [];

    if (manualApproval && amountEtb > autoPayoutLimit) {
      requiresManualReview = true;
      reviewReason.push(`Exceeds auto-payout limit (${amountEtb} > ${autoPayoutLimit})`);
    }

    const initialStatus = requiresManualReview ? "PENDING_MANUAL" : "PENDING";

    const txRes = await client.query(SQL.applyTx, [
      userId,
      "WITHDRAW_REQUEST",
      amountEtb,
      initialStatus,
      idem,
      null,
      null,
      { payoutMethod, payoutDestination, reviewReason: reviewReason.join(' | ') },
    ]);

    const reserveTxId = txRes.rows[0].tx_id;

    // IMMEDIATELY reserve/lock funds — deduct from available AND withdrawable (no bonus touched)
    await client.query(`
      UPDATE wallets 
      SET available_balance = available_balance - $1, 
          withdrawable_balance = withdrawable_balance - $1
      WHERE user_id = $2
    `, [amountEtb, userId]);

    await client.query(`UPDATE wallet_transactions SET applied_at = now() WHERE id = $1`, [reserveTxId]);

    const reqRes = await client.query(SQL.createWithdrawRequest, [
      userId,
      amountEtb,
      payoutMethod,
      payoutDestination,
      reserveTxId,
    ]);

    const walletRes = await client.query(SQL.getWallet, [userId]);
    return { reserveTxId, withdrawRequest: reqRes.rows[0], wallet: walletRes.rows[0], requiresManualReview, reviewReason };
  });

  // STEP 2: Attempt Chapa payout OUTSIDE the DB transaction
  if (requiresManualReview) {
    console.log(`[WITHDRAW] Marked PENDING_MANUAL for ${userId}. Reasons: ${reviewReason.join(', ')}`);
    return { withdrawRequest, wallet, chapaStatus: 'pending_manual', checkout_url: null, reviewReason };
  }

  let chapaStatus = 'pending_manual';
  let checkout_url = null;
  const cleanDestination = String(payoutDestination).replace(/\D/g, "");
  
  // Auto-format Ethiopian phone numbers (09xx → 2519xx, 07xx → 2517xx)
  let formattedDestination = cleanDestination;
  if (formattedDestination.startsWith("09") && formattedDestination.length === 10) {
    formattedDestination = "2519" + formattedDestination.slice(2);
  } else if (formattedDestination.startsWith("07") && formattedDestination.length === 10) {
    formattedDestination = "2517" + formattedDestination.slice(2);
  }
  const finalDestination = formattedDestination.length >= 7 ? formattedDestination : "251900000000";

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

    // If Chapa synchronously accepts and completes the transfer right away, mark it COMPLETED!
    if (chapaRes?.status === 'success') {
      await pool.query(
        `UPDATE wallet_transactions SET status = 'COMPLETED', updated_at = now() WHERE id = $1`,
        [reserveTxId]
      );
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

// ----------- Giveaway / Promo Code Redemption -----------
async function redeemPromoCode({ userId, code }) {
  const cleanCode = String(code).toUpperCase().trim();
  
  try {
    return await withTx(async (client) => {
      // 1) Find active giveaway by promo code
      const giveawayRes = await client.query(`
        SELECT * FROM giveaways 
        WHERE UPPER(promo_code) = $1 
          AND status = 'ACTIVE' 
          AND type = 'PROMOCODE'
          AND (starts_at IS NULL OR starts_at <= now())
          AND (ends_at IS NULL OR ends_at >= now())
        FOR UPDATE
      `, [cleanCode]);
      
      const giveaway = giveawayRes.rows[0];
      if (!giveaway) throw new Error("INVALID_CODE");

      // 2) Check if user already used it
      const usageRes = await client.query(`SELECT 1 FROM giveaway_claims WHERE giveaway_id = $1 AND user_id = $2`, [giveaway.id, userId]);
      if (usageRes.rowCount > 0) throw new Error("ALREADY_REDEEMED");

      // 3) Targeted checks from metadata
      const meta = giveaway.metadata || {};
      if (meta.target === 'NEW_USER') {
        const { rows } = await client.query(`SELECT COUNT(*) AS total FROM games WHERE player_x = $1 OR player_o = $1`, [userId]);
        if (Number(rows[0].total) > 0) throw new Error("ONLY_FOR_NEW_USERS");
      }

      // 4) Apply balance to BONUS_BALANCE (requested for giveaways)
      const amount = Number(giveaway.amount);
      const idem = makeIdempotencyKey("GIVEAWAY", userId, giveaway.id);
      
      await client.query(SQL.applyTx, [
        userId,
        "PRIZE",
        amount,
        "COMPLETED",
        idem,
        "GIVEAWAY",
        giveaway.title || `Promocode: ${cleanCode}`,
        { giveawayId: giveaway.id, code: cleanCode }
      ]);

      // Use bonus_balance update logic (ensure it hits the bonus field)
      await client.query(`
        UPDATE wallets 
        SET bonus_balance = bonus_balance + $1,
            updated_at = now()
        WHERE user_id = $2
      `, [amount, userId]);

      // 5) Update claim log
      await client.query(`INSERT INTO giveaway_claims (giveaway_id, user_id, amount) VALUES ($1, $2, $3)`, [giveaway.id, userId, amount]);

      // 6) Add to bonus_logs for the frontend tracking list
      await client.query(`
        INSERT INTO bonus_logs (user_id, amount, reason)
        VALUES ($1, $2, $3)
      `, [userId, amount, giveaway.title || `Promocode: ${cleanCode}`]);

      return { amount, code: cleanCode, title: giveaway.title };
    });
  } catch (err) {
    // Let the route handler log specific errors as needed
    throw err;
  }
}

/**
 * Automatically applies active 'NEW_USER' giveaways to a user.
 * Usually called during or right after registration.
 */
async function applyNewUserGiveaways(userId) {
  return withTx(async (client) => {
    // Find all active NEW_USER giveaways
    const giveaways = await client.query(`
      SELECT * FROM giveaways 
      WHERE type = 'NEW_USER' 
        AND status = 'ACTIVE'
        AND (starts_at IS NULL OR starts_at <= now())
        AND (ends_at IS NULL OR ends_at >= now())
    `);

    for (const g of giveaways.rows) {
      try {
        // Check if already claimed
        const { rowCount } = await client.query(`SELECT 1 FROM giveaway_claims WHERE giveaway_id = $1 AND user_id = $2`, [g.id, userId]);
        if (rowCount > 0) continue;

        const amount = Number(g.amount);
        const idem = makeIdempotencyKey("GIVEAWAY_AUTO", userId, g.id);

        // Apply to balance
        await client.query(SQL.applyTx, [
          userId,
          "GIFT",
          amount,
          "COMPLETED",
          idem,
          "GIVEAWAY",
          g.title,
          { giveawayId: g.id, type: 'AUTO_NEW_USER' }
        ]);

        await client.query(`
          UPDATE wallets 
          SET bonus_balance = bonus_balance + $1,
              updated_at = now()
          WHERE user_id = $2
        `, [amount, userId]);

        await client.query(`INSERT INTO giveaway_claims (giveaway_id, user_id, amount) VALUES ($1, $2, $3)`, [g.id, userId, amount]);

        // Add to bonus_logs for tracking
        await client.query(`
          INSERT INTO bonus_logs (user_id, amount, reason)
          VALUES ($1, $2, $3)
        `, [userId, amount, g.title || 'New User Bonus']);

        console.log(`[GIVEAWAY] Auto-applied "${g.title}" (${amount} ETB) to user ${userId}`);
      } catch (err) {
        console.error(`[GIVEAWAY_AUTO_ERR] Failed to apply ${g.id} to ${userId}:`, err.message);
      }
    }
  });
}

module.exports = {
  initDeposit,
  completeDeposit,
  creditPrize,
  requestWithdraw,
  redeemPromoCode,
  applyNewUserGiveaways,
  // exporting helpers is optional; remove if you don't want them public
  makeIdempotencyKey,
  hash20,
};
