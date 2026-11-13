// src/routes/voice.js
const express = require("express");
const router = express.Router();
const { RtcTokenBuilder, RtcRole } = require("agora-token");
const { auth } = require("../middleware/Auth");

// In-memory counter and rate limiter for unauthenticated requests
let unauthVoiceTokenCount = 0;
const unauthRateLimitMap = new Map(); // ip -> { count, resetTime }

function stringToUid(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  return Math.abs(hash) % 100000000;
}

// Optional / Flagged Auth Middleware
function voiceAuthMiddleware(req, res, next) {
  const requireAuth = process.env.VOICE_REQUIRE_AUTH === "true";
  const authHeader = req.headers.authorization;

  if (authHeader) {
    // If auth header is provided, verify it strictly
    return auth(req, res, next);
  }

  // No auth header provided
  if (requireAuth) {
    return res.status(401).json({ error: "Unauthorized: Voice service requires authentication" });
  }

  // Graceful migration mode: log warning, rate limit by IP
  unauthVoiceTokenCount++;
  const clientIp = req.ip || req.connection?.remoteAddress || "unknown";
  const now = Date.now();
  const windowMs = 60 * 1000; // 1 minute
  const maxRequestsPerWindow = 30;

  const rateData = unauthRateLimitMap.get(clientIp) || { count: 0, resetTime: now + windowMs };
  if (now > rateData.resetTime) {
    rateData.count = 1;
    rateData.resetTime = now + windowMs;
  } else {
    rateData.count++;
  }
  unauthRateLimitMap.set(clientIp, rateData);

  if (rateData.count > maxRequestsPerWindow) {
    return res.status(429).json({ error: "Too many voice token requests from this IP. Please authenticate." });
  }

  if (unauthVoiceTokenCount % 10 === 1) {
    console.warn(`[VOICE_WARN] Unauthenticated voice token requested (total: ${unauthVoiceTokenCount}). Set VOICE_REQUIRE_AUTH=true to enforce.`);
  }

  next();
}

router.post("/token", voiceAuthMiddleware, (req, res) => {
  try {
    const AGORA_APP_ID = process.env.AGORA_APP_ID || process.env.EXPO_PUBLIC_AGORA_APP_ID;
    const AGORA_APP_CERTIFICATE = process.env.AGORA_APP_CERTIFICATE;

    if (!AGORA_APP_ID || !AGORA_APP_CERTIFICATE) {
      const missing = [];
      if (!AGORA_APP_ID) missing.push("AGORA_APP_ID");
      if (!AGORA_APP_CERTIFICATE) missing.push("AGORA_APP_CERTIFICATE");
      console.warn(`[VOICE_API] Service unavailable. Missing configuration: ${missing.join(", ")}`);
      return res.status(503).json({
        error: "Voice service configuration unavailable",
        missing
      });
    }

    const { roomId, uid } = req.body || {};
    if (!roomId || typeof roomId !== "string" || !/^[a-zA-Z0-9_\-]{1,64}$/.test(roomId)) {
      return res.status(400).json({ error: "Missing or invalid roomId (alphanumeric, max 64 chars)" });
    }

    const channelName = String(roomId).startsWith("spin_room_") ? String(roomId) : `spin_room_${roomId}`;

    // Bind uid to authenticated user when available
    let userUid;
    if (req.user && req.user.id) {
      userUid = stringToUid(String(req.user.id));
    } else if (uid !== undefined && uid !== null && uid !== "") {
      userUid = (typeof uid === "number" || !isNaN(Number(uid))) ? Number(uid) : stringToUid(String(uid));
    } else {
      userUid = Math.floor(Math.random() * 1000000) + 1;
    }

    const expirationTimeInSeconds = 3600;
    const currentTimestamp = Math.floor(Date.now() / 1000);
    const privilegeExpiredTs = currentTimestamp + expirationTimeInSeconds;
    const role = RtcRole.PUBLISHER;

    let token = "";
    if (typeof userUid === "number" || !isNaN(Number(userUid))) {
      token = RtcTokenBuilder.buildTokenWithUid(
        AGORA_APP_ID,
        AGORA_APP_CERTIFICATE,
        channelName,
        Number(userUid),
        role,
        privilegeExpiredTs,
        privilegeExpiredTs
      );
    } else {
      token = RtcTokenBuilder.buildTokenWithAccount(
        AGORA_APP_ID,
        AGORA_APP_CERTIFICATE,
        channelName,
        String(userUid),
        role,
        privilegeExpiredTs,
        privilegeExpiredTs
      );
    }

    return res.json({
      token,
      channel: channelName,
      uid: userUid,
      appId: AGORA_APP_ID,
    });
  } catch (err) {
    console.error("[VOICE_API] Token generation error:", err.message);
    return res.status(500).json({ error: "Failed to generate token" });
  }
});

module.exports = router;
