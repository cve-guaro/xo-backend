// src/routes/voice.js
const express = require("express");
const router = express.Router();
const { RtcTokenBuilder, RtcRole } = require("agora-token");

const AGORA_APP_ID = process.env.AGORA_APP_ID || "ba52d09d3e204851af7ddbe4340b38a2";
const AGORA_APP_CERTIFICATE = process.env.AGORA_APP_CERTIFICATE || "a03d64c32c0b4e49b0a5e22511b71a97";

router.post("/token", (req, res) => {
  try {
    const { roomId, uid } = req.body || {};
    if (!roomId) {
      return res.status(400).json({ error: "Missing roomId" });
    }

    const channelName = String(roomId).startsWith("spin_room_") ? String(roomId) : `spin_room_${roomId}`;
    const userUid = uid || Math.floor(Math.random() * 1000000);
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
