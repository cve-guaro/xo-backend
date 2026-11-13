/**
 * RPSRoomManager.js — Room lifecycle and matchmaking for RPS.
 *
 * Responsibilities:
 * - In-memory map of active RPS matches (roomId → game state)
 * - Player-to-room index (prevents double-joining)
 * - Queue-based matchmaking by bet tier
 * - Room creation, joining, and cleanup
 *
 * No database writes here — the socket handler calls wallet/DB primitives.
 */

const { v4: uuidv4 } = require('uuid');
const { createGame, VALID_BETS, BET_TIERS, STATUSES } = require('./RPSGame');

const LOG_PREFIX = '[RPS_ROOM]';

// ── In-memory state ──────────────────────────────────────────────────────
// activeRooms: Map<roomId, game>
const activeRooms = new Map();

// playerToRoom: Map<userId, roomId> — prevents double-joining
const playerToRoom = new Map();

// matchmakingQueues: Map<stakeAmount, Array<{ userId, socketId, joinedAt }>>
const matchmakingQueues = new Map();

// Initialize a queue for each tier
for (const tier of BET_TIERS) {
  matchmakingQueues.set(tier, []);
}

// ── Room lifecycle ───────────────────────────────────────────────────────

/**
 * isPlayerInGame(userId) → roomId | null
 */
function isPlayerInGame(userId) {
  const uid = String(userId);
  const roomId = playerToRoom.get(uid);
  if (!roomId) return null;
  // Verify the room still exists and is active
  const game = activeRooms.get(roomId);
  if (!game || game.finished) {
    playerToRoom.delete(uid);
    return null;
  }
  return roomId;
}

/**
 * createRoom(player1Id, stakeAmount) → game
 * Creates a room waiting for player 2.
 */
function createRoom(player1Id, stakeAmount) {
  const uid = String(player1Id);
  if (isPlayerInGame(uid)) {
    throw new Error('ALREADY_IN_GAME');
  }

  const roomId = `rps_${uuidv4().slice(0, 12)}`;
  const game = createGame({
    roomId,
    player1Id: uid,
    player2Id: null,
    stakeAmount,
  });

  activeRooms.set(roomId, game);
  playerToRoom.set(uid, roomId);
  console.log(`${LOG_PREFIX} Room created: ${roomId} by ${uid} stake=${stakeAmount}`);

  return game;
}

/**
 * joinRoom(roomId, player2Id) → game
 * Player 2 joins an existing waiting room.
 */
function joinRoom(roomId, player2Id) {
  const uid = String(player2Id);
  if (isPlayerInGame(uid)) {
    throw new Error('ALREADY_IN_GAME');
  }

  const game = activeRooms.get(roomId);
  if (!game) throw new Error('ROOM_NOT_FOUND');
  if (game.status !== STATUSES.WAITING) throw new Error('ROOM_NOT_WAITING');
  if (game.player2Id) throw new Error('ROOM_FULL');
  if (String(game.player1Id) === uid) throw new Error('CANNOT_JOIN_OWN_ROOM');

  game.player2Id = uid;
  playerToRoom.set(uid, roomId);
  console.log(`${LOG_PREFIX} Player ${uid} joined room ${roomId}`);

  return game;
}

/**
 * getRoom(roomId) → game | undefined
 */
function getRoom(roomId) {
  return activeRooms.get(roomId);
}

/**
 * getPlayerGame(userId) → game | null
 */
function getPlayerGame(userId) {
  const roomId = isPlayerInGame(String(userId));
  if (!roomId) return null;
  return activeRooms.get(roomId) || null;
}

/**
 * cleanupRoom(roomId)
 * Remove room from active maps after it's finished.
 */
function cleanupRoom(roomId) {
  const game = activeRooms.get(roomId);
  if (!game) return;

  playerToRoom.delete(String(game.player1Id));
  if (game.player2Id) playerToRoom.delete(String(game.player2Id));
  activeRooms.delete(roomId);
  console.log(`${LOG_PREFIX} Room cleaned up: ${roomId}`);
}

// ── Matchmaking ──────────────────────────────────────────────────────────

/**
 * enqueue(userId, socketId, stakeAmount) → { matched, game } | { matched, position }
 *
 * If another player is already waiting for the same tier, match them immediately.
 * Otherwise, add to queue and return position.
 */
function enqueue(userId, socketId, stakeAmount) {
  const uid = String(userId);
  const stake = Math.round(Number(stakeAmount));

  if (!VALID_BETS.has(stake)) {
    throw new Error(`INVALID_BET: ${stake} is not in [${BET_TIERS.join(', ')}]`);
  }

  if (isPlayerInGame(uid)) {
    throw new Error('ALREADY_IN_GAME');
  }

  // Remove from any existing queue (prevents double-queueing)
  dequeue(uid);

  const queue = matchmakingQueues.get(stake);

  // Prune stale entries (disconnected players)
  while (queue.length > 0) {
    const head = queue[0];
    // Stale check: if entry is older than 2 minutes, remove
    if (Date.now() - head.joinedAt > 120_000) {
      queue.shift();
      continue;
    }
    // Don't match with yourself
    if (head.userId === uid) {
      queue.shift();
      continue;
    }
    break;
  }

  // Try to match with head of queue
  if (queue.length > 0) {
    const opponent = queue.shift();

    // Create room with opponent as P1, this player as P2
    const game = createRoom(opponent.userId, stake);
    joinRoom(game.roomId, uid);

    console.log(`${LOG_PREFIX} Matched: ${opponent.userId} vs ${uid} stake=${stake}`);
    return { matched: true, game, opponentSocketId: opponent.socketId };
  }

  // No match — enqueue
  queue.push({ userId: uid, socketId, joinedAt: Date.now() });
  console.log(`${LOG_PREFIX} Enqueued: ${uid} stake=${stake} position=${queue.length}`);
  return { matched: false, position: queue.length };
}

/**
 * dequeue(userId) → boolean
 * Remove a player from all matchmaking queues.
 */
function dequeue(userId) {
  const uid = String(userId);
  let removed = false;
  for (const [tier, queue] of matchmakingQueues) {
    const idx = queue.findIndex(e => e.userId === uid);
    if (idx !== -1) {
      queue.splice(idx, 1);
      removed = true;
      console.log(`${LOG_PREFIX} Dequeued: ${uid} from tier ${tier}`);
    }
  }
  return removed;
}

/**
 * getQueueSizes() → { [tier]: count }
 */
function getQueueSizes() {
  const sizes = {};
  for (const [tier, queue] of matchmakingQueues) {
    sizes[tier] = queue.length;
  }
  return sizes;
}

/**
 * getActiveRoomCount() → number
 */
function getActiveRoomCount() {
  return activeRooms.size;
}

/**
 * getActiveRooms() → Array<{ roomId, stake, p1, p2, status, phase }>
 */
function listActiveRooms() {
  const rooms = [];
  for (const [roomId, game] of activeRooms) {
    rooms.push({
      roomId,
      stake: game.stakeAmount,
      player1: game.player1Id,
      player2: game.player2Id,
      status: game.status,
      phase: game.phase,
      scoreP1: game.scoreP1,
      scoreP2: game.scoreP2,
      createdAt: game.createdAt,
    });
  }
  return rooms;
}

module.exports = {
  activeRooms,
  playerToRoom,
  isPlayerInGame,
  createRoom,
  joinRoom,
  getRoom,
  getPlayerGame,
  cleanupRoom,
  enqueue,
  dequeue,
  getQueueSizes,
  getActiveRoomCount,
  listActiveRooms,
};
