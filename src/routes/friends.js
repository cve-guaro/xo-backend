// src/routes/friends.js
// ────────────────────────────────────────────────────────────────────────────
// Express routes for Friends management, search, and manual friend additions.
// ────────────────────────────────────────────────────────────────────────────
const express = require("express");
const { auth } = require("../middleware/Auth");
const {
  getFriendsList,
  searchUsersForFriendship,
  addFriendManual,
} = require("../services/friendService");
const { isUserOnline } = require("../socket/game");

const router = express.Router();

/**
 * GET /friends
 * Return user's friends with current online status.
 */
router.get("/", auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const friends = await getFriendsList(userId, isUserOnline);
    return res.json({ ok: true, friends });
  } catch (err) {
    console.error("[FRIENDS_ROUTE] GET / error:", err.message);
    return res.status(500).json({ error: "Failed to fetch friends" });
  }
});

/**
 * GET /friends/search?q=query
 * Search for users, indicating if they are already friends and if online.
 */
router.get("/search", auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const q = req.query.q || "";
    const users = await searchUsersForFriendship(userId, q, isUserOnline);
    return res.json({ ok: true, users });
  } catch (err) {
    console.error("[FRIENDS_ROUTE] GET /search error:", err.message);
    return res.status(500).json({ error: "Search failed" });
  }
});

/**
 * POST /friends/add
 * Body: { friendId, username }
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
