const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET is not set in auth.js. Refusing to start insecurely.');
  process.exit(1);
}

router.post('/login', async (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'Username is required' });

  let user = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
  if (user.rows.length === 0) {
    user = await pool.query('INSERT INTO users (username, balance) VALUES ($1, $2) RETURNING *', [username, 100]);
  }

  const token = jwt.sign({ id: user.rows[0].id, username }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: user.rows[0] });
});

module.exports = router;