/**
 * stake.js — the single stake-deduction primitive.
 *
 * deductStake(client, { playerXId, playerOId, betAmount }) must be called inside
 * an OPEN transaction with a client. It:
 *   - locks BOTH wallet rows FOR UPDATE in that same transaction (so a concurrent
 *     withdrawal reservation — which also locks via fn_wallet_apply_tx —
 *     serializes against it and the balance check can never go stale),
 *   - applies the platform's bonus-first deduction,
 *   - computes and returns exactly which bucket each player's stake came from
 *     (bonus / withdrawable / locked deposit-only) so refunds can restore them.
 *
 * NOTE: this is the extraction of the inline block that used to live in
 * game.js's game-creation transaction, plus the SELECT fix it forced: the old
 * query never fetched wallets.withdrawable_balance, so the migration-011 split
 * recording read `undefined` → NaN → every game creation failed with 22P02.
 */
async function deductStake(client, { playerXId, playerOId, betAmount }) {
  const ids = [playerXId, playerOId];

  // Lock both wallet rows in a DETERMINISTIC order (sorted by user id) so two
  // concurrent games sharing the same player pair can never deadlock — the lock
  // order is global, not seat order. Rows are then already locked for the read.
  const sortedIds = [...ids].sort();
  for (const id of sortedIds) {
    await client.query(`SELECT user_id FROM wallets WHERE user_id = $1::uuid FOR UPDATE`, [id]);
  }

  // Lock both wallet rows and fetch everything the split needs (rows already locked)
  const walletRes = await client.query(
    `SELECT w.user_id, w.available_balance, w.bonus_balance, w.withdrawable_balance,
            u.r1_10_wins, u.r1_15_wins
     FROM wallets w
     JOIN users u ON w.user_id = u.id
     WHERE w.user_id = ANY($1::uuid[])`,
    [ids]
  );

  if (walletRes.rowCount !== 2) {
    // Diagnostic: this should be impossible while both users exist — log what the
    // locked read actually saw before failing loudly.
    console.error(`[deductStake] expected 2 wallet rows, got ${walletRes.rowCount} for ids ${JSON.stringify(ids)}: ${JSON.stringify(walletRes.rows)}`);
    throw new Error("INSUFFICIENT_BALANCE");
  }

  const result = {};
  for (const wallet of walletRes.rows) {
    const avail = Number(wallet.available_balance);
    const bonus = Number(wallet.bonus_balance);
    const wd = Number(wallet.withdrawable_balance);
    const userId = wallet.user_id;

    const bonusToUse = Math.min(bonus, betAmount);
    const realToUse = betAmount - bonusToUse;

    // Check TOTAL effective balance (available + bonus), not just available
    if ((avail + bonus) < betAmount) throw new Error("INSUFFICIENT_BALANCE");

    // Validate win locks (15-win cap for 10 and 15 Birr)
    if (betAmount === 10 && Number(wallet.r1_10_wins || 0) >= 15) {
      throw new Error("TIER_LOCKED");
    }
    if (betAmount === 15 && Number(wallet.r1_15_wins || 0) >= 15) {
      throw new Error("TIER_LOCKED");
    }

    // Bucket split, computed from the LOCKED row
    const wdUsed = Math.min(wd, realToUse);
    const lockedUsed = realToUse - wdUsed;

    // Unified deduction:
    // - available_balance always drops by the full betAmount
    // - bonus_balance drops by bonusToUse
    // - withdrawable_balance ONLY drops by the real cash portion (realToUse)
    await client.query(
      `UPDATE wallets
       SET available_balance    = GREATEST(available_balance  - $1, 0),
           bonus_balance        = GREATEST(bonus_balance - $2, 0),
           withdrawable_balance = GREATEST(withdrawable_balance - $3, 0),
           updated_at           = now()
       WHERE user_id = $4`,
      [betAmount, bonusToUse, realToUse, userId]
    );

    result[userId] = { bonusUsed: bonusToUse, wdUsed, lockedUsed };
  }

  return result;
}

module.exports = { deductStake };
