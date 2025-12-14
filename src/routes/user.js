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
        COALESCE(w.available_balance, 0) AS available_balance,
        COALESCE(w.withdrawable_balance, 0) AS withdrawable_balance
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
      available_balance: Number(user.available_balance),
      withdrawable_balance: Number(user.withdrawable_balance),
      total_games: totalGames,
      total_wins: totalWins,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to fetch user' });
  }
});

module.exports = router;
