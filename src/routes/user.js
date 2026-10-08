// user.routes.js
const express = require('express');
const { pool, getGlobalSetting } = require('../db/index');
const { auth } = require('./../middleware/Auth');
const { redeemPromoCode } = require('../models/payments.service');

const router = express.Router();

/**
 * POST /user/promocodes/redeem
 */
router.post('/promocodes/redeem', auth, async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Code is required' });

  try {
    const result = await redeemPromoCode({ userId: req.user.id, code });
    return res.json({ ok: true, ...result });
  } catch (err) {
    const msg = String(err.message || '');
    const validationErrors = ['INVALID_CODE', 'ALREADY_REDEEMED', 'ONLY_FOR_NEW_USERS'];

    if (validationErrors.includes(msg)) {
      console.log(`[PROMOCODE_REDEEM_FAIL] User ${req.user.id} code "${code}": ${msg}`);
      
      const status = msg === 'INVALID_CODE' ? 404 : 400;
      const errorMap = {
        'INVALID_CODE': 'Promo code not found',
        'ALREADY_REDEEMED': 'You have already used this promo code',
        'ONLY_FOR_NEW_USERS': 'This gift is only for new users'
      };
      
      return res.status(status).json({ error: errorMap[msg] || msg, code: msg });
    }

    // Unexpected errors get full logging
    console.error(`[PROMOCODE_SYSTEM_ERROR] User ${req.user.id} code "${code}":`, err);
    return res.status(500).json({ 
      error: 'Internal server error',
      details: msg 
    });
  }
});


/**
 * GET /user/me
 * Returns profile info (id, username, number, avatar, new_user)
 * plus wallet balances (available_balance, withdrawable_balance)
 */
router.get('/me', auth, async (req, res) => {
  try {
    const userId = req.user.id;

    pool.query(`
      INSERT INTO user_entries (user_id)
      SELECT $1::uuid
      WHERE NOT EXISTS (
        SELECT 1 FROM user_entries
        WHERE user_id = $1::uuid AND created_at >= CURRENT_DATE
      )
    `, [userId]).catch(err => console.error('[DAU_LOG_ERR]', err));

    const query = `
      SELECT 
        u.id,
        u.username,
        u.number,
        u.avatar,
        u.new_user,
        u.display_name,
        u.role,
        u.room_1_wins,
        u.room_2_wins,
        u.room_3_wins,
        u.r1_10_wins,
        u.r1_15_wins,
        u.r1_25_wins,
        u.r1_50_wins,
        u.r1_99_wins,
        u.r2_100_wins,
        u.r3_1000_wins,
        u.banned,
        u.created_at,
        u.claimed_giveaway_version,
        COALESCE(u.raw_user_meta_data->'accomplishments', '[]'::jsonb) AS accomplishments,
        COALESCE(w.available_balance, 0)    AS available_balance,
        COALESCE(w.withdrawable_balance, 0) AS withdrawable_balance,
        COALESCE(w.bonus_balance, 0)        AS bonus_balance
      FROM users u
      LEFT JOIN wallets w ON w.user_id = u.id
      WHERE u.id = $1
      LIMIT 1;
    `;

    const { rows } = await pool.query(query, [userId]);
    if (!rows.length) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = rows[0];

    const { rows: gameCountRows } = await pool.query(`SELECT COUNT(*) AS total FROM games WHERE player_x = $1 OR player_o = $1`, [userId]);
    const totalGames = gameCountRows[0]?.total || 0;

    const { rows: winCountRows } = await pool.query(`SELECT COUNT(*) AS wins FROM games WHERE winner = $1`, [userId]);
    const totalWins = winCountRows[0]?.wins || 0;

    return res.json({
      id: user.id,
      username: user.username,
      number: user.number,
      avatar: user.avatar,
      new_user: user.new_user,
      display_name: user.display_name,
      role: user.role || 'user',
      room_1_wins: user.room_1_wins || 0,
      room_2_wins: user.room_2_wins || 0,
      room_3_wins: user.room_3_wins || 0,
      r1_10_wins: user.r1_10_wins || 0,
      r1_15_wins: user.r1_15_wins || 0,
      r1_25_wins: user.r1_25_wins || 0,
      r1_50_wins: user.r1_50_wins || 0,
      r1_99_wins: user.r1_99_wins || 0,
      r2_100_wins: user.r2_100_wins || 0,
      r3_1000_wins: user.r3_1000_wins || 0,
      banned: user.banned || false,
      created_at: user.created_at,
      claimed_giveaway_version: user.claimed_giveaway_version || 0,
      accomplishments: user.accomplishments || [],
      available_balance: Number(user.available_balance),
      withdrawable_balance: Number(user.withdrawable_balance),
      bonus_balance: Number(user.bonus_balance),
      total_games: totalGames,
      total_wins: totalWins,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to fetch user' });
  }
});

/**
 * GET /user/bonus-logs
 */
router.get('/bonus-logs', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, amount, reason, created_at 
       FROM bonus_logs 
       WHERE user_id = $1 
       ORDER BY created_at DESC 
       LIMIT 100`,
      [req.user.id]
    );
    return res.json({ ok: true, logs: rows });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to fetch bonus logs' });
  }
});

/**
 * GET /user/referral-link
 * Returns the user's unique referral URL
 */
router.get('/referral-link', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    // Use first 8 chars of UUID as referral code
    const refCode = userId.slice(0, 8).toUpperCase();
    const frontendBase = process.env.APP_URL || process.env.FRONTEND_URL || 'https://xo-frontend-gamma.vercel.app';
    const referralUrl = `${frontendBase}/?ref=${refCode}`;
    
    // Check if referral system is enabled (cached in Redis)
    const enabled = await getGlobalSetting('referral_enabled', true);

    return res.json({ 
      ok: true, 
      referralCode: refCode,
      referralUrl,
      enabled
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to get referral link' });
  }
});

/**
 * GET /user/referral-stats
 * Returns referral count and total bonus earned
 */
router.get('/referral-stats', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    
    const { rows } = await pool.query(`
      SELECT 
        COUNT(*) AS total_referred,
        COALESCE(SUM(bonus_amount), 0) AS total_bonus_earned
      FROM referrals 
      WHERE referrer_id = $1
    `, [userId]);

    const { rows: recentRows } = await pool.query(`
      SELECT r.bonus_amount, r.created_at, u.username
      FROM referrals r
      JOIN users u ON r.referred_id = u.id
      WHERE r.referrer_id = $1
      ORDER BY r.created_at DESC
      LIMIT 20
    `, [userId]);

    return res.json({
      ok: true,
      totalReferred: Number(rows[0]?.total_referred || 0),
      totalBonusEarned: Number(rows[0]?.total_bonus_earned || 0),
      recentReferrals: recentRows
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to get referral stats' });
  }
});


module.exports = router;
