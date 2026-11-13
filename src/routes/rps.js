/**
 * rps.js — REST endpoints for Rock Paper Scissors.
 *
 * All endpoints require auth middleware.
 * These are read-only configuration and status endpoints;
 * all gameplay happens over Socket.IO (rpsSocketHandler.js).
 *
 * Routes:
 *   GET /rps/config   → bet tiers, rake %, timings
 *   GET /rps/rooms    → active rooms (admin only)
 *   GET /rps/history  → player's match history
 */

const express = require('express');
const router = express.Router();
const { auth, adminAuth } = require('../middleware/Auth');
const { pool } = require('../db/index');
const { BET_TIERS, FEE_PERCENT, TIMINGS } = require('../games/rps/RPSGame');
const { getQueueSizes, getActiveRoomCount, listActiveRooms } = require('../games/rps/RPSRoomManager');

// ── GET /rps/config ──────────────────────────────────────────────────────
// Public game configuration (bet tiers, fee %, timings).
// Requires auth so we know the user is logged in.
router.get('/config', auth, (req, res) => {
  res.json({
    betTiers: BET_TIERS,
    feePercent: FEE_PERCENT,
    bestOf: 3,
    timings: {
      countdown: TIMINGS.COUNTDOWN_MS,
      choose: TIMINGS.CHOOSE_MS,
      shake: TIMINGS.SHAKE_MS,
      roundResult: TIMINGS.ROUND_RESULT_MS,
    },
    queueSizes: getQueueSizes(),
    activeRooms: getActiveRoomCount(),
  });
});

// ── GET /rps/rooms ───────────────────────────────────────────────────────
// Admin-only: list all active rooms with details.
router.get('/rooms', adminAuth, (req, res) => {
  res.json({
    rooms: listActiveRooms(),
    queueSizes: getQueueSizes(),
  });
});

// ── GET /rps/history ─────────────────────────────────────────────────────
// Player's recent match history (last 20 matches).
router.get('/history', auth, async (req, res) => {
  try {
    const userId = req.user.id || req.user.sub || req.user.userId;
    const limit = Math.min(Number(req.query.limit) || 20, 50);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    const { rows } = await pool.query(`
      SELECT
        g.id, g.room_id, g.stake_amount, g.pot_amount, g.fee_amount,
        g.prize_amount, g.winner_id, g.score_p1, g.score_p2,
        g.rounds_data, g.status, g.best_of,
        g.created_at, g.finished_at,
        g.player_1, g.player_2,
        u1.username AS p1_username, u1.display_name AS p1_display_name,
        u2.username AS p2_username, u2.display_name AS p2_display_name
      FROM rps_games g
      LEFT JOIN users u1 ON g.player_1 = u1.id
      LEFT JOIN users u2 ON g.player_2 = u2.id
      WHERE g.player_1 = $1::uuid OR g.player_2 = $1::uuid
      ORDER BY g.created_at DESC
      LIMIT $2 OFFSET $3
    `, [userId, limit, offset]);

    res.json({ ok: true, matches: rows });
  } catch (err) {
    console.error('[RPS] /history error:', err.message);
    res.status(500).json({ ok: false, error: 'Failed to fetch match history' });
  }
});

module.exports = router;
