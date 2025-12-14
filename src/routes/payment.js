// payments.routes.js
const express = require('express');
const { randomUUID } = require('crypto');
const { withTx, pool } = require('../db/index');
const { METHODS, LIMITS, CHAPA, toCents } = require('../env');
const { auth } = require('../middleware/Auth');
const { initDeposit, initPayout, verifyTx } = require('../models/Chapa');

const router = express.Router();

// Utility: assert bank enabled
function assertBankEnabled(bank) {
  if (!['TELEBIRR_USSD','CBE_BIRR','WEB_CHECKOUT'].includes(bank)) {
    const e = new Error('Unsupported bank'); e.status = 400; throw e;
  }
  if (!METHODS[bank]) {
    const e = new Error(`${bank} is disabled`); e.status = 400; throw e;
  }
}

function assertAmountForDeposit(amountCents) {
  if (amountCents < LIMITS.minDeposit || amountCents > LIMITS.maxDeposit) {
    const e = new Error('Amount out of deposit limits'); e.status = 400; throw e;
  }
}
function assertAmountForPayout(amountCents) {
    console.log(LIMITS)
  if (amountCents < LIMITS.minPayout || amountCents > LIMITS.maxPayout) {
    const e = new Error('Amount out of payout limits'); e.status = 400; throw e;
  }
}

// Ensure wallet exists
async function ensureWallet(client, userId) {
  await client.query(
    `INSERT INTO wallets (user_id) VALUES ($1)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId]
  );
}

// 1) DEPOSIT
router.post('/deposit', auth, async (req, res) => {
  try {
    const { amount, bank } = req.body || {};
    if (!amount || !bank) return res.status(400).json({ error: 'amount and bank are required' });
    assertBankEnabled(bank);
    const amountCents = toCents(amount);
    console.log(amountCents, amount)
    assertAmountForDeposit(amountCents);

    const userId = req.user.id;
    console.log(req.user)
    console.log("userid: ", userId)
    const tx_ref = `dep_${randomUUID()}`;

    const row = await withTx(async (client) => {
      await ensureWallet(client, userId);

      // Insert txn as PENDING
      const { rows } = await client.query(
        `INSERT INTO payment_transactions
           (id, user_id, type, status, amount, bank, tx_ref, provider_payload)
         VALUES ($1,$2,'deposit','pending',$3,$4,$5,$6)
         RETURNING *`,
        [randomUUID(), userId, amountCents, bank, tx_ref, { requested_amount: amountCents, bank }]
      );
      return rows[0];
    });

    // Call Chapa initialize (outside tx)
    const providerResp = await initDeposit({
      tx_ref,
      amountCents,
      bank,
      mobile: req.user.phone_number,
      callback_url: CHAPA.callbackUrl,
      secretKey: CHAPA.secret,
    }).catch(err => {
      // Update txn -> failed
      return withTx(async (client) => {
        await client.query(
          `UPDATE payment_transactions
           SET status='failed', provider_response=$2, updated_at=now()
           WHERE tx_ref=$1`,
          [tx_ref, err.response || { message: err.message }]
        );
        throw err;
      });
    });

    // Save provider response
    await pool.query(
      `UPDATE payment_transactions
       SET provider_response=$2, updated_at=now()
       WHERE tx_ref=$1`,
      [tx_ref, providerResp]
    );

    // Return pending + any checkout link/instructions
    return res.status(201).json({
      status: 'pending',
      tx_ref,
      bank,
      amount: Number(amount),
      provider: providerResp, // often contains checkout_url or USSD instructions
    });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message || 'Deposit failed' });
  }
});

// 2) WITHDRAW
router.post('/withdraw', auth, async (req, res) => {
  try {
    const { amount, bank } = req.body || {};
    if (!amount || !bank) return res.status(400).json({ error: 'amount and bank are required' });
    assertBankEnabled(bank);
    console.log(amount)
    const amountCents = amount
    assertAmountForPayout(amountCents);
    console.log(amountCents)
    const account_number = req.user.phone_number
    const account_name = req.body?.account_name || `user`;
    const userId = req.user.id;
    console.log("userid: ", userId)

    const tx_ref = `wd_${randomUUID().split('-')[0]}`; 

    // Reserve funds atomically (race-proof)
    const txn = await withTx(async (client) => {
      await ensureWallet(client, userId);

      // Lock wallet row
      const { rows: wrows } = await client.query(
        `SELECT * FROM wallets WHERE user_id=$1 FOR UPDATE`,
        [userId]
      );
      if (!wrows.length) throw new Error('Wallet missing');
      const w = wrows[0];

      if (Number(w.withdrawable_balance) < amountCents) {
        console.log(w)
        const e = new Error('Insufficient withdrawable balance'); e.status = 400; throw e;
      }

      await client.query(
        `UPDATE wallets
         SET available_balance = available_balance - $2, withdrawable_balance = withdrawable_balance - $2, updated_at=now()
         WHERE user_id=$1`,
        [userId, amountCents]
      );

      // Create txn in PROCESSING (funds reserved)
      const { rows: trows } = await client.query(
        `INSERT INTO payment_transactions
           (id, user_id, type, status, amount, bank, tx_ref, provider_payload)
         VALUES ($1,$2,'withdrawal','processing',$3,$4,$5,$6)
         RETURNING *`,
        [randomUUID(), userId, amountCents, bank, tx_ref, { account_name, account_number }]
      );
      return trows[0];
    });

    // Call Chapa payouts (outside db tx)
    const providerResp = await initPayout({
      tx_ref,
      amountCents,
      bank,
      account_name,
      account_number,
      secretKey: CHAPA.secret,
    }).catch(async (err) => {
      // Provider failed — refund atomically
      await withTx(async (client) => {
        const { rows: trows } = await client.query(
          `SELECT * FROM payment_transactions WHERE tx_ref=$1 FOR UPDATE`,
          [tx_ref]
        );
        const t = trows[0];
        if (t && t.status !== 'failed' && t.type === 'withdrawal') {
          // Lock wallet and refund
          const { rows: wrows } = await client.query(
            `SELECT * FROM wallets WHERE user_id=$1 FOR UPDATE`,
            [t.user_id]
          );
          const w = wrows[0];
          await client.query(
            `UPDATE wallets
             SET available_balance=$2, withdrawable_balance=$3, updated_at=now()
             WHERE user_id=$1`,
            [t.user_id, Number(w.available_balance) + t.amount, Number(w.withdrawable_balance) + t.amount]
          );
          await client.query(
            `UPDATE payment_transactions
             SET status='failed', provider_response=$2, updated_at=now()
             WHERE tx_ref=$1`,
            [tx_ref, err.response || { message: err.message }]
          );
        }
      });
      throw err;
    });

    // Save provider response; status remains 'processing' until webhook verifies
    await pool.query(
      `UPDATE payment_transactions
       SET provider_response=$2, updated_at=now()
       WHERE tx_ref=$1`,
      [tx_ref, providerResp]
    );

    return res.status(201).json({
      status: 'processing',
      tx_ref,
      bank,
      amount: Number(amount),
      provider: providerResp,
    });
  } catch (err) {
    console.log(err)
    return res.status(err.status || 500).json({ error: err.message || 'Withdraw failed' });
  }
});

// 3) WEBHOOK (Chapa -> we finalize here)
// IMPORTANT: add an express.json({ type: '*/*' }) body parser in your server entry.
router.post('/webhook', async (req, res) => {
  try {
    const payload = req.body || {};
    // We rely on server-side verification with Chapa (best practice).
    // Expect the webhook to include tx_ref
    const tx_ref = payload?.tx_ref || payload?.reference || payload?.data?.tx_ref;
    if (!tx_ref) return res.status(400).json({ error: 'tx_ref missing' });
    if (payload?.mode != 'live') return res.status(200).json({ error: true });

    // Pull our txn and lock it
    await withTx(async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM payment_transactions WHERE tx_ref=$1 FOR UPDATE`,
        [tx_ref]
      );
      if (!rows.length) throw Object.assign(new Error('Unknown tx_ref'), { status: 404 });

      const t = rows[0];

      // Already terminal?
      if (t.status === 'success' || t.status === 'failed') {
        // Idempotent ack
        await client.query(
          `UPDATE payment_transactions SET provider_response=$2, updated_at=now() WHERE tx_ref=$1`,
          [tx_ref, payload]
        );
        return;
      }

      // Verify with Chapa (source of truth)
      const verify = await verifyTx(tx_ref, CHAPA.secret);

      // Derive status
      const providerStatus =
        verify?.data?.status || verify?.status || payload?.status || payload?.data?.status || 'failed';
      const ok = String(providerStatus).toLowerCase() === 'success';

      // Apply effects
      if (t.type === 'deposit') {
        if (ok) {
          // credit wallet
          const { rows: wrows } = await client.query(
            `SELECT * FROM wallets WHERE user_id=$1 FOR UPDATE`,
            [t.user_id]
          );
          const w = wrows[0];
          await client.query(
            `UPDATE wallets
             SET available_balance=$2, updated_at=now()
             WHERE user_id=$1`,
            [
              t.user_id,
              Number(w.available_balance) + Number(t.amount),
            ]
          );
          await client.query(
            `UPDATE payment_transactions
             SET status='success', provider_response=$2, provider_ref=$3, updated_at=now()
             WHERE tx_ref=$1`,
            [tx_ref, { verify, webhook: payload }, verify?.data?.reference || verify?.data?.id || null]
          );
        } else {
          await client.query(
            `UPDATE payment_transactions
             SET status='failed', provider_response=$2, updated_at=now()
             WHERE tx_ref=$1`,
            [tx_ref, { verify, webhook: payload }]
          );
        }
      } else if (t.type === 'withdrawal') {
        if (ok) {
          // funds already reserved earlier; just flip to success
          await client.query(
            `UPDATE payment_transactions
             SET status='success', provider_response=$2, provider_ref=$3, updated_at=now()
             WHERE tx_ref=$1`,
            [tx_ref, { verify, webhook: payload }, verify?.data?.reference || verify?.data?.id || null]
          );
        } else {
          // payout failed — refund reserved funds
          const { rows: wrows } = await client.query(
            `SELECT * FROM wallets WHERE user_id=$1 FOR UPDATE`,
            [t.user_id]
          );
          const w = wrows[0];
          await client.query(
            `UPDATE wallets
             SET available_balance=$2, withdrawable_balance=$3, updated_at=now()
             WHERE user_id=$1`,
            [
              t.user_id,
              Number(w.available_balance) + Number(t.amount),
              Number(w.withdrawable_balance) + Number(t.amount),
            ]
          );
          await client.query(
            `UPDATE payment_transactions
             SET status='failed', provider_response=$2, updated_at=now()
             WHERE tx_ref=$1`,
            [tx_ref, { verify, webhook: payload }]
          );
        }
      }
    });

    return res.json({ ok: true });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message || 'Webhook failed' });
  }
});

router.post('/withdrawal/approve', async (req, res) => {
  // Placeholder for admin approval logic
  console.log('Approve withdrawal endpoint hit');
  return res.status(200).json({ status: 'Not implemented' });
});

module.exports = router;
