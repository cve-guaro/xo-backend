// src/routes/voice.js
const express = require("express");
const router = express.Router();
const { RtcTokenBuilder, RtcRole } = require("agora-token");
const { auth } = require("../middleware/Auth");

// In-memory counter and rate limiter for unauthenticated requests
let unauthVoiceTokenCount = 0;
const unauthRateLimitMap = new Map(); // ip -> { count, resetTime }

const VALID_GAME_TYPES = new Set(["spin", "xo", "rps"]);
const CHANNEL_NAME_REGEX = /^[a-zA-Z0-9_\-]{1,64}$/;
const ALLOWLISTED_PREFIXES = ["spin_room_", "xo_room_", "xo_", "rps_room_"];

function stringToUid(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  return Math.abs(hash) % 100000000;
}

/**
 * Resolve and validate the Agora channel name across Spin, XO, and RPS.
 * Returns { channelName } on success or { error } on validation failure.
 */
function resolveVoiceChannel({ channelName, roomId, gameType } = {}) {
  let normType = null;
  if (gameType !== undefined && gameType !== null && gameType !== "") {
    if (typeof gameType !== "string") {
      return { error: "Invalid gameType (must be spin, xo, or rps)" };
    }
    normType = gameType.trim().toLowerCase();
    if (!VALID_GAME_TYPES.has(normType)) {
      return { error: "Invalid gameType (must be spin, xo, or rps)" };
    }
  }

  let resolved = null;

  if (channelName !== undefined && channelName !== null && channelName !== "") {
    if (typeof channelName !== "string") {
      return { error: "Invalid channelName" };
    }
    const trimmed = channelName.trim();
    if (!trimmed) {
      return { error: "Missing or invalid channelName" };
    }
    resolved = trimmed;
  } else if (roomId !== undefined && roomId !== null && roomId !== "") {
    if (typeof roomId !== "string") {
      return { error: "Missing or invalid roomId" };
    }
    const trimmedRoom = roomId.trim();
    if (!trimmedRoom) {
      return { error: "Missing or invalid roomId" };
    }

    if (ALLOWLISTED_PREFIXES.some((prefix) => trimmedRoom.startsWith(prefix))) {
      resolved = trimmedRoom;
    } else if (normType === "xo") {
      resolved = `xo_room_${trimmedRoom}`;
    } else if (normType === "rps") {
      resolved = `rps_room_${trimmedRoom}`;
    } else {
      resolved = `spin_room_${trimmedRoom}`;
    }
  } else {
    return { error: "Missing channelName or roomId" };
  }

  if (!CHANNEL_NAME_REGEX.test(resolved)) {
    return {
      error: "Invalid channelName or roomId (alphanumeric, underscore, hyphen only, max 64 chars)",
    };
  }

  return { channelName: resolved };
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

    const { channelName: rawChannelName, roomId, uid, gameType } = req.body || {};
    const channelResult = resolveVoiceChannel({
      channelName: rawChannelName,
      roomId,
      gameType,
    });
    if (channelResult.error) {
      return res.status(400).json({ error: channelResult.error });
    }
    const channelName = channelResult.channelName;

    // Bind uid to authenticated user when available; validate cleanly when unauthenticated
    let userUid;
    if (req.user && req.user.id) {
      userUid = stringToUid(String(req.user.id));
    } else if (uid !== undefined && uid !== null && uid !== "") {
      if (typeof uid === "number") {
        if (!Number.isInteger(uid) || uid < 0 || uid > 0xffffffff) {
          return res.status(400).json({ error: "Invalid uid (must be a non-negative integer)" });
        }
        userUid = uid;
      } else if (typeof uid === "string" && /^\d+$/.test(uid.trim())) {
        const parsed = Number(uid.trim());
        if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 0xffffffff) {
          return res.status(400).json({ error: "Invalid uid (must be a non-negative integer)" });
        }
        userUid = parsed;
      } else {
        return res.status(400).json({ error: "Invalid uid (must be a non-negative integer)" });
      }
    } else {
      userUid = Math.floor(Math.random() * 1000000) + 1;
    }

    const expirationTimeInSeconds = 3600;
    const currentTimestamp = Math.floor(Date.now() / 1000);
    const privilegeExpiredTs = currentTimestamp + expirationTimeInSeconds;
    const role = RtcRole.PUBLISHER;

    const token = RtcTokenBuilder.buildTokenWithUid(
      AGORA_APP_ID,
      AGORA_APP_CERTIFICATE,
      channelName,
      Number(userUid),
      role,
      privilegeExpiredTs,
      privilegeExpiredTs
    );

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

router.resolveVoiceChannel = resolveVoiceChannel;
router.stringToUid = stringToUid;

module.exports = router;
