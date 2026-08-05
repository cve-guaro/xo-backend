const express = require('express');
const { pool } = require('../db/index'); // your Postgres client (pg.Pool)
const { auth } = require('../middleware/Auth.js');
const { validate, schemas } = require('../middleware/Validation.js');

const router = express.Router();

// PATCH /account/profile
router.patch(
  "/profile",
  auth,
  validate(schemas.updateProfile),
  async (req, res) => {
    try {
      const userId = req.user?.id || req.user?.sub || req.user?.userId;

      const { BOT_NAMES } = require('../socket/spinBot');

      // Zod has already validated and sanitized req.body
      const { username, display_name, avatar } = req.body;
      if (!username && !display_name && !avatar) {
        return res.status(400).json({ message: "No data provided" });
      }

      if (username && BOT_NAMES.map(n => n.toLowerCase()).includes(String(username).toLowerCase())) {
        return res.status(400).json({ message: "Username is already taken" });
      }

      // --- Build dynamic update ---
      const fields = [];
      const values = [];
      let idx = 1;

      if (username) {
        fields.push(`username = $${idx++}`);
        values.push(username);
      }
      if (display_name !== undefined) {
        fields.push(`display_name = $${idx++}`);
        values.push(display_name === '' ? null : display_name);
      }
      if (avatar !== undefined) {
        fields.push(`avatar = $${idx++}`);
        values.push(avatar);
      }

      values.push(userId); // final placeholder for WHERE

      const query = `
        UPDATE users
        SET ${fields.join(", ")}, updated_at = NOW()
        WHERE id = $${idx}
        RETURNING id, username, display_name, avatar;
      `;

      console.log("Executing query:", query, "with values:", values);
      const result = await pool.query(query, values);
      if (result.rowCount === 0) return res.status(404).json({ message: "User not found" });

      res.json({ ok: true, user: result.rows[0] });
    } catch (err) {
      if (err.code === '23505' && err.constraint === 'users_username_key') {
        return res.status(400).json({ message: "Username is already taken" });
      }
      console.error("Profile update error:", err);
      res.status(500).json({ message: "Server error" });
    }
  }
);

// PATCH /account/settings
router.patch("/settings", auth, async (req, res) => {
  try {
    const userId = req.user?.id || req.user?.sub || req.user?.userId;
    const { soundMuted } = req.body;
    
    if (soundMuted === undefined) return res.status(400).json({ message: "No settings provided" });

    const result = await pool.query(`UPDATE users SET sound_muted = $1 WHERE id = $2 RETURNING id, sound_muted`, [Boolean(soundMuted), userId]);
    
    if (result.rowCount === 0) return res.status(404).json({ message: "User not found" });
    res.json({ ok: true, settings: result.rows[0] });
  } catch (e) {
    console.error("Settings update error:", e);
    res.status(500).json({ message: "Server error" });
  }
});

router.post('/history', auth, async (req, res) => {
  try {
    const userId = req.user?.id || req.user?.sub || req.user?.userId;
    const limit = parseInt(req.body.limit, 10) || 50;

    // NOTE: is_winner is computed on the backend to avoid UUID comparison
    // issues on the client (type mismatch, casing, etc.)
    const query = `
      SELECT 
        g.id,
        g.bet_amount,
        g.winner,
        g.status,
        g.created_at,
        g.finished_at,
        g.moves,
        ARRAY[g.player_x::text, g.player_o::text] AS players,
        ux.username AS px_name,
        uo.username AS po_name,
        ux.number   AS px_num,
        uo.number   AS po_num,
        ux.created_at AS player_x_created_at,
        uo.created_at AS player_o_created_at,
        -- Server-side win/loss flag: avoids UUID comparison bugs in client
        CASE
          WHEN g.winner IS NULL THEN 'abandoned'
          WHEN g.winner::text = $1::text THEN 'win'
          ELSE 'loss'
        END AS result
      FROM games g
      LEFT JOIN users ux ON g.player_x = ux.id
      LEFT JOIN users uo ON g.player_o = uo.id
      WHERE g.player_x = $1::uuid OR g.player_o = $1::uuid
      ORDER BY g.created_at DESC
      LIMIT $2;
    `;
    const values = [userId, limit];

    const dbResult = await pool.query(query, values);
    const formattedHistory = dbResult.rows.map(row => ({
      ...row,
      bet_amount: Number(row.bet_amount),
      // Expose clean boolean for frontend
      is_winner: row.result === 'win',
      is_abandoned: row.result === 'abandoned',
    }));

    res.json({ ok: true, history: formattedHistory });
  } catch (err) {
    console.error("History retrieval error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// ─── GET /account/transactions ──────────────────────────────────────
// Returns unified financial activity: wallet deposits/withdrawals + game prize winnings
router.get('/transactions', auth, async (req, res) => {
  try {
    const userId = req.user.id;

    // Unified query: wallet_transactions (deposits, withdrawals, refunds, gifts)
    // UNION payment_transactions (XO match & Spin prizes)
    const result = await pool.query(`
      (
        SELECT
          id,
          tx_type::text AS tx_type,
          amount::numeric,
          status::text,
          provider::text AS bank,
          provider_ref::text AS tx_ref,
          meta::jsonb AS meta,
          created_at,
          CASE
            WHEN LOWER(tx_type::text) IN ('deposit')                              THEN 'deposit'
            WHEN LOWER(tx_type::text) IN ('withdraw_request', 'withdraw_settled') THEN 'withdrawal'
            WHEN LOWER(tx_type::text) IN ('refund')                               THEN 'deposit'
            WHEN LOWER(tx_type::text) IN ('gift')                                 THEN 'deposit'
            ELSE 'deposit'
          END::text AS normalized_type,
          NULL::text AS game_type
        FROM wallet_transactions
        WHERE user_id = $1
      )
      UNION ALL
      (
        SELECT
          id,
          type::text AS tx_type,
          amount::numeric,
          status::text,
          bank::text AS bank,
          tx_ref::text AS tx_ref,
          provider_payload::jsonb AS meta,
          created_at,
          'prize'::text AS normalized_type,
          CASE
            WHEN bank IN ('SPIN_PRIZE', 'SPIN_REFUND') THEN 'SPIN'
            ELSE 'XO'
          END::text AS game_type
        FROM payment_transactions
        WHERE user_id = $1
      )
      ORDER BY created_at DESC
      LIMIT 500
    `, [userId]);

    const transactions = result.rows.map(tx => ({
      id: tx.id,
      tx_type: tx.normalized_type,
      type: tx.normalized_type,
      amount: Number(tx.amount),
      status: (tx.status || 'pending').toLowerCase(),
      method: tx.bank || 'Chapa',
      ref: tx.tx_ref,
      createdAt: tx.created_at,
      game_type: tx.game_type || null,
    }));

    // Compute aggregate stats server-side
    let depCount = 0, depSum = 0;
    let witCount = 0, witSum = 0;
    let prizeCount = 0, prizeSum = 0;
    let successCount = 0;
    for (const tx of transactions) {
      const isSuccess = ['success', 'completed', 'settled', 'paid'].includes(tx.status);
      if (isSuccess) successCount++;
      if (tx.type === 'deposit' && isSuccess) { depCount++; depSum += tx.amount; }
      if (tx.type === 'withdrawal' && isSuccess) { witCount++; witSum += tx.amount; }
      if (tx.type === 'prize' && isSuccess) { prizeCount++; prizeSum += tx.amount; }
    }

    return res.json({
      ok: true,
      transactions,
      stats: {
        deposits: { count: depCount, total: depSum },
        withdrawals: { count: witCount, total: witSum },
        prizes: { count: prizeCount, total: prizeSum },
        net: depSum + prizeSum - witSum,
        successCount,
      },
    });
  } catch (err) {
    console.error('[account] /transactions error:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});


// PATCH /account/welcome-seen -> Refactored to "Claim Giveaway"
router.patch("/welcome-seen", auth, async (req, res) => {
  try {
    const userId = req.user?.id || req.user?.sub || req.user?.userId;

    // 1. Get current giveaway configuration
    const settingsRes = await pool.query(`
      SELECT key, value FROM global_settings 
      WHERE key IN ('current_giveaway_version', 'welcome_bonus_amount', 'welcome_bonus_active')
    `);
    const config = {};
    for (const r of settingsRes.rows) config[r.key] = r.value;

    const currentVersion = Number(config.current_giveaway_version || 1);
    const bonusAmount = Number(config.welcome_bonus_amount || 10);
    const isActive = config.welcome_bonus_active === true || config.welcome_bonus_active === 'true';

    if (!isActive) {
      return res.status(403).json({ message: "Giveaway is currently inactive" });
    }

    // 2. Atomic check and update using a transaction or a single robust query
    // We update the user and wallet only if the user hasn't claimed the current version yet.
    const result = await pool.query(`
      WITH updated_user AS (
        UPDATE users 
        SET claimed_giveaway_version = $1
        WHERE id = $2 AND (claimed_giveaway_version IS NULL OR claimed_giveaway_version < $1)
        RETURNING id
      )
      UPDATE wallets
      SET bonus_balance = COALESCE(bonus_balance, 0) + $3, available_balance = COALESCE(available_balance, 0) + $3
      WHERE user_id IN (SELECT id FROM updated_user)
      RETURNING user_id;
    `, [currentVersion, userId, bonusAmount]);

    if (result.rowCount === 0) {
      // Either user doesn't exist or already claimed this version
      return res.status(400).json({ message: "Giveaway already claimed or user not found" });
    }

    // 3. Log the bonus
    await pool.query(
      `INSERT INTO bonus_logs (user_id, amount, reason) VALUES ($1, $2, $3)`,
      [userId, bonusAmount, `Giveaway v${currentVersion} Claimed`]
    ).catch(err => console.error('[BONUS_LOG] Claim log error:', err));

    // Audit trail: record in wallet_transactions for reconciliation
    await pool.query(`
      INSERT INTO wallet_transactions (user_id, tx_type, amount, status, provider, meta, idempotency_key)
      VALUES ($1, 'GIFT', $2, 'COMPLETED', 'GIVEAWAY_CLAIM', $3, $4)
      ON CONFLICT (user_id, idempotency_key) DO NOTHING
    `, [userId, bonusAmount, JSON.stringify({ version: currentVersion }), `GIVEAWAY_V${currentVersion}_${userId}`])
    .catch(err => console.error('[WALLET_TX] Giveaway claim tx log error:', err));

    res.json({ ok: true, amount: bonusAmount, version: currentVersion });
  } catch (e) {
    console.error("Giveaway claim error:", e);
    res.status(500).json({ message: "Server error" });
  }
});

// GET /account/config -> Returns public/user-level settings
router.get("/config", auth, async (req, res) => {
  try {
    const userId = req.user?.id || req.user?.sub || req.user?.userId;

    const settingsRes = await pool.query(`
      SELECT key, value FROM global_settings 
      WHERE key IN ('current_giveaway_version', 'welcome_bonus_active', 'welcome_bonus_amount', 'referral_enabled', 'rooms_locked')
    `);
    
    // Also fetch the active promo popup
    const popupRes = await pool.query(`
      SELECT image_url, display_duration, expires_at, is_active 
      FROM promo_popups 
      WHERE is_active = true 
      ORDER BY created_at DESC 
      LIMIT 1
    `);
    const config = {};
    for (const r of settingsRes.rows) {
      // Postgres jsonb might already be parsed depending on driver, but we'll be safe
      config[r.key] = typeof r.value === 'string' ? JSON.parse(r.value) : r.value;
    }

    // Check if the current user has an unacknowledged win (top 3) from last week's snapshot
    let previousWeekWin = null;
    let payoutPending = false;
    try {
      const lastSnapshotRes = await pool.query(`
        SELECT id, rank, prize_amount, week_start, week_end 
        FROM leaderboard_snapshots 
        WHERE user_id = $1 AND prize_status = 'approved' AND rank <= 3
        ORDER BY week_start DESC 
        LIMIT 1
      `, [userId]);
      
      if (lastSnapshotRes.rows.length > 0) {
        const snap = lastSnapshotRes.rows[0];
        previousWeekWin = {
          snapshotId: snap.id,
          rank: Number(snap.rank),
          prize: Number(snap.prize_amount),
          weekStart: snap.week_start,
          weekEnd: snap.week_end
        };
      }

      // Check if there are any pending snapshots (i.e. manual review is in progress)
      const pendingRes = await pool.query(`
        SELECT 1 FROM leaderboard_snapshots 
        WHERE prize_status = 'pending' 
        LIMIT 1
      `);
      payoutPending = pendingRes.rows.length > 0;
    } catch (e) {
      console.warn('[CONFIG] Error fetching last week win snapshot:', e.message);
    }
    
    // Cache for 60s — this endpoint is called from 3 UI locations on every page load
    // and the data (giveaway version, rooms_locked, etc.) changes very rarely.
    res.set('Cache-Control', 'private, max-age=60');
    res.json({
      ok: true,
      current_giveaway_version: Number(config.current_giveaway_version || 1),
      welcome_bonus_active: config.welcome_bonus_active === true || config.welcome_bonus_active === 'true',
      welcome_bonus_amount: Number(config.welcome_bonus_amount || 10),
      referral_enabled: config.referral_enabled !== false && config.referral_enabled !== 'false', // default true if not set
      promo_popup_config: popupRes.rows.length > 0 ? popupRes.rows[0] : null,
      previousWeekWin,
      payoutPending,
      rooms_locked: config.rooms_locked === true || config.rooms_locked === 'true' // default false if not set
    });
  } catch (e) {
    console.error("Config fetch error:", e);
    res.status(500).json({ message: "Server error" });
  }
});


// GET /account/bonus-logs -> Returns user's bonus history & admin edits
router.get('/bonus-logs', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const result = await pool.query(`
      SELECT amount, reason, created_at FROM (
        SELECT amount, reason, created_at 
        FROM bonus_logs 
        WHERE user_id = $1 
        UNION ALL 
        SELECT amount, 'Admin Balance Edit' as reason, created_at 
        FROM wallet_transactions 
        WHERE user_id = $1 
          AND tx_type::text IN ('ADMIN_CREDIT', 'GIFT') 
          AND status = 'COMPLETED'
      ) combined_logs
      ORDER BY created_at DESC 
      LIMIT 100
    `, [userId]);

    return res.json({
      ok: true,
      logs: result.rows.map(log => ({
        amount: Number(log.amount),
        reason: log.reason,
        created_at: log.created_at
      }))
    });
  } catch (err) {
    console.error('[account] /bonus-logs error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// POST /account/redeem-code -> Redeem promocode
router.post('/redeem-code', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { code } = req.body;
    
    if (!code || typeof code !== 'string' || code.trim().length < 3) {
      return res.status(400).json({ error: 'Invalid code format' });
    }

    const cleanCode = code.trim().toUpperCase();

    // Find active promocode (robust query)
    const codeRes = await pool.query(`
      SELECT * FROM promocodes 
      WHERE UPPER(code) = $1 
        AND (is_active IS NULL OR is_active = true)
        AND (starts_at IS NULL OR starts_at <= NOW())
        AND (expires_at IS NULL OR expires_at >= NOW())
    `, [cleanCode]);

    if (codeRes.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid or expired code' });
    }

    const promocode = codeRes.rows[0];

    // Check usage limit if set
    if (promocode.usage_limit !== null && promocode.usage_limit !== undefined && promocode.usage_limit > 0) {
      const claimCountRes = await pool.query(
        `SELECT COUNT(*)::int AS cnt FROM promocode_claims WHERE promocode_id = $1`,
        [promocode.id]
      );
      if ((claimCountRes.rows[0]?.cnt || 0) >= Number(promocode.usage_limit)) {
        return res.status(400).json({ error: 'Code usage limit reached' });
      }
    }

    // Check if user already used it
    const usageRes = await pool.query(`
      SELECT 1 FROM promocode_claims 
      WHERE promocode_id = $1 AND user_id = $2
    `, [promocode.id, userId]);

    if (usageRes.rows.length > 0) {
      return res.status(400).json({ error: 'Code already redeemed' });
    }

    const amount = Number(promocode.amount);

    // Apply bonus
    await pool.query(`
      UPDATE wallets 
      SET bonus_balance = bonus_balance + $1,
          available_balance = available_balance + $1
      WHERE user_id = $2
    `, [amount, userId]);

    // Log usage
    await pool.query(`
      INSERT INTO promocode_claims (promocode_id, user_id) VALUES ($1, $2)
    `, [promocode.id, userId]);

    // Update usage count if column exists
    await pool.query(`
      UPDATE promocodes SET usage_count = COALESCE(usage_count, 0) + 1 WHERE id = $1
    `).catch(() => {});

    // Log bonus
    await pool.query(`
      INSERT INTO bonus_logs (user_id, amount, reason) VALUES ($1, $2, $3)
    `, [userId, amount, promocode.title || `Promocode: ${cleanCode}`]);

    // Audit trail: record in wallet_transactions for reconciliation
    await pool.query(`
      INSERT INTO wallet_transactions (user_id, tx_type, amount, status, provider, meta, idempotency_key)
      VALUES ($1, 'GIFT', $2, 'COMPLETED', 'PROMOCODE', $3, $4)
      ON CONFLICT (user_id, idempotency_key) DO NOTHING
    `, [userId, amount, JSON.stringify({ promocodeId: promocode.id, title: promocode.title }), `PROMOCODE_${promocode.id}_${userId}`])
    .catch(err => console.error('[WALLET_TX] Promocode claim tx log error:', err));

    return res.json({ ok: true, amount });
  } catch (err) {
    console.error('[account] /redeem-code error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;

