// src/services/friendService.js
// ────────────────────────────────────────────────────────────────────────────
// Service to manage friendships, automatic friend collection from 1v1 matches
// and direct invitations, and friend search with real-time online status.
// ────────────────────────────────────────────────────────────────────────────
const { pool } = require("../db/index");

async function ensureFriendsTable() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_friends (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        friend_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        source VARCHAR(32) DEFAULT 'manual',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        CONSTRAINT uq_user_friend UNIQUE (user_id, friend_id),
        CONSTRAINT ck_friend_not_self CHECK (user_id != friend_id)
      );
      CREATE INDEX IF NOT EXISTS idx_user_friends_user ON user_friends(user_id);
      CREATE INDEX IF NOT EXISTS idx_user_friends_friend ON user_friends(friend_id);
    `);
  } catch (err) {
    console.error("[FRIEND_SERVICE] Failed to ensure user_friends table:", err.message);
  }
}

/**
 * Record a friendship between two users (bidirectional).
 * Sources: '1v1_match', 'invite', 'manual'
 */
async function recordFriendship(userId1, userId2, source = "manual") {
  if (!userId1 || !userId2) return;
  const u1 = String(userId1);
  const u2 = String(userId2);
  if (u1 === u2) return;

  try {
    await pool.query(
      `INSERT INTO user_friends (user_id, friend_id, source)
       VALUES ($1, $2, $3), ($2, $1, $3)
       ON CONFLICT (user_id, friend_id) DO NOTHING`,
      [u1, u2, source]
    );
  } catch (err) {
    console.error("[FRIEND_SERVICE] recordFriendship error:", err.message);
  }
}

/**
 * Get list of friends for a user, sorted by most recently added.
 */
async function getFriendsList(userId, isOnlineFn) {
  if (!userId) return [];
  try {
    const { rows } = await pool.query(
      `SELECT 
         u.id, 
         u.username, 
         u.display_name, 
         u.avatar,
         uf.source,
         uf.created_at
       FROM user_friends uf
       JOIN users u ON uf.friend_id = u.id
       WHERE uf.user_id = $1
       ORDER BY uf.created_at DESC`,
      [userId]
    );

    return rows.map((r) => {
      const isOnline = isOnlineFn ? Boolean(isOnlineFn(r.id)) : false;
      return {
        id: r.id,
        username: r.username,
        display_name: r.display_name || r.username,
        avatar: r.avatar,
        source: r.source,
        created_at: r.created_at,
        is_friend: true,
        is_online: isOnline,
      };
    });
  } catch (err) {
    console.error("[FRIEND_SERVICE] getFriendsList error:", err.message);
    return [];
  }
}

/**
 * Search users by username or display name, showing whether they are already a friend
 * and their online status.
 */
async function searchUsersForFriendship(userId, queryText, isOnlineFn) {
  if (!userId) return [];
  const cleanQ = String(queryText || "").trim();
  if (!cleanQ) {
    return getFriendsList(userId, isOnlineFn);
  }

  try {
    const searchPattern = `%${cleanQ}%`;
    const { rows } = await pool.query(
      `SELECT 
         u.id, 
         u.username, 
         u.display_name, 
         u.avatar,
         EXISTS (
           SELECT 1 FROM user_friends uf 
           WHERE uf.user_id = $1 AND uf.friend_id = u.id
         ) AS is_friend
       FROM users u
       WHERE u.id != $1
         AND (LOWER(u.username) LIKE LOWER($2) OR LOWER(COALESCE(u.display_name, '')) LIKE LOWER($2))
       ORDER BY is_friend DESC, u.username ASC
       LIMIT 30`,
      [userId, searchPattern]
    );

    return rows.map((r) => {
      const isOnline = isOnlineFn ? Boolean(isOnlineFn(r.id)) : false;
      return {
        id: r.id,
        username: r.username,
        display_name: r.display_name || r.username,
        avatar: r.avatar,
        is_friend: Boolean(r.is_friend),
        is_online: isOnline,
      };
    });
  } catch (err) {
    console.error("[FRIEND_SERVICE] searchUsersForFriendship error:", err.message);
    return [];
  }
}

/**
 * Add a friend manually by friendId or username.
 */
async function addFriendManual(userId, friendIdOrUsername, isOnlineFn) {
  if (!userId || !friendIdOrUsername) throw new Error("MISSING_PARAMS");
  const target = String(friendIdOrUsername).trim();

  // Find user by id or username
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target);
  const query = isUuid
    ? `SELECT id, username, display_name, avatar FROM users WHERE id = $1`
    : `SELECT id, username, display_name, avatar FROM users WHERE LOWER(username) = LOWER($1)`;

  const { rows } = await pool.query(query, [target]);
  if (!rows.length) {
    throw new Error("USER_NOT_FOUND");
  }

  const friend = rows[0];
  if (String(friend.id) === String(userId)) {
    throw new Error("CANNOT_ADD_SELF");
  }

  await recordFriendship(userId, friend.id, "manual");

  const isOnline = isOnlineFn ? Boolean(isOnlineFn(friend.id)) : false;
  return {
    id: friend.id,
    username: friend.username,
    display_name: friend.display_name || friend.username,
    avatar: friend.avatar,
    is_friend: true,
    is_online: isOnline,
  };
}

module.exports = {
  ensureFriendsTable,
  recordFriendship,
  getFriendsList,
  searchUsersForFriendship,
  addFriendManual,
};
