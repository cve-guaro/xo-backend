// src/services/activeGameService.js
// ────────────────────────────────────────────────────────────────────────────
// Unified active-game membership guard across XO, Spin, and RPS.
// Uses provider registration + lazy-require fallback inside functions so there
// are ZERO circular top-level imports with socket/spinRoom.js or socket/game.js.
// ────────────────────────────────────────────────────────────────────────────
const db = require("../db/index");
const RPSRoomManager = require("../games/rps/RPSRoomManager");

const INACTIVE_SPIN_STATUSES = new Set(["resolved", "paid", "cancelled"]);

const providers = {
  getSpinActiveRound: null,
  isUserInCurrentSpinRound: null,
  getXOActiveGame: null,
  getRedisInGame: null,
};

function registerActiveGameProviders(partial = {}) {
  if ("getSpinActiveRound" in partial) {
    providers.getSpinActiveRound = partial.getSpinActiveRound || null;
  }
  if ("isUserInCurrentSpinRound" in partial) {
    providers.isUserInCurrentSpinRound = partial.isUserInCurrentSpinRound || null;
  }
  if ("getXOActiveGame" in partial) {
    providers.getXOActiveGame = partial.getXOActiveGame || null;
  }
  if ("getRedisInGame" in partial) {
    providers.getRedisInGame = partial.getRedisInGame || null;
  }
}

function getSpinModuleLazy() {
  try {
    return require("../socket/spinRoom");
  } catch {
    return null;
  }
}

function getGameModuleLazy() {
  try {
    return require("../socket/game");
  } catch {
    return null;
  }
}

function getSpinRoundForUser(uid) {
  if (typeof providers.getSpinActiveRound === "function") {
    const round = providers.getSpinActiveRound(uid);
    if (round && !INACTIVE_SPIN_STATUSES.has(round.status)) {
      return round;
    }
    return null;
  }

  const spinRoom = getSpinModuleLazy();
  if (!spinRoom) return null;

  if (typeof spinRoom.getUserSpinRound === "function") {
    const round = spinRoom.getUserSpinRound(uid);
    if (round && !INACTIVE_SPIN_STATUSES.has(round.status)) {
      return round;
    }
    return null;
  }

  const rounds = spinRoom.activeSpinRounds;
  if (rounds && typeof rounds.values === "function") {
    for (const round of rounds.values()) {
      if (!round || INACTIVE_SPIN_STATUSES.has(round.status)) continue;
      if (Array.isArray(round.players) && round.players.some((p) => !p.isBot && String(p.userId) === uid)) {
        return round;
      }
    }
  }
  return null;
}

function getXOActiveGameForUser(uid) {
  if (typeof providers.getXOActiveGame === "function") {
    return providers.getXOActiveGame(uid);
  }

  const gameModule = getGameModuleLazy();
  const activeGames = gameModule?.activeGames;
  if (activeGames && typeof activeGames.entries === "function") {
    for (const [matchId, game] of activeGames.entries()) {
      if (!game || game.finished) continue;
      const xId = game.players?.X !== undefined && game.players?.X !== null ? String(game.players.X) : null;
      const oId = game.players?.O !== undefined && game.players?.O !== null ? String(game.players.O) : null;
      if (xId === uid || oId === uid) {
        return { id: game.id || matchId, status: game.status || "live" };
      }
    }
  }
  return null;
}

/**
 * Check if a user is currently seated as an active non-bot player in a specific Spin round.
 */
function isUserInCurrentSpinRound(userId, roundId) {
  if (!userId || !roundId) return false;
  const uid = String(userId);
  const rid = String(roundId);

  if (typeof providers.isUserInCurrentSpinRound === "function") {
    return Boolean(providers.isUserInCurrentSpinRound(uid, rid));
  }

  const spinRoom = getSpinModuleLazy();
  const round = spinRoom?.activeSpinRounds?.get(rid);
  if (!round || INACTIVE_SPIN_STATUSES.has(round.status)) return false;
  return Array.isArray(round.players) && round.players.some((p) => !p.isBot && String(p.userId) === uid);
}

/**
 * Determine whether a user is in any active game across Spin, RPS, or XO.
 * Returns { inGame: boolean, gameType?: 'xo' | 'spin' | 'rps', roomId?: string, status?: string }.
 */
async function getUserActiveGame(userId) {
  if (!userId) return { inGame: false };
  const uid = String(userId);

  // 1. Check Spin (authoritative in-memory activeSpinRounds)
  const spinRound = getSpinRoundForUser(uid);
  if (spinRound) {
    return {
      inGame: true,
      gameType: "spin",
      roomId: String(spinRound.id),
      status: spinRound.status,
    };
  }

  // 2. Check RPS (authoritative in-memory RPSRoomManager: room + matchmaking queue)
  const rawRoomOrBool = typeof RPSRoomManager.getPlayerRoomId === "function"
    ? RPSRoomManager.getPlayerRoomId(uid)
    : (typeof RPSRoomManager.isPlayerInGame === "function" ? RPSRoomManager.isPlayerInGame(uid) : null);
  const resolvedRpsRoomId = typeof rawRoomOrBool === "string" ? rawRoomOrBool : null;
  const inRps = Boolean(resolvedRpsRoomId) || Boolean(
    typeof RPSRoomManager.isPlayerInGame === "function" && RPSRoomManager.isPlayerInGame(uid)
  );
  if (inRps) {
    const rpsGame = resolvedRpsRoomId && typeof RPSRoomManager.getRoom === "function"
      ? RPSRoomManager.getRoom(resolvedRpsRoomId)
      : null;
    return {
      inGame: true,
      gameType: "rps",
      ...(resolvedRpsRoomId ? { roomId: resolvedRpsRoomId } : {}),
      status: rpsGame?.status || (resolvedRpsRoomId ? "active" : "queued"),
    };
  }

  // 3. Check XO in-memory activeGames
  const xoGame = getXOActiveGameForUser(uid);
  if (xoGame) {
    return {
      inGame: true,
      gameType: "xo",
      roomId: String(xoGame.id),
      status: xoGame.status || "live",
    };
  }

  // 4. Secondary check: Redis in_game:${uid} (used by XO results screen and cross-check)
  const redisVal = typeof providers.getRedisInGame === "function"
    ? await Promise.resolve(providers.getRedisInGame(uid)).catch(() => null)
    : await db.redis?.get?.(`in_game:${uid}`).catch(() => null);
  if (redisVal) {
    const valStr = String(redisVal);

    // Do NOT falsely treat RPS keys as XO
    if (valStr === "rps" || valStr.startsWith("rps_")) {
      if (valStr.startsWith("rps_") && typeof RPSRoomManager.getRoom === "function") {
        const room = RPSRoomManager.getRoom(valStr);
        if (
          room &&
          !room.finished &&
          (String(room.player1Id) === uid || String(room.player2Id) === uid)
        ) {
          return {
            inGame: true,
            gameType: "rps",
            roomId: valStr,
            status: room.status || "active",
          };
        }
      }
      return { inGame: false };
    }

    // Do NOT falsely treat Spin keys as XO
    if (valStr === "spin" || valStr.startsWith("spin_")) {
      return { inGame: false };
    }

    // XO matchId stored in Redis (e.g. player on XO results screen before leave_room)
    return {
      inGame: true,
      gameType: "xo",
      roomId: valStr,
      status: "active",
    };
  }

  return { inGame: false };
}

module.exports = {
  getUserActiveGame,
  isUserInCurrentSpinRound,
  registerActiveGameProviders,
};
