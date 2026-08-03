// src/routes/spin.js
// ────────────────────────────────────────────────────────────────────────────
// REST API for Spin game: room listing, history, round details.
// ────────────────────────────────────────────────────────────────────────────
const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");
const { pool } = require("../db/index");
const { getSpinConfigs, activeSpinRounds } = require("../socket/spinRoom");
const { calculateSpinPrize } = require("../services/spinWalletService");

const JWT_SECRET = process.env.JWT_SECRET;

// ── Auth middleware ────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  try {
    const hdr = req.headers.authorization || "";
    const token = hdr.startsWith("Bearer ") ? hdr.slice(7) : hdr;
    if (!token) return res.status(401).json({ error: "No token provided" });

    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] });
    req.userId = decoded.sub || decoded.userId || decoded.id;
    next();
  } catch {
    return res.status(401).json({ error: "AUTH_FAILED" });
  }
}

// ── GET /spin/rooms — List active spin room configs ────────────────────────
router.get("/rooms", async (req, res) => {
  try {
    const configs = await getSpinConfigs();

    const rooms = configs.map(config => {
      let currentPlayers = 0;
      let activeRoundId = null;
      for (const [id, round] of activeSpinRounds) {
        if (round.configId === config.id && round.status === "waiting") {
          currentPlayers = round.players.length;
          activeRoundId = id;
          break;
        }
      }

      return {
        id: config.id,
        name: config.name,
        betAmount: Number(config.bet_amount),
        maxPlayers: config.max_players || 5,
        houseCutPercent: Number(config.house_cut_percent || 20),
        currentPlayers,
        activeRoundId,
        estimatedPrize: calculateSpinPrize(
          Number(config.bet_amount) * (config.max_players || 5),
          Number(config.house_cut_percent || 20)
        ).prize,
      };
    });

    res.json({ ok: true, rooms });
  } catch (err) {
    console.error("[SPIN_API] GET /rooms error:", err.message);
    res.status(500).json({ error: "Failed to load rooms" });
  }
});

// ── GET /spin/history — User's spin history ────────────────────────────────
router.get("/history", requireAuth, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 20, 50);
    const offset = Number(req.query.offset) || 0;

    const { rows } = await pool.query(
      `SELECT sr.id AS round_id, sr.config_id, sr.status, sr.pot_amount::numeric, sr.prize_amount::numeric,
              sr.winner_user_id, sr.winning_slice, sr.players AS players_json,
              sr.created_at, sr.resolved_at,
              src.name AS room_name, src.bet_amount::numeric,
              sb.seat_index,
              CASE WHEN sr.winner_user_id = $1::uuid THEN true ELSE false END AS is_winner,
              (SELECT username FROM users WHERE id = sr.winner_user_id) AS winner_name
       FROM spin_bets sb
       JOIN spin_rounds sr ON sb.round_id = sr.id
       JOIN spin_room_configs src ON sr.config_id = src.id
       WHERE sb.user_id = $1::uuid AND sb.is_bot = false
       ORDER BY sr.created_at DESC
       LIMIT $2 OFFSET $3`,
      [req.userId, limit, offset]
    );

    const history = rows.map(r => {
      let players = [];
      try {
        players = typeof r.players_json === 'string' ? JSON.parse(r.players_json) : (r.players_json || []);
      } catch (_) { players = []; }
      const totalPlayers = players.length;
      const botCount = players.filter(p => p.isBot).length;
      const pot = Number(r.pot_amount || 0);
      const prize = Number(r.prize_amount || 0);
      const houseCut = Math.max(0, pot - prize);

      return {
        ...r,
        pot_amount: pot,
        prize_amount: prize,
        house_cut: houseCut,
        total_players: totalPlayers,
        bot_count: botCount,
        players,
        mode_label: r.config_id === 2 ? 'Rail Spin' : '5-Player Spin'
      };
    });

    res.json({ ok: true, history });
  } catch (err) {
    console.error("[SPIN_API] GET /history error:", err.message);
    res.status(500).json({ error: "Failed to load history" });
  }
});

// ── GET /spin/round/:id — Round details (for reconnection) ────────────────
router.get("/round/:id", requireAuth, async (req, res) => {
  try {
    const roundId = req.params.id;

    // Check in-memory first
    const active = activeSpinRounds.get(roundId);
    if (active) {
      return res.json({
        ok: true,
        round: {
          id: active.id,
          status: active.status,
          betAmount: active.betAmount,
          maxPlayers: active.maxPlayers,
          roomName: active.roomName,
          players: active.players.map(p => ({
            userId: p.userId,
            username: p.username,
            seatIndex: p.seatIndex,
          })),
          pot: active.betAmount * active.players.length,
          countdown: active.countdown,
          winningSlice: active.status !== "waiting" ? active.winningSlice : null,
          winnerId: active.winnerId,
          prizeAmount: active.prizeAmount,
        },
      });
    }

    // Fallback to DB
    const { rows } = await pool.query(
      `SELECT sr.*, src.name AS room_name, src.bet_amount
       FROM spin_rounds sr
       JOIN spin_room_configs src ON sr.config_id = src.id
       WHERE sr.id = $1::uuid`,
      [roundId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "Round not found" });
    }

    res.json({ ok: true, round: rows[0] });
  } catch (err) {
    console.error("[SPIN_API] GET /round/:id error:", err.message);
    res.status(500).json({ error: "Failed to load round" });
  }
});

module.exports = router;
