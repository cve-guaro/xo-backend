// src/routes/friends.js
// ────────────────────────────────────────────────────────────────────────────
// Express routes for Friends management, search, Spin friend requests,
// and manual friend additions.
// ────────────────────────────────────────────────────────────────────────────
const express = require("express");
const { auth } = require("../middleware/Auth");
const { pool } = require("../db/index");
const {
  getFriendsList,
  searchUsersForFriendship,
  addFriendManual,
  resolveUserByIdOrUsername,
  createSpinFriendRequest,
  respondToSpinFriendRequest,
} = require("../services/friendService");
const { getUserActiveGame } = require("../services/activeGameService");
const { isUserOnline, emitToUserEvent } = require("../socket/game");

const router = express.Router();

function emitToUserSafe(req, targetUserId, event, payload) {
  const uid = String(targetUserId);
  const io = req.app?.get?.("io");
  if (io && typeof io.to === "function") {
    io.to(`user:${uid}`).emit(event, payload);
  }
  emitToUserEvent?.(uid, event, payload);
}

/**
 * GET /friends?roundId=<id>
 * Return user's friends with current online status, active-game status,
 * and round-scoped Spin invite/friend-request counters.
 */
router.get("/", auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const roundId = req.query?.roundId ? String(req.query.roundId) : undefined;
    const friends = await getFriendsList(userId, isUserOnline, { roundId });
    return res.json({ ok: true, friends });
  } catch (err) {
    console.error("[FRIENDS_ROUTE] GET / error:", err.message);
    return res.status(500).json({ error: "Failed to fetch friends" });
  }
});

/**
 * GET /friends/search?q=query&roundId=<id>
 * Search for users, indicating if they are already friends, online, in-game,
 * and round-scoped Spin invite/friend-request flags.
 */
router.get("/search", auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const q = req.query.q || "";
    const roundId = req.query?.roundId ? String(req.query.roundId) : undefined;
    const users = await searchUsersForFriendship(userId, q, isUserOnline, { roundId });
    return res.json({ ok: true, users });
  } catch (err) {
    console.error("[FRIENDS_ROUTE] GET /search error:", err.message);
    return res.status(500).json({ error: "Search failed" });
  }
});

/**
 * POST /friends/request
 * Body: { targetUserId | friendId | username, roundId? }
 * Creates a pending friend request enforcing active-game and 3-rejection rules.
 */
router.post("/request", auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { targetUserId, friendId, username, roundId } = req.body || {};
    const targetInput = targetUserId || friendId || username;
    if (!targetInput) {
      return res.status(400).json({ ok: false, error: "MISSING_TARGET", message: "targetUserId, friendId, or username required" });
    }

    const target = await resolveUserByIdOrUsername(targetInput);
    if (!target) {
      return res.status(404).json({ ok: false, error: "USER_NOT_FOUND", message: "User not found" });
    }

    let effectiveRoundId = roundId ? String(roundId) : undefined;
    if (!effectiveRoundId) {
      const senderActive = await getUserActiveGame(userId);
      if (senderActive.inGame && senderActive.gameType === "spin" && senderActive.roomId) {
        effectiveRoundId = String(senderActive.roomId);
      }
    }

    const result = await createSpinFriendRequest({
      senderId: userId,
      targetUserId: target.id,
      roundId: effectiveRoundId,
    });

    if (!result.ok) {
      const status =
        result.error === "CANNOT_ADD_SELF" ? 400 :
        result.error === "FRIEND_REQUEST_BLOCKED_LIMIT_REACHED" ? 429 :
        409;
      return res.status(status).json(result);
    }

    // Notify target user in real time if online
    const senderRes = await pool
      .query(`SELECT username, display_name FROM users WHERE id = $1`, [userId])
      .catch(() => ({ rows: [] }));
    const fromUsername = senderRes.rows[0]?.display_name || senderRes.rows[0]?.username || "Player";

    if (isUserOnline(target.id) || req.app?.get?.("io")?.sockets?.adapter?.rooms?.get(`user:${target.id}`)?.size > 0) {
      emitToUserSafe(req, target.id, "spin:friend_request_received", {
        requestId: result.request.requestId,
        roundId: result.request.roundId,
        fromUserId: String(userId),
        fromUsername,
        timestamp: Date.now(),
      });
    }

    return res.json({ ok: true, request: result.request });
  } catch (err) {
    console.error("[FRIENDS_ROUTE] POST /request error:", err.message);
    return res.status(500).json({ ok: false, error: "REQUEST_FAILED", message: "Failed to send friend request" });
  }
});

/**
 * POST /friends/respond
 * Body: { requestId?, senderId?, roundId?, accepted }
 * Accepts (creates mutual friendship) or declines (increments 3-rejection counter).
 */
router.post("/respond", auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { requestId, senderId, roundId, accepted, accept } = req.body || {};
    const rawAccepted = accepted !== undefined ? accepted : accept;

    if (typeof rawAccepted !== "boolean") {
      return res.status(400).json({ ok: false, error: "INVALID_ACCEPTED", message: "accepted boolean is required" });
    }

    const result = await respondToSpinFriendRequest({
      requestId,
      roundId: roundId ? String(roundId) : undefined,
      senderId,
      responderId: userId,
      accepted: rawAccepted,
    });

    if (!result.ok) {
      const status =
        result.error === "REQUEST_NOT_FOUND" ? 404 :
        result.error === "FORBIDDEN_REQUEST_RESPONSE" ? 403 :
        409;
      return res.status(status).json(result);
    }

    const responderRes = await pool
      .query(`SELECT username, display_name FROM users WHERE id = $1`, [userId])
      .catch(() => ({ rows: [] }));
    const byUsername = responderRes.rows[0]?.display_name || responderRes.rows[0]?.username || "Player";

    const eventName = result.accepted ? "spin:friend_request_accepted" : "spin:friend_request_declined";
    emitToUserSafe(req, result.request.senderId, eventName, {
      requestId: result.request.requestId,
      roundId: result.request.roundId,
      targetUserId: String(userId),
      byUsername,
      ...(result.accepted ? {} : { rejectionCount: result.rejectionCount, blocked: result.blocked }),
    });

    return res.json({
      ok: true,
      accepted: result.accepted,
      rejectionCount: result.rejectionCount,
      blocked: result.blocked,
      requestId: result.request.requestId,
      roundId: result.request.roundId,
    });
  } catch (err) {
    console.error("[FRIENDS_ROUTE] POST /respond error:", err.message);
    return res.status(500).json({ ok: false, error: "RESPOND_FAILED", message: "Failed to respond to friend request" });
  }
});

/**
 * POST /friends/add
 * Body: { friendId, username }
 * Preserved intact for XO RoomSheet backwards compatibility.
 */
router.post("/add", auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { friendId, username } = req.body || {};
    const target = friendId || username;
    if (!target) {
      return res.status(400).json({ error: "friendId or username required" });
    }

    const friend = await addFriendManual(userId, target, isUserOnline);
    return res.json({ ok: true, friend });
  } catch (err) {
    if (err.message === "USER_NOT_FOUND") {
      return res.status(404).json({ error: "User not found" });
    }
    if (err.message === "CANNOT_ADD_SELF") {
      return res.status(400).json({ error: "Cannot add yourself as a friend" });
    }
    console.error("[FRIENDS_ROUTE] POST /add error:", err.message);
    return res.status(500).json({ error: "Failed to add friend" });
  }
});

module.exports = router;
