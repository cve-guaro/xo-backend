// src/services/friendService.js
// ────────────────────────────────────────────────────────────────────────────
// Service to manage friendships, automatic friend collection from 1v1 matches
// and direct invitations, friend search with real-time online/active-game
// status, and round-scoped Spin invites & friend requests (3-rejection limit).
// ────────────────────────────────────────────────────────────────────────────
const { v4: uuidv4 } = require("uuid");
const { pool } = require("../db/index");
const { getUserActiveGame, isUserInCurrentSpinRound } = require("./activeGameService");

const MAX_REJECTIONS_PER_ROUND = 3;

// Round-scoped in-memory Spin invite & friend-request state (zero DB migrations)
const spinInvites = new Map();          // inviteId -> { inviteId, roundId, senderId, targetUserId, mode, entryAmount, status, createdAt, updatedAt }
const spinInviteRejections = new Map(); // "${roundId}:${senderId}:${targetUserId}" -> number
const spinFriendRequests = new Map();   // requestId -> { requestId, roundId, senderId, targetUserId, status, createdAt, updatedAt }
const spinFriendRejections = new Map(); // "${roundId}:${senderId}:${targetUserId}" -> number

function rejectionKey(roundId, senderId, targetUserId) {
  return `${String(roundId)}:${String(senderId)}:${String(targetUserId)}`;
}

function getSpinInviteRejectionCount(roundId, senderId, targetUserId) {
  if (!roundId || !senderId || !targetUserId) return 0;
  return spinInviteRejections.get(rejectionKey(roundId, senderId, targetUserId)) || 0;
}

function getSpinFriendRejectionCount(roundId, senderId, targetUserId) {
  if (!roundId || !senderId || !targetUserId) return 0;
  return spinFriendRejections.get(rejectionKey(roundId, senderId, targetUserId)) || 0;
}

function cleanupSpinRoundInteractions(roundId) {
  if (!roundId) return;
  const rid = String(roundId);
  const prefix = `${rid}:`;

  for (const [id, inv] of spinInvites.entries()) {
    if (inv.roundId === rid) spinInvites.delete(id);
  }
  for (const key of spinInviteRejections.keys()) {
    if (key.startsWith(prefix)) spinInviteRejections.delete(key);
  }
  for (const [id, req] of spinFriendRequests.entries()) {
    if (req.roundId === rid) spinFriendRequests.delete(id);
  }
  for (const key of spinFriendRejections.keys()) {
    if (key.startsWith(prefix)) spinFriendRejections.delete(key);
  }
}

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
 * Sources: '1v1_match', 'invite', 'manual', 'spin_request'
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

async function areUsersFriends(userId1, userId2) {
  if (!userId1 || !userId2) return false;
  const { rows } = await pool.query(
    `SELECT 1 FROM user_friends WHERE user_id = $1 AND friend_id = $2 LIMIT 1`,
    [String(userId1), String(userId2)]
  );
  return rows.length > 0;
}

async function resolveUserByIdOrUsername(idOrUsername) {
  if (!idOrUsername) return null;
  const target = String(idOrUsername).trim();
  if (!target) return null;
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target);
  const query = isUuid
    ? `SELECT id, username, display_name, avatar FROM users WHERE id = $1::uuid`
    : `SELECT id, username, display_name, avatar FROM users WHERE LOWER(username) = LOWER($1)`;
  const { rows } = await pool.query(query, [target]);
  return rows[0] || null;
}

function getFriendRequestStatusForPair(viewerId, otherId, roundId = null) {
  const vId = String(viewerId);
  const oId = String(otherId);
  const rId = roundId ? String(roundId) : null;

  for (const req of spinFriendRequests.values()) {
    if (req.status !== "pending") continue;
    if (rId && req.roundId !== rId) continue;
    if (req.senderId === vId && req.targetUserId === oId) return "pending_sent";
    if (req.senderId === oId && req.targetUserId === vId) return "pending_received";
  }
  return "none";
}

async function enrichUserWithSpinStatus(viewerId, userObj, options = {}) {
  const roundId = options?.roundId ? String(options.roundId) : null;
  const active = await getUserActiveGame(userObj.id);
  const inCurrentRound = Boolean(roundId && isUserInCurrentSpinRound(userObj.id, roundId));
  const inviteRejections = roundId ? getSpinInviteRejectionCount(roundId, viewerId, userObj.id) : 0;
  const friendRejections = roundId ? getSpinFriendRejectionCount(roundId, viewerId, userObj.id) : 0;
  const friendRequestStatus = userObj.is_friend
    ? "friends"
    : getFriendRequestStatusForPair(viewerId, userObj.id, roundId);

  return {
    ...userObj,
    in_game: Boolean(active.inGame),
    in_current_round: inCurrentRound,
    active_game_type: active.inGame ? (active.gameType || null) : null,
    invite_rejections: inviteRejections,
    invite_blocked: inviteRejections >= MAX_REJECTIONS_PER_ROUND,
    friend_request_status: friendRequestStatus,
    friend_rejections: friendRejections,
    friend_blocked: friendRejections >= MAX_REJECTIONS_PER_ROUND,
  };
}

/**
 * Get list of friends for a user, sorted by most recently added.
 */
async function getFriendsList(userId, isOnlineFn, options = {}) {
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

    const baseList = rows.map((r) => {
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

    return await Promise.all(baseList.map((u) => enrichUserWithSpinStatus(userId, u, options)));
  } catch (err) {
    console.error("[FRIEND_SERVICE] getFriendsList error:", err.message);
    return [];
  }
}

/**
 * Search users by username or display name, showing whether they are already a friend,
 * their online status, and active-game / Spin invite / friend-request flags.
 */
async function searchUsersForFriendship(userId, queryText, isOnlineFn, options = {}) {
  if (!userId) return [];
  const cleanQ = String(queryText || "").trim();
  if (!cleanQ) {
    return getFriendsList(userId, isOnlineFn, options);
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

    const baseList = rows.map((r) => {
      const isFriend = Boolean(r.is_friend);
      // Privacy protection: only show real-time presence to mutual friends, never to strangers
      const isOnline = isOnlineFn && isFriend ? Boolean(isOnlineFn(r.id)) : false;
      return {
        id: r.id,
        username: r.username,
        display_name: r.display_name || r.username,
        avatar: r.avatar,
        is_friend: isFriend,
        is_online: isOnline,
      };
    });

    return await Promise.all(baseList.map((u) => enrichUserWithSpinStatus(userId, u, options)));
  } catch (err) {
    console.error("[FRIEND_SERVICE] searchUsersForFriendship error:", err.message);
    return [];
  }
}

/**
 * Add a friend manually by friendId or username (kept for XO RoomSheet backwards compatibility).
 */
async function addFriendManual(userId, friendIdOrUsername, isOnlineFn) {
  if (!userId || !friendIdOrUsername) throw new Error("MISSING_PARAMS");
  const friend = await resolveUserByIdOrUsername(friendIdOrUsername);
  if (!friend) {
    throw new Error("USER_NOT_FOUND");
  }

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

/**
 * Create a round-scoped Spin game invite.
 * Enforces self check, current-round check, active-game check, and 3-rejection limit per roundId.
 */
async function createSpinInvite({ senderId, targetUserId, roundId, mode = "5_PLAYER", entryAmount = 100 }) {
  if (!senderId || !targetUserId) {
    return { ok: false, error: "MISSING_TARGET", message: "Missing sender or target user" };
  }
  const sId = String(senderId);
  const tId = String(targetUserId);
  const rId = String(roundId || `lobby:${sId}`);

  if (sId === tId) {
    return { ok: false, error: "CANNOT_INVITE_SELF", message: "You cannot invite yourself" };
  }

  if (roundId && isUserInCurrentSpinRound(tId, rId)) {
    return {
      ok: false,
      error: "TARGET_IN_CURRENT_ROUND",
      message: "Player is already in this Spin game",
    };
  }

  const active = await getUserActiveGame(tId);
  if (active.inGame) {
    return {
      ok: false,
      error: "TARGET_IN_ACTIVE_GAME",
      message: "Player is already in an active game",
      activeGameType: active.gameType,
    };
  }

  const rejCount = getSpinInviteRejectionCount(rId, sId, tId);
  if (rejCount >= MAX_REJECTIONS_PER_ROUND) {
    return {
      ok: false,
      error: "INVITE_BLOCKED_LIMIT_REACHED",
      message: "You cannot send more invites to this player in this Spin room",
      rejectionCount: rejCount,
      blocked: true,
    };
  }

  // Supersede any stale pending invite from same sender -> target in same round
  for (const inv of spinInvites.values()) {
    if (inv.status === "pending" && inv.roundId === rId && inv.senderId === sId && inv.targetUserId === tId) {
      inv.status = "superseded";
      inv.updatedAt = Date.now();
    }
  }

  const invite = {
    inviteId: uuidv4(),
    roundId: rId,
    senderId: sId,
    targetUserId: tId,
    mode: mode || "5_PLAYER",
    entryAmount: Number(entryAmount) || 100,
    status: "pending",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  spinInvites.set(invite.inviteId, invite);

  return { ok: true, invite };
}

/**
 * Respond to a pending Spin game invite (accept or decline).
 * Validates responder is the invite target and prevents double-handling.
 */
function respondToSpinInvite({ inviteId, roundId, senderId, responderId, accepted }) {
  if (!responderId) {
    return { ok: false, error: "AUTH_FAILED", message: "Unauthorized" };
  }
  const respId = String(responderId);

  let invite = null;
  if (inviteId) {
    invite = spinInvites.get(String(inviteId)) || null;
    if (!invite) {
      return { ok: false, error: "INVITE_NOT_FOUND", message: "Invite not found or expired" };
    }
    if (String(invite.targetUserId) !== respId) {
      return { ok: false, error: "FORBIDDEN_INVITE_RESPONSE", message: "You cannot respond to another player's invite" };
    }
    if (invite.status !== "pending") {
      return { ok: false, error: "INVITE_NOT_PENDING", message: "Invite has already been handled" };
    }
  } else {
    const sId = senderId ? String(senderId) : null;
    const rId = roundId ? String(roundId) : null;
    let latest = null;
    for (const inv of spinInvites.values()) {
      if (inv.status !== "pending") continue;
      if (inv.targetUserId !== respId) continue;
      if (sId && inv.senderId !== sId) continue;
      if (rId && inv.roundId !== rId) continue;
      if (!latest || inv.createdAt >= latest.createdAt) {
        latest = inv;
      }
    }
    invite = latest;
    if (!invite) {
      return { ok: false, error: "INVITE_NOT_FOUND", message: "Invite not found or expired" };
    }
  }

  const isAccepted = Boolean(accepted);
  invite.status = isAccepted ? "accepted" : "declined";
  invite.updatedAt = Date.now();

  if (!isAccepted) {
    const key = rejectionKey(invite.roundId, invite.senderId, invite.targetUserId);
    const rejectionCount = (spinInviteRejections.get(key) || 0) + 1;
    spinInviteRejections.set(key, rejectionCount);
    const blocked = rejectionCount >= MAX_REJECTIONS_PER_ROUND;
    return { ok: true, accepted: false, invite, rejectionCount, blocked };
  }

  const existingCount = getSpinInviteRejectionCount(invite.roundId, invite.senderId, invite.targetUserId);
  return { ok: true, accepted: true, invite, rejectionCount: existingCount, blocked: false };
}

/**
 * Create a round-scoped Spin friend request.
 * Enforces self check, existing friendship check, current-round check,
 * active-game check, duplicate pending check, and 3-rejection limit per roundId.
 */
async function createSpinFriendRequest({ senderId, targetUserId, roundId }) {
  if (!senderId || !targetUserId) {
    return { ok: false, error: "MISSING_TARGET", message: "Missing sender or target user" };
  }
  const sId = String(senderId);
  const tId = String(targetUserId);
  const rId = String(roundId || "global");

  if (sId === tId) {
    return { ok: false, error: "CANNOT_ADD_SELF", message: "Cannot add yourself as a friend" };
  }

  const alreadyFriends = await areUsersFriends(sId, tId);
  if (alreadyFriends) {
    return { ok: false, error: "ALREADY_FRIENDS", message: "You are already friends" };
  }

  if (roundId && isUserInCurrentSpinRound(tId, rId)) {
    return {
      ok: false,
      error: "TARGET_IN_CURRENT_ROUND",
      message: "Player is already in this Spin game",
    };
  }

  const active = await getUserActiveGame(tId);
  if (active.inGame) {
    return {
      ok: false,
      error: "TARGET_IN_ACTIVE_GAME",
      message: "Player is already in an active game",
      activeGameType: active.gameType,
    };
  }

  const rejCount = getSpinFriendRejectionCount(rId, sId, tId);
  if (rejCount >= MAX_REJECTIONS_PER_ROUND) {
    return {
      ok: false,
      error: "FRIEND_REQUEST_BLOCKED_LIMIT_REACHED",
      message: "Friend request limit reached for this player in this Spin room",
      rejectionCount: rejCount,
      blocked: true,
    };
  }

  for (const req of spinFriendRequests.values()) {
    if (req.status === "pending" && req.roundId === rId && req.senderId === sId && req.targetUserId === tId) {
      return {
        ok: false,
        error: "REQUEST_ALREADY_PENDING",
        message: "Friend request already pending",
      };
    }
  }

  const request = {
    requestId: uuidv4(),
    roundId: rId,
    senderId: sId,
    targetUserId: tId,
    status: "pending",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  spinFriendRequests.set(request.requestId, request);

  return { ok: true, request };
}

/**
 * Respond to a pending Spin friend request (accept or decline).
 * Validates responder is the request target and records friendship on acceptance.
 */
async function respondToSpinFriendRequest({ requestId, roundId, senderId, responderId, accepted }) {
  if (!responderId) {
    return { ok: false, error: "AUTH_FAILED", message: "Unauthorized" };
  }
  const respId = String(responderId);

  let request = null;
  if (requestId) {
    request = spinFriendRequests.get(String(requestId)) || null;
    if (!request) {
      return { ok: false, error: "REQUEST_NOT_FOUND", message: "Friend request not found" };
    }
    if (String(request.targetUserId) !== respId) {
      return { ok: false, error: "FORBIDDEN_REQUEST_RESPONSE", message: "You cannot respond to another player's friend request" };
    }
    if (request.status !== "pending") {
      return { ok: false, error: "REQUEST_NOT_PENDING", message: "Friend request has already been handled" };
    }
  } else {
    const sId = senderId ? String(senderId) : null;
    const rId = roundId ? String(roundId) : null;
    let latest = null;
    for (const req of spinFriendRequests.values()) {
      if (req.status !== "pending") continue;
      if (req.targetUserId !== respId) continue;
      if (sId && req.senderId !== sId) continue;
      if (rId && req.roundId !== rId) continue;
      if (!latest || req.createdAt >= latest.createdAt) {
        latest = req;
      }
    }
    request = latest;
    if (!request) {
      return { ok: false, error: "REQUEST_NOT_FOUND", message: "Friend request not found" };
    }
  }

  const isAccepted = Boolean(accepted);
  request.status = isAccepted ? "accepted" : "declined";
  request.updatedAt = Date.now();

  if (isAccepted) {
    await recordFriendship(request.senderId, request.targetUserId, "spin_request");
    const existingCount = getSpinFriendRejectionCount(request.roundId, request.senderId, request.targetUserId);
    return { ok: true, accepted: true, request, rejectionCount: existingCount, blocked: false };
  }

  const key = rejectionKey(request.roundId, request.senderId, request.targetUserId);
  const rejectionCount = (spinFriendRejections.get(key) || 0) + 1;
  spinFriendRejections.set(key, rejectionCount);
  const blocked = rejectionCount >= MAX_REJECTIONS_PER_ROUND;
  return { ok: true, accepted: false, request, rejectionCount, blocked };
}

module.exports = {
  ensureFriendsTable,
  recordFriendship,
  areUsersFriends,
  resolveUserByIdOrUsername,
  getFriendsList,
  searchUsersForFriendship,
  addFriendManual,
  // Spin invite & friend-request state/rules
  MAX_REJECTIONS_PER_ROUND,
  spinInvites,
  spinInviteRejections,
  spinFriendRequests,
  spinFriendRejections,
  getSpinInviteRejectionCount,
  getSpinFriendRejectionCount,
  cleanupSpinRoundInteractions,
  createSpinInvite,
  respondToSpinInvite,
  createSpinFriendRequest,
  respondToSpinFriendRequest,
};
