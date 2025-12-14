const { pool } = require("../db/index");

// Create new game
async function createGame(playerX, playerO, betAmount) {
  const query = `
    INSERT INTO games (player_x, player_o, bet_amount)
    VALUES ($1, $2, $3)
    RETURNING *;
  `;
  const { rows } = await pool.query(query, [playerX, playerO, betAmount]);
  return rows[0];
}

// Add a move (append JSONB array)
async function addMove(gameId, move) {
  const query = `
    UPDATE games
    SET moves = moves || $1::jsonb
    WHERE id = $2
    RETURNING *;
  `;
  const { rows } = await pool.query(query, [JSON.stringify(move), gameId]);
  return rows[0];
}

// Finish a game
async function finishGame(gameId, status, winnerId = null) {
  const query = `
    UPDATE games
    SET status = $1,
        winner = $2,
        finished_at = NOW()
    WHERE id = $3
    RETURNING *;
  `;
  const { rows } = await pool.query(query, [status, winnerId, gameId]);
  return rows[0];
}

// Fetch a single game
async function getGameById(gameId) {
  const { rows } = await pool.query("SELECT * FROM games WHERE id = $1;", [gameId]);
  return rows[0];
}

// Fetch games for a user (history)
async function getGamesByUser(userId, limit = 20) {
  const query = `
    SELECT * FROM games
    WHERE player_x = $1 OR player_o = $1
    ORDER BY created_at DESC
    LIMIT $2;
  `;
  const { rows } = await pool.query(query, [userId, limit]);
  return rows;
}

module.exports = {
  createGame,
  addMove,
  finishGame,
  getGameById,
  getGamesByUser,
};
