// user.routes.js
const express = require('express');
const { pool } = require('../db/index');
const { auth } = require('./../middleware/Auth');

const router = express.Router();

/**
 * GET /user/me
 * Returns profile info (id, username, number, avatar, new_user)
 * plus wallet balances (available_balance, withdrawable_balance)
 */
router.get('/me', auth, async (req, res) => {
  try {
    const userId = req.user.id;

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
        u.r1_10_wins,
        u.r1_25_wins,
        u.r1_50_wins,
        u.r1_99_wins,
        u.banned,
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
      r1_10_wins: user.r1_10_wins || 0,
      r1_25_wins: user.r1_25_wins || 0,
      r1_50_wins: user.r1_50_wins || 0,
      r1_99_wins: user.r1_99_wins || 0,
      banned: user.banned || false,
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


module.exports = router;
