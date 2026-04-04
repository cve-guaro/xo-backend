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
// Returns the user's payment history (deposits + withdrawals only)
router.get('/transactions', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const result = await pool.query(`
      SELECT 
        id,
        type,
        amount,
        status,
        bank,
        tx_ref,
        created_at
      FROM payment_transactions
      WHERE user_id = $1
        AND (LOWER(type::text) IN ('deposit', 'withdrawal', 'withdraw_request'))
        AND (bank IS NULL OR bank != 'PRIZE')
      ORDER BY created_at DESC
      LIMIT 100
    `, [userId]);

    return res.json({
      ok: true,
      transactions: result.rows.map(tx => ({
        id: tx.id,
        type: tx.type,
        amount: Number(tx.amount),
        status: tx.status?.toLowerCase() || 'pending',
        method: tx.bank || 'Chapa',
        ref: tx.tx_ref,
        createdAt: tx.created_at,
      }))
    });
  } catch (err) {
    console.error('[account] /transactions error:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
