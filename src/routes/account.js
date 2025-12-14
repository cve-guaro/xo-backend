const express = require('express');
const { pool } = require('../db/index'); // your Postgres client (pg.Pool
const { body, validationResult } = require('express-validator');
const { auth } = require('../middleware/Auth.js');

const router = express.Router();

// PATCH /account/profile
router.patch(
  "/profile",
  [
    body("username").optional().isLength({ min: 3, max: 30 }).trim().escape(),
    body("display_name").optional().isLength({ min: 1, max: 50 }).trim().escape(),
  ], auth,
  async (req, res) => {
    try {
      const userId = req.user?.id || req.user?.sub || req.user?.userId

      // --- Validate body ---
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        console.log("Validation errors:", errors.array());
        return res.status(400).json({ message: "Validation error", errors: errors.array() });
      }


      const { username, display_name, avatar } = req.body;
      if (!username && !display_name && !avatar) {
        return res.status(400).json({ message: "No data provided" });
      }

      // --- Build dynamic update ---
      const fields = [];
      const values = [];
      let idx = 1;

      if (username) {
        fields.push(`username = $${idx++}`);
        values.push(username);
      }
      if (display_name) {
        fields.push(`display_name = $${idx++}`);
        values.push(display_name);
      }
      if (avatar) {
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
      console.error("Profile update error:", err);
      res.status(500).json({ message: "Server error" });
    }
  }
);

router.post('/history', auth, async (req, res) => {
  try {
    const userId = req.user?.id || req.user?.sub || req.user?.userId;
    const limit = parseInt(req.body.limit, 10) || 50;

    const query = `
      SELECT id, bet_amount, winner, status, created_at, finished_at, moves, (player_x, player_o) as players
      FROM games
      WHERE player_x = $1 OR player_o = $1
      ORDER BY created_at DESC
      LIMIT $2;
    `;
    const values = [userId, limit];

    const result = await pool.query(query, values);
    console.log("History query executed with values:", result.rows);
    res.json({ ok: true, history: result.rows });
  } catch (err) {
    console.error("History retrieval error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
