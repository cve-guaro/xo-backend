// userRepository.js
const { pool } = require("../db/index");

// Create user
async function createUser(username, number, avatar = null) {
  const query = `
    INSERT INTO users (username, number, avatar)
    VALUES ($1, $2, $3)
    RETURNING *;
  `;
  const { rows } = await pool.query(query, [username, number, avatar]);
  return rows[0];
}

// Get user by id
async function getUserById(userId) {
  const { rows } = await pool.query("SELECT * FROM users WHERE id = $1;", [userId]);
  return rows[0];
}

// Update balance or withdrawable
async function updateBalance(userId, amount, field = "balance") {
  const query = `
    UPDATE users
    SET ${field} = ${field} + $1
    WHERE id = $2
    RETURNING *;
  `;
  const { rows } = await pool.query(query, [amount, userId]);
  return rows[0];
}

// Get all users
async function getAllUsers(limit = 50) {
  const { rows } = await pool.query(
    "SELECT * FROM users ORDER BY created_at DESC LIMIT $1;",
    [limit]
  );
  return rows;
}

module.exports = {
  createUser,
  getUserById,
  updateBalance,
  getAllUsers,
};
