// src/services/spinWalletService.js
// ────────────────────────────────────────────────────────────────────────────
// Centralized wallet service for ALL Spin-related balance changes.
// This is the ONLY code path allowed to write to wallet balance columns for Spin.
// Matches the existing XO Game debit/credit patterns in socket/game.js exactly.
// ────────────────────────────────────────────────────────────────────────────
const crypto = require("crypto");
const { pool, withTx } = require("../db/index");

const LOG_PREFIX = "[SPIN_WALLET]";

// ── Idempotency key builder ────────────────────────────────────────────────
function hash20(s) {
  return crypto.createHash("sha256").update(String(s)).digest("hex").slice(0, 20);
}

function makeIdemKey(prefix, userId, anchor) {
  return `spin:${prefix}:${userId}:${hash20(`${userId}:${anchor}`)}`;
}

// ── DEBIT (wager entry) ────────────────────────────────────────────────────
// Deducts betAmount from player's wallet using bonus-first logic.
// Mirrors the exact deduction pattern from game.js lockAndStartMatch.
//
// Returns: { bonusUsed, realUsed }
// Throws on insufficient balance.
//
// IMPORTANT: `client` must be a pg Client inside an active transaction.
// This function does NOT manage its own transaction — the caller (spinRoom.js)
// wraps all seat debits in a single transaction.
async function debitWager(client, { userId, amount, roundId, isBot = false }) {
  if (isBot) {
    // Bots have no real wallet. Log-only, no DB write.
    console.log(`${LOG_PREFIX} Bot debit skipped: user=${userId} amount=${amount} round=${roundId}`);
    return { bonusUsed: 0, realUsed: 0 };
  }

  const betAmount = Number(amount);
  if (!betAmount || betAmount <= 0) throw new Error("INVALID_AMOUNT");

  // 1) Lock wallet row + fetch balances
  const walletRes = await client.query(
    `SELECT user_id, available_balance, bonus_balance, withdrawable_balance
     FROM wallets
     WHERE user_id = $1::uuid
     FOR UPDATE`,
    [userId]
  );

  if (walletRes.rowCount === 0) throw new Error("WALLET_NOT_FOUND");

  const wallet = walletRes.rows[0];
  const avail = Number(wallet.available_balance);
  const bonus = Number(wallet.bonus_balance);

  // 2) Check total effective balance
  if ((avail + bonus) < betAmount) {
    throw new Error("INSUFFICIENT_BALANCE");
  }

  // 3) Bonus-first deduction (same logic as XO Game)
  const bonusToUse = Math.min(bonus, betAmount);
  const realToUse = betAmount - bonusToUse;

  // 4) Apply deduction
  await client.query(
    `UPDATE wallets
     SET available_balance    = GREATEST(available_balance  - $1, 0),
         bonus_balance        = GREATEST(bonus_balance - $2, 0),
         withdrawable_balance = GREATEST(withdrawable_balance - $3, 0),
         updated_at           = now()
     WHERE user_id = $4`,
    [betAmount, bonusToUse, realToUse, userId]
  );

  console.log(`${LOG_PREFIX} Debit: user=${userId} bet=${betAmount} bonus=${bonusToUse} real=${realToUse} round=${roundId}`);

  return { bonusUsed: bonusToUse, realUsed: realToUse };
}

// ── CREDIT (winnings payout) ───────────────────────────────────────────────
// Credits winnings to the winner's wallet.
// Mirrors the finishAndPayout pattern from game.js:
//   - available_balance += prizeAmount
//   - bonus_balance += bonusUsed (return the bonus portion)
//   - withdrawable_balance += (prizeAmount - bonusUsed) (only real cash portion)
//
// Also inserts a ledger record in payment_transactions for audit trail.
async function creditWinnings({ userId, prizeAmount, bonusUsed, roundId, isBot = false }) {
  if (isBot) {
    // Bot won — house keeps the money. No real payout.
    console.log(`${LOG_PREFIX} Bot win — house keeps prize: user=${userId} prize=${prizeAmount} round=${roundId}`);
    return { txId: null, wallet: null };
  }

  const prize = Number(prizeAmount);
  const bonusReturn = Number(bonusUsed || 0);
  const prizeWithdrawable = Math.max(0, prize - bonusReturn);

  return withTx(async (client) => {
    // 1) Credit wallet
    await client.query(
      `UPDATE wallets
       SET available_balance    = available_balance + $1,
           bonus_balance        = bonus_balance + $2,
           withdrawable_balance = withdrawable_balance + $3,
           updated_at           = NOW()
       WHERE user_id = $4`,
      [prize, bonusReturn, prizeWithdrawable, userId]
    );

    // 2) Fetch updated wallet
    const walletRes = await client.query(
      `SELECT user_id, available_balance, withdrawable_balance
       FROM wallets WHERE user_id = $1::uuid`,
      [userId]
    );

    // 3) Ledger record (payment_transactions) — same pattern as XO Game
    const txRef = `spin-${roundId}-${Date.now()}`;
    await client.query(
      `INSERT INTO payment_transactions (id, user_id, type, status, amount, bank, tx_ref, provider_payload)
       VALUES (gen_random_uuid(), $1, 'deposit', 'success', $2, 'SPIN_PRIZE', $3, $4::jsonb)`,
      [userId, prize, txRef, JSON.stringify({ roundId, game_type: 'SPIN', bonusUsed: bonusReturn })]
    );

    console.log(`${LOG_PREFIX} Credit: user=${userId} prize=${prize} withdrawable=${prizeWithdrawable} round=${roundId}`);

    return { txId: txRef, wallet: walletRes.rows[0] };
  });
}

// ── REFUND (room cancelled / not enough players) ───────────────────────────
// Returns the full wager to the player's wallet.
// Used when a room fails to fill and gets cancelled.
async function refundWager({ userId, amount, bonusUsed, roundId, isBot = false }) {
  if (isBot) {
    console.log(`${LOG_PREFIX} Bot refund skipped: user=${userId} round=${roundId}`);
    return;
  }

  const betAmount = Number(amount);
  const bonusReturn = Number(bonusUsed || 0);
  const realReturn = betAmount - bonusReturn;

  return withTx(async (client) => {
    // Reverse the deduction exactly
    await client.query(
      `UPDATE wallets
       SET available_balance    = available_balance + $1,
           bonus_balance        = bonus_balance + $2,
           withdrawable_balance = withdrawable_balance + $3,
           updated_at           = NOW()
       WHERE user_id = $4`,
      [betAmount, bonusReturn, realReturn, userId]
    );

    // Ledger record for the refund
    const txRef = `spin-refund-${roundId}-${Date.now()}`;
    await client.query(
      `INSERT INTO payment_transactions (id, user_id, type, status, amount, bank, tx_ref, provider_payload)
       VALUES (gen_random_uuid(), $1, 'deposit', 'success', $2, 'SPIN_REFUND', $3, $4::jsonb)`,
      [userId, betAmount, txRef, JSON.stringify({ roundId, game_type: 'SPIN', refund: true })]
    );

    console.log(`${LOG_PREFIX} Refund: user=${userId} amount=${betAmount} bonus=${bonusReturn} real=${realReturn} round=${roundId}`);
  });
}

// ── Calculate prize from pot ───────────────────────────────────────────────
// Takes the total pot and house cut percentage, returns the winner's prize.
function calculateSpinPrize(potAmount, houseCutPercent) {
  const pot = Number(potAmount);
  const cut = Math.max(0, Math.min(100, Number(houseCutPercent)));
  const prize = Math.floor(pot * (1 - cut / 100));
  return { prize, pot, houseCut: pot - prize, houseCutPercent: cut };
}

module.exports = {
  debitWager,
  creditWinnings,
  refundWager,
  calculateSpinPrize,
};
