const express = require('express');
const { pool } = require('../db/index');
const router = express.Router();
router.get('/dump', async (req, res) => {
  try {
    const fnRes = await pool.query("SELECT pg_get_functiondef(oid) FROM pg_proc WHERE proname = 'fn_wallet_apply_tx'");
    res.json(fnRes.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
module.exports = router;
