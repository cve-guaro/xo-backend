// gameSocket.js
const { v4: uuidv4 } = require("uuid");
const jwt = require("jsonwebtoken");
const { pool } = require("../db/index");
const Redis = require("ioredis");
require('dotenv').config();
const { creditPrize } = require('../models/payments.service')

// ---- Debug helpers -------------------------------------------------
const DEBUG_MATCH = process.env.DEBUG_MATCH === "1" || process.env.NODE_ENV !== "production";
const shortId = () => uuidv4().slice(0, 8);
const ts = () => new Date().toISOString();
function dbg(ctx, ...args) { if (DEBUG_MATCH) console.log(`[MM ${ts()}] ${ctx}`, ...args); }
function logAlways(ctx, ...args) { console.log(`[MM ${ts()}] ${ctx}`, ...args); }
function emitDebug(socket, event, payload) { try { if (DEBUG_MATCH) socket.emit("debug", { event, payload, ts: ts() }); } catch { } }

const JWT_SECRET = process.env.JWT_SECRET || "supersecret";
const redis = new Redis(process.env.REDIS_URL || "redis://127.0.0.1:6379");
const QUEUE_TTL = 120_000; // 2 minutes

const REMATCH_NS = "rematch";
const REMATCH_TTL = 30_000; // 30s to respond (tweak as you like)

// ---- Room configuration --------------------------------------------
const ROOMS_CONFIG = {
  1: {
    name: "Room 1 - Beginner",
    betRange: [10, 25, 50, 99], // Valid bet amounts for this room
    houseCutPercent: 10, // 10% cut
    timerDuration: 30, // 30 seconds per turn
    description: "Small bets - 20% total (10% each) - 30s timer"
  },
  2: {
    name: "Room 2 - Intermediate",
    betRange: [100, 250, 500, 999], // Valid bet amounts for this room
    houseCutPercent: 10, // 10% cut
    timerDuration: 30, // 30 seconds per turn
    description: "Medium bets - 20% total (10% each) - 30s timer"
  },
  3: {
    name: "Room 3 - Advanced",
    betRange: [1000, 2500, 5000, 7500, 10000], // Base bet amounts
    houseCutPercent: 10, // 10% cut
    timerDuration: 30, // 30 seconds per turn
    description: "Large bets - 20% total (10% each) - 30s timer"
  }
};

// ---- Helper to determine room based on bet amount ------------------
function determineRoomByBetAmount(betAmount) {
  const amount = Number(betAmount);

  // Check Room 1 first
  if (ROOMS_CONFIG[1].betRange.includes(amount)) {
    return 1;
  }

  // Check Room 2
  if (ROOMS_CONFIG[2].betRange.includes(amount)) {
    return 2;
  }

  // Check Room 3
  if (ROOMS_CONFIG[3].betRange.includes(amount)) {
    return 3;
  }

  // For Room 3, check if amount is 10000 or more
  if (amount >= 10000) {
    return 3;
  }

  // If no match found, return null
  return null;
}

// ---- Modified calculatePrize function with room-based cuts ---------
function calculatePrize(betAmount) {
  const totalPot = betAmount * 2;

  // Determine which room this bet belongs to
  const betBirr = Number(betAmount);
  const roomNumber = determineRoomByBetAmount(betBirr);

  if (!roomNumber) {
    // Fallback to original tiered logic if room not found
    const HOUSE_FEE_THRESHOLD = Number(process.env.HOUSE_FEE_THRESHOLD || 50);
    const HOUSE_FEE_LOW_PERCENT = Number(process.env.HOUSE_FEE_LOW_PERCENT || 20);
    const HOUSE_FEE_HIGH_PERCENT = Number(process.env.HOUSE_FEE_HIGH_PERCENT || 10);

    let pct = betAmount < HOUSE_FEE_THRESHOLD ? HOUSE_FEE_LOW_PERCENT : HOUSE_FEE_HIGH_PERCENT;
    pct = Math.max(0, Math.min(100, pct));

    const prize = Math.floor(totalPot * (1 - pct / 100));
    return { prize, totalPot, feePercent: pct, room: null };
  }

  // Use room-specific cut
  const roomConfig = ROOMS_CONFIG[roomNumber];
  const pct = roomConfig.houseCutPercent;
  const prize = Math.floor(totalPot * (1 - pct / 100));

  console.log(`[FINANCE] calculatePrize: room=${roomNumber} bet=${betAmount} pot=${totalPot} pct=${pct} prize=${prize}`);

  return {
    prize,
    totalPot,
    feePercent: pct,
    room: roomNumber,
    roomName: roomConfig.name,
    timerDuration: roomConfig.timerDuration
  };
}

// ---- Modified to get timer duration from room config ---------------
function getInitialTimerForBetAmount(betAmount) {
  const roomNumber = determineRoomByBetAmount(betAmount);
  if (roomNumber && ROOMS_CONFIG[roomNumber]) {
    return ROOMS_CONFIG[roomNumber].timerDuration;
  }

  // Fallback to default
  return 30;
}

// In-memory state
const queueTimers = new Map();        // socket.id -> timeoutId
const activeGames = new Map();        // matchId -> game
const socketSearching = new Map();    // socket.id -> queueKey

const BOARD_SIZE = 9;
const INITIAL_BOARD = Array(BOARD_SIZE).fill("_");
const WINNING_COMBINATIONS = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
];
const RECONNECT_GRACE = 10_000; // 10 sec
const MM_QUEUES_SET = "mm:queues";

function opposite(s) { return s === "X" ? "O" : "X"; }
// helpers (top of file)
const userRoom = (uid) => `user:${uid}`;

function rememberUserSocket(socket, userId) {
  socket.data = { ...(socket.data || {}), userId };
  try { socket.join(userRoom(userId)); } catch { }
}

// === REMATCH: light user index (online sockets by userId) ===========
function rematchOfferKey(u1, u2) {
  const a = String(u1), b = String(u2);
  const [x, y] = a < b ? [a, b] : [b, a];
  return `${REMATCH_NS}:offer:${x}:${y}`;
}

function rematchLockKey(u1, u2) {
  const a = String(u1), b = String(u2);
  const [x, y] = a < b ? [a, b] : [b, a];
  return `${REMATCH_NS}:lock:${x}:${y}`;
}
async function clearRematchOffer(u1, u2) {
  await redis.del(rematchOfferKey(u1, u2));
}

const userSockets = new Map(); // userId -> Set<socket.id>
function addUserSocket(userId, socket) {
  if (!userId) return;
  if (!userSockets.has(userId)) userSockets.set(userId, new Set());
  userSockets.get(userId).add(socket.id);
}
function removeUserSocket(userId, socketId) {
  if (!userId) return;
  const set = userSockets.get(userId);
  if (!set) return;
  set.delete(socketId);
  if (!set.size) userSockets.delete(userId);
}

function findSocketByUser(io, userId) {
  for (const s of io.sockets.sockets.values()) {
    if (s?.data?.userId && String(s.data.userId) === String(userId)) return s;
  }
  return null;
}
function emitToUser(io, userId, event, payload) {
  const roomName = userRoom(userId);
  const uid = String(userId);
  let delivered = 0;
  
  // PRIMARY: Scan ALL connected sockets and emit directly to every socket belonging to this user
  // This is the most reliable method — doesn't depend on room join working correctly
  for (const [socketId, socket] of io.sockets.sockets) {
    const sockUserId = socket.data?.userId;
    if (sockUserId && String(sockUserId) === uid) {
      socket.emit(event, payload);
      delivered++;
      // Also ensure they're in their room for future emits
      try { socket.join(roomName); } catch {}
    }
  }
  
  // SECONDARY: Also emit to the room in case we missed any (e.g. Redis adapter cross-node)
  const room = io.sockets.adapter.rooms.get(roomName);
  const roomSize = room ? room.size : 0;
  if (roomSize > 0) {
    io.to(roomName).emit(event, payload);
  }
  
  console.log(`[EMIT] '${event}' → user ${userId} | direct_sockets=${delivered} | room_size=${roomSize}`);
  if (delivered === 0 && roomSize === 0) {
    console.log(`[EMIT] ❌ No socket found for user ${userId} — they may be offline`);
  }
}

// === REMATCH: helpers ===============================================
function pairKey(u1, u2) {
  // stable ordering
  const [a, b] = String(u1) < String(u2) ? [String(u1), String(u2)] : [String(u2), String(u1)];
  return `${REMATCH_NS}:pair:${a}:${b}`;
}

async function getRematchOffer(u1, u2) {
  const key = pairKey(u1, u2);
  console.log(key);
  const raw = await redis.get(key);
  return raw ? JSON.parse(raw) : null;
}
async function putRematchOffer(u1, u2, offer) {
  console.log("putRematchOffer called for u1:", u1, " u2:", u2, " offer:", offer);
  const key = pairKey(u1, u2);
  console.log(key);
  await redis.set(key, JSON.stringify(offer), "PX", REMATCH_TTL);
  return key;
}
async function delRematchOffer(u1, u2) {
  const key = pairKey(u1, u2);
  await redis.del(key);
}
/**
 * Acquire a lock and run `fn`. Returns true if `fn` ran, false otherwise.
 * Guarantees resolve/reject; never hangs.
 */
async function withRematchLock(userA, userB, ttlMs, fn) {
  const key = rematchLockKey(userA, userB);
  const token = uuidv4();

  // 1) Try to acquire
  let setRes;
  try {
    setRes = await redis.set(key, token, "NX", "PX", ttlMs); // ioredis: "OK" or null
  } catch (e) {
    console.error("[LOCK] SET failed", { key, err: e?.message });
    return false;
  }
  if (setRes !== "OK") {
    // Someone else holds the lock
    return false;
  }

  let ran = false;
  try {
    // 2) Run the critical section (ensure we await it!)
    await fn();
    ran = true;
  } catch (e) {
    console.error("[LOCK] fn error", { key, err: e?.message });
  } finally {
    // 3) Release (Lua compare-and-del)
    try {
      const lua = `
        if redis.call('get', KEYS[1]) == ARGV[1] then
          return redis.call('del', KEYS[1])
        else
          return 0
        end`;
      await redis.eval(lua, 1, key, token);
    } catch (e) {
      // If EVAL isn't allowed, we at least let TTL expire.
      console.warn("[LOCK] release failed, will expire by TTL", { key, err: e?.message });
    }
  }

  return ran;
}

// ---------------- DB Tx helper ----------------
async function tx(fn) {
  const client = await pool.connect();
  try { await client.query("BEGIN"); const res = await fn(client); await client.query("COMMIT"); return res; }
  catch (e) { try { await client.query("ROLLBACK"); } catch { } throw e; }
  finally { client.release(); }
}

// ---------------- Queue helpers ----------------
async function removeFromQueue(queueKey, userId) {
  const items = await redis.lrange(queueKey, 0, -1);
  for (const raw of items) {
    try {
      const entry = JSON.parse(raw);
      if (entry.userId === userId) {
        await redis.lrem(queueKey, 1, raw);
        return true;
      }
    } catch { }
  }
  return false;
}

async function startDirectMatch(io, userA, userB, betAmount) {
  const sA = findSocketByUser(io, userA);
  const sB = findSocketByUser(io, userB);
  if (!sA || !sB) throw new Error(`OPPONENT_OFFLINE:${!sA ? userA : userB}`);

  // Stamp identities & user rooms defensively
  rememberUserSocket(sA, userA);
  rememberUserSocket(sB, userB);

  // Randomize roles
  const X = Math.random() < 0.5 ? userA : userB;
  const O = X === userA ? userB : userA;

  const matchId = uuidv4();
  await lockAndStartMatch(matchId, X, O, betAmount);

  // Map the right socket for each userId (don't rely on old socket.data)
  const sockets = {
    X: String(userA) === String(X) ? sA : sB,
    O: String(userA) === String(O) ? sA : sB,
  };

  // Get room configuration based on bet amount
  const roomNumber = determineRoomByBetAmount(betAmount);
  const initialTimer = roomNumber ? ROOMS_CONFIG[roomNumber].timerDuration : 30;

  const game = {
    id: matchId,
    board: Array(9).fill("_"),
    turn: "X",
    players: { X, O },
    sockets,
    timers: { X: initialTimer, O: initialTimer },
    betAmount,
    room: roomNumber,
    timerInterval: null,
    reconnectTimeout: null,
    startTimeout: null,
    status: "countdown",
  };
  activeGames.set(matchId, game);

  // Tag and join room for timers / in-game events
  sockets.X.data = { ...(sockets.X.data || {}), matchId, userId: X, symbol: "X" };
  sockets.O.data = { ...(sockets.O.data || {}), matchId, userId: O, symbol: "O" };
  sockets.X.join(matchId);
  sockets.O.join(matchId);

  await redis.set(`in_game:${X}`, matchId, "PX", QUEUE_TTL * 10).catch(() => { });
  await redis.set(`in_game:${O}`, matchId, "PX", QUEUE_TTL * 10).catch(() => { });

  const usersRes = await pool.query(`SELECT id, username FROM users WHERE id = ANY($1::uuid[])`, [[X, O]]);
  const userMap = {};
  for (const r of usersRes.rows) userMap[r.id] = r.username;
  const nameX = userMap[X] || "Player X";
  const nameO = userMap[O] || "Player O";

  const payloadX = {
    matchId,
    youAre: "X",
    symbol: "X",
    opponentId: O,
    opponentUsername: nameO,
    opponentSymbol: "O",
    players: { X, O },
    betAmount,
    room: roomNumber,
    roomName: roomNumber ? ROOMS_CONFIG[roomNumber].name : null,
    timerDuration: initialTimer,
    houseCutPercent: roomNumber ? ROOMS_CONFIG[roomNumber].houseCutPercent : null
  };
  const payloadO = {
    matchId,
    youAre: "O",
    symbol: "O",
    opponentId: X,
    opponentUsername: nameX,
    opponentSymbol: "X",
    players: { X, O },
    betAmount,
    room: roomNumber,
    roomName: roomNumber ? ROOMS_CONFIG[roomNumber].name : null,
    timerDuration: initialTimer,
    houseCutPercent: roomNumber ? ROOMS_CONFIG[roomNumber].houseCutPercent : null
  };

  // ✅ Emit by user room so both sides *definitely* receive it
  emitToUser(io, X, "match_found", payloadX);
  emitToUser(io, O, "match_found", payloadO);

  // 3-second pre-start countdown
  scheduleGameStart(io, matchId);

  return { matchId, X, O };
}

async function removeAllOccurrencesFromQueue(queueKey, userId) {
  const items = await redis.lrange(queueKey, 0, -1);
  if (!items?.length) return 0;
  let removed = 0;
  for (const raw of items) {
    try {
      const entry = JSON.parse(raw);
      if (entry.userId === userId) removed += await redis.lrem(queueKey, 0, raw);
    } catch { }
  }
  if (removed && DEBUG_MATCH) dbg(`purge[${queueKey}]`, { userId, removed });
  return removed;
}
async function purgeUserFromAllQueues(userId) {
  const keys = await redis.smembers(MM_QUEUES_SET).catch(() => []);
  if (!keys?.length) return;
  await Promise.all(keys.map(k => removeAllOccurrencesFromQueue(k, userId)));
}
async function lpopN(key, n) {
  if (typeof redis.lpop === "function" && redis.lpop.length >= 2) {
    try { return await redis.lpop(key, n); } catch { }
  }
  const out = [];
  for (let i = 0; i < n; i++) {
    const v = await redis.lpop(key);
    if (!v) break;
    out.push(v);
  }
  return out;
}
async function withRedisLock(redisClient, key, ttlMs, fn) {
  const lockId = uuidv4();
  const ok = await redisClient.set(key, lockId, "NX", "PX", ttlMs);
  if (!ok) return false;
  try { await fn(); return true; }
  finally {
    const lua = `
      if redis.call('get', KEYS[1]) == ARGV[1] then
        return redis.call('del', KEYS[1])
      else
        return 0
      end
    `;
    try { await redisClient.eval(lua, 1, key, lockId); } catch { }
  }
}
async function requeuePreservingPlace(queueKey, entry) {
  await redis.rpush(queueKey, JSON.stringify(entry));
}
function startQueueTimeout(socket, queueKey, userId) {
  clearQueueTimeout(socket.id);
  const t = setTimeout(async () => {
    try { await removeFromQueue(queueKey, userId); } catch { }
    socketSearching.delete(socket.id);
    queueTimers.delete(socket.id);
    emitDebug(socket, "queue_timeout", { queueKey, userId, ttl: QUEUE_TTL });
    socket.emit("queue_timeout", { reason: "no_match_found", ttlMs: QUEUE_TTL });
    socket.emit("queue_status", { searching: false });
  }, QUEUE_TTL);
  queueTimers.set(socket.id, t);
}
function clearQueueTimeout(socketId) {
  const t = queueTimers.get(socketId);
  if (t) { clearTimeout(t); queueTimers.delete(socketId); }
}

// ---------------- Wallets & Games ----------------
async function lockAndStartMatch(matchId, playerXId, playerOId, betAmount) {
  return tx(async (client) => {
    const ids = [playerXId, playerOId];

    // Lock both wallet rows
    const walletRes = await client.query(
      `SELECT user_id, available_balance, bonus_balance FROM wallets WHERE user_id = ANY($1::uuid[]) FOR UPDATE`,
      [ids]
    );

    if (walletRes.rowCount !== 2) throw new Error("INSUFFICIENT_BALANCE");

      // For each player, apply bonus-first deduction
      const playerBonusUsed = {};
      for (const wallet of walletRes.rows) {
        const avail = Number(wallet.available_balance);
        const bonus = Number(wallet.bonus_balance);
        const userId = wallet.user_id;

        const bonusToUse = Math.min(bonus, betAmount);
        const realToUse = betAmount - bonusToUse;

        // Check TOTAL effective balance (available + bonus), not just available
        if ((avail + bonus) < betAmount) throw new Error("INSUFFICIENT_BALANCE");
        
        // Store pre-deduction bonus used amount for this player
        playerBonusUsed[userId] = bonusToUse;

      // Unified deduction:
      // - available_balance always drops by the full betAmount
      // - bonus_balance drops by bonusToUse
      // - withdrawable_balance ONLY drops by the real cash portion (realToUse)
      await client.query(
        `UPDATE wallets
         SET available_balance    = GREATEST(available_balance  - $1, 0),
             bonus_balance        = GREATEST(bonus_balance - $2, 0),
             withdrawable_balance = GREATEST(withdrawable_balance - $3, 0),
             updated_at           = now()
         WHERE user_id = $4`,
        [betAmount, bonusToUse, realToUse, userId]
      );
    }

    await client.query(
      `INSERT INTO games (id, player_x, player_o, bet_amount, status, moves, created_at, bonus_used_x, bonus_used_o)
       VALUES ($1, $2, $3, $4, 'ongoing', '[]'::jsonb, NOW(), $5, $6)`,
      [matchId, playerXId, playerOId, betAmount, 
        playerBonusUsed[playerXId],
        playerBonusUsed[playerOId]
      ]
    );
    return { id: matchId, player_x: playerXId, player_o: playerOId, bet_amount: betAmount, status: "ongoing" };
  });
}

async function saveMove(gameId, moveObj) {
  await pool.query(
    `UPDATE games SET moves = moves || $1::jsonb WHERE id = $2`,
    [JSON.stringify([moveObj]), gameId]
  );
}

async function finishAndPayout(gameId, status, winnerUserId, prizeAmount) {
  return tx(async (client) => {
    // Get game details to determine room and bonus used
    const gameRes = await client.query(`SELECT bet_amount, player_x, player_o, bonus_used_x, bonus_used_o FROM games WHERE id = $1`, [gameId]);
    const game = gameRes.rows[0];

    await client.query(
      `UPDATE games SET status = $1, winner = $2, finished_at = NOW(), prize_amount = $4 WHERE id = $3`,
      [status === 'X' || status === 'O' ? 'completed' : status, winnerUserId || null, gameId, winnerUserId ? prizeAmount : 0]
    );

    if (winnerUserId) {
      const isX = (winnerUserId === game.player_x);
      const bonusUsed = isX ? Number(game.bonus_used_x || 0) : Number(game.bonus_used_o || 0);
      const withdrawableProfit = prizeAmount - bonusUsed;

      // Direct wallet update — MUST succeed before ledger
      // ✅ Fixed: Only add prizeAmount ONCE. The prize already includes the original wager return!
      // The old bug: we were adding BOTH prizeAmount AND bonusUsed, creating double credit for bonuses
      await client.query(`
        UPDATE wallets 
        SET available_balance = available_balance + $1,
            bonus_balance = bonus_balance + $2,
            withdrawable_balance = withdrawable_balance + $3,
            updated_at = NOW()
        WHERE user_id = $4
      `, [prizeAmount, 0, withdrawableProfit, winnerUserId]);

      // Ledger record — non-critical; do NOT let this roll back the wallet credit! Use pool.query so it's a separate transaction.
      await pool.query(`
        INSERT INTO payment_transactions (id, user_id, type, status, amount, bank, tx_ref, provider_payload)
        VALUES (gen_random_uuid(), $1, 'deposit', 'success', $2, 'PRIZE', $3, $4::jsonb)
      `, [winnerUserId, prizeAmount, 'game-' + gameId + '-' + Date.now(), JSON.stringify({ gameId })]
      ).catch(err => console.error('[finishAndPayout] ledger insert failed (non-fatal):', err));

      // Update global wins for winner and losses for opponent - REMOVED since wins/losses are dynamically calculated
      const loserUserId = (winnerUserId === game.player_x) ? game.player_o : game.player_x;

      // Track room_1_wins for the winner (Room 1 bets: 10, 25, 50, 99 ETB)
      const betBirr = game ? Math.round(Number(game.bet_amount)) : 0;
      if (game && ROOMS_CONFIG[1].betRange.includes(betBirr)) {
        let tierCol = "";
        if (betBirr === 10) tierCol = "r1_10_wins";
        else if (betBirr === 25) tierCol = "r1_25_wins";
        else if (betBirr === 50) tierCol = "r1_50_wins";
        else if (betBirr === 99) tierCol = "r1_99_wins";

        await client.query(
          `UPDATE users SET room_1_wins = room_1_wins + 1${tierCol ? `, ${tierCol} = ${tierCol} + 1` : ''} WHERE id = $1`,
          [winnerUserId]
        ).catch(err => console.error('[game] room_1_wins increment error:', err));
        
        console.log(`[ACHIEVEMENT] Room 1 win recorded: User=${winnerUserId} Bet=${game.bet_amount} Birr=${betBirr} Tier=${tierCol}`);
      }
    }
    // No draw payouts — winner takes all, game always continues until a winner
  });
}

// ---------------- Game helpers ----------------
function isValidMove(game, index, symbol) {
  return (
    game.status === "live" && // only allow after countdown is done
    index >= 0 &&
    index < BOARD_SIZE &&
    game.board[index] === "_" &&
    game.turn === symbol
  );
}
function checkWin(board, symbol) {
  return WINNING_COMBINATIONS.some(([a, b, c]) => board[a] === symbol && board[b] === symbol && board[c] === symbol);
}
function checkDraw(board) { return board.every(cell => cell !== "_"); }

function cleanupGame(matchId) {
  const game = activeGames.get(matchId);
  if (!game) return;
  if (game.timerInterval) clearInterval(game.timerInterval);
  if (game.reconnectTimeout) clearTimeout(game.reconnectTimeout);
  if (game.startTimeout) clearTimeout(game.startTimeout); // clear pending start
  const { X, O } = game.players || {};
  // DO NOT delete in_game here, wait for leave_room so they appear "in_game" while on results screen
  activeGames.delete(matchId);
  dbg("cleanupGame", { matchId });
}

// schedule actual game start after PRE_MATCH_DELAY_MS
function scheduleGameStart(io, matchId) {
  const game = activeGames.get(matchId);
  if (!game) return;

  // broadcast a start-soon notification
  io.to(matchId).emit("match_starting", {
    matchId,
    startingInMs: PRE_MATCH_DELAY_MS,
  });

  if (game.startTimeout) clearTimeout(game.startTimeout);
  game.startTimeout = setTimeout(() => {
    const g = activeGames.get(matchId);
    if (!g) return;

    // ✅ PREVENT GHOST MATCHES: Check if both players are still connected
    const sX = g.sockets.X;
    const sO = g.sockets.O;
    if (!sX || !sO || sX.disconnected || sO.disconnected) {
      logAlways(`[MM] Ghost Match Cleaning matchId=${matchId}: X disconnected? ${!sX || sX.disconnected}, O disconnected? ${!sO || sO.disconnected}`);
      
      const loserSymbol = (!sX || sX.disconnected) ? "X" : "O";
      const winnerSymbol = (loserSymbol === "X" ? "O" : "X");
      const winnerId = g.players[winnerSymbol];
      const { prize } = calculatePrize(g.betAmount);
      
      if (winnerId) {
        finishAndPayout(matchId, winnerSymbol, winnerId, prize).catch(err =>
          console.error("Ghost cleanup payout err:", err)
        );
        io.to(matchId).emit("game_won", { 
          winnerSymbol, 
          winnerId, 
          reason: "opponent_left", 
          prizeAmount: Number(prize) 
        });
      }
      cleanupGame(matchId);
      return;
    }

    g.status = "live"; // allow moves now
    io.to(matchId).emit("match_started", {
      matchId,
      board: g.board,
      turn: g.turn,
      timers: g.timers,
    });
    startTimer(io, matchId);
  }, PRE_MATCH_DELAY_MS);
}

function startTimer(io, matchId) {
  const game = activeGames.get(matchId);
  if (!game) return;
  if (game.timerInterval) clearInterval(game.timerInterval);
  game.timerInterval = setInterval(() => {
    const g = activeGames.get(matchId);
    if (!g) return clearInterval(game.timerInterval);
    g.timers[g.turn]--;
    io.to(matchId).emit("timer_update", { timers: g.timers });
    if (g.timers[g.turn] <= 0) {
      clearInterval(g.timerInterval);
      const loserSymbol = g.turn;
      const winnerSymbol = (loserSymbol === "X" ? "O" : "X");
      const winnerId = g.players[winnerSymbol];
      
      const { prize } = calculatePrize(g.betAmount); // use room-specific cut
      const prizeBirr = Number(prize); // TRANSLATOR: Send Birr
      
      if (winnerId) {
        finishAndPayout(matchId, winnerSymbol, winnerId, prize).catch(err =>
          console.error("finishAndPayout win err:", err)
        );
        io.to(matchId).emit("game_won", { winnerSymbol, winnerId, reason: "win", prizeAmount: prizeBirr });
      }
      cleanupGame(matchId);
    }
  }, 1000);
}

// ---- NEW: Pre-match delay before game starts -----------------------
const PRE_MATCH_DELAY_MS = 3000; // 3 seconds

// ---------------- Socket wiring ----------------
function setupGameSocket(io) {
  io.on("connection", (socket) => {
    // === REMATCH: record socket presence once we learn userId =========
    function rememberUser(userId) {
      try {
        socket.data = socket.data || {};
        socket.data.userId = userId;
        addUserSocket(userId, socket);
      } catch { }
    }

    // === AUTO-REGISTER: Join user's personal room on connect =========
    // This ensures emitToUser() works even before find_match/friend_invite
    // Critical for: rematch_offer, friend_invite_received arriving on home page
    try {
      const tkn = socket.handshake.auth?.token;
      if (tkn) {
        const decoded = jwt.verify(tkn, JWT_SECRET);
        if (decoded?.sub) {
          const uid = decoded.sub || decoded.id;
          rememberUser(uid);
          rememberUserSocket(socket, uid);
          console.log(`[CONNECT] User ${uid} auto-registered on socket connect`);
        }
      }
    } catch (e) {
      // Token invalid/expired — user just isn't auto-registered, no harm
    }

    // ------- Matchmaking -------
    socket.on("find_match", async ({ token, betAmount }, ack) => {
      const rid = shortId();
      let userId = null;
      
      // Railway proxy may strip extraHeaders on WS upgrade — check auth.platform as fallback
      const platform = (
        socket.handshake.headers['x-platform'] ||
        socket.handshake.auth?.platform ||
        socket.handshake.query?.platform ||
        ''
      ).toLowerCase();
      const isWeb = platform === 'web';

      console.log("find_match called with token:", token ? token.substring(0, 20) + "..." : "NO_TOKEN", "betAmount:", betAmount, "platform:", platform);
      logAlways(`ENTER find_match rid=${rid} sid=${socket.id} bet=${betAmount} platform=${platform}`);
      try {
        const decoded = jwt.verify(token, JWT_SECRET);
        userId = decoded.sub || decoded.id;
        console.log(`[MM] Token verified for user: ${userId}`);
        
        // --- STRICT PAYLOAD SANITIZATION (Security Pen Test Patch) ---
        const safeBetAmount = Number(betAmount);
        if (!Number.isFinite(safeBetAmount) || safeBetAmount <= 0) {
           console.warn(`[SECURITY WARN] Malicious betAmount payload detected from user ${userId}:`, betAmount);
           if (typeof ack === "function") ack({ ok: true, data: { state: "INVALID_BET_AMOUNT" } });
           socket.emit("error", { code: "INVALID_BET_AMOUNT", message: "Invalid payload format." });
           return;
        }

        rememberUser(userId);
        rememberUserSocket(socket, userId); // track user online
        const username = decoded.username || "";
        
        // After validation → Normalize and store as cents internally
        const roomNumber = determineRoomByBetAmount(safeBetAmount);
        if (!roomNumber) {
          const validBets = [
            ...ROOMS_CONFIG[1].betRange,
            ...ROOMS_CONFIG[2].betRange,
            ...ROOMS_CONFIG[3].betRange,
            "10000+ (Room 3)"
          ];
          if (typeof ack === "function") ack({ ok: true, data: { state: "INVALID_BET_AMOUNT" } });
          socket.emit("error", {
            code: "INVALID_BET_AMOUNT",
            message: `Invalid bet amount. Valid amounts are: ${validBets.join(", ")}`
          });
          return;
        }

        // --- GLOBAL MOBILE APP LOCKOUT CHECK ---
        if (!isWeb) {
          const lockRes = await pool.query(`SELECT value FROM global_settings WHERE key = 'mobile_app_lockout'`);
          if (lockRes.rows.length > 0 && (lockRes.rows[0].value === true || lockRes.rows[0].value === 'true')) {
            if (typeof ack === "function") ack({ ok: true, data: { state: "APP_DEPRECATED" } });
            socket.emit("error", {
              code: "APP_DEPRECATED",
              message: "The mobile app is no longer supported. Please use the website to access your account."
            });
            return;
          }
        }

        // --- PLATFORM TIMER LOGIC ---
        let timerDuration = 30; // Default
        if (isWeb) {
          timerDuration = 30; // Web is always 30s
        } else {
          // Mobile tiered: R1=30, R2=25, R3=20
          if (roomNumber === 1) timerDuration = 30;
          else if (roomNumber === 2) timerDuration = 25;
          else if (roomNumber === 3) timerDuration = 20;
        }

        // --- TRANSLATOR: Convert Birr to Cents for DB/Logic ---
        const betAmountCents = Math.round(safeBetAmount);
        
        const ctx = `rid=${rid} sid=${socket.id} uid=${userId} bet=${betAmountCents} isWeb=${isWeb}`;
        dbg(ctx, "verified token and room");

        // already in a game? -> NON-ERROR resume
        const inGame = await redis.get(`in_game:${userId}`).catch(() => null);
        if (inGame) {
          dbg(ctx, "IN_GAME_BLOCK", { inGame });
          // Link new socket to the ongoing match room to receive events
          socket.join(inGame);
          const activeGame = activeGames.get(inGame);
          if (activeGame) {
             const symbol = activeGame.players.X === userId ? "X" : "O";
             socket.data = { matchId: inGame, userId, symbol };
             activeGame.sockets[symbol] = socket; // Replace zombie socket with live one
             // Cancel any pending forfeit disconnect timer
             if (activeGame.reconnectTimeout) clearTimeout(activeGame.reconnectTimeout);
          }
          if (typeof ack === "function") ack({ ok: true, data: { state: "IN_GAME", matchId: inGame } });
          socket.emit("resume_game", { matchId: inGame });
          return;
        }

        // Room 1 stake-lock check: tier-specific locks after 20 wins
        if (roomNumber === 1 && ROOMS_CONFIG[1].betRange.includes(Number(betAmount))) {
          const betNum = Number(betAmount);
          const colMap = { 10: 'r1_10_wins', 25: 'r1_25_wins', 50: 'r1_50_wins', 99: 'r1_99_wins' };
          const col = colMap[betNum];
          
          if (col) {
            const lockRes = await pool.query(`SELECT ${col} FROM users WHERE id = $1`, [userId]).catch(() => ({ rows: [] }));
            const wins = Number(lockRes.rows?.[0]?.[col] ?? 0);
            if (wins >= 20) {
              dbg(ctx, "STAKE_LOCKED", { userId, betAmount, wins });
              if (typeof ack === "function") ack({ ok: true, data: { state: "STAKE_LOCKED", betAmount, wins } });
              socket.emit("error", { code: "STAKE_LOCKED", message: `Stake ${betAmountCents} ETB is locked after 20 wins. Try a different stake amount.` });
              return;
            }
          }
        }

        // pre-queue balance check (bonus_balance + available_balance must cover betAmount)
        const balRes = await pool.query(`SELECT available_balance, COALESCE(bonus_balance, 0) AS bonus_balance FROM wallets WHERE user_id = $1`, [userId]);
        const avail = Number(balRes.rows?.[0]?.available_balance ?? 0);
        const bonus = Number(balRes.rows?.[0]?.bonus_balance ?? 0);
        const effectiveBalance = avail + bonus;
        dbg(ctx, "prequeue balance", { avail, bonus, effectiveBalance, required: betAmountCents });
        if (!balRes.rows.length || effectiveBalance < betAmountCents) {
          if (typeof ack === "function") ack({ ok: true, data: { state: "INSUFFICIENT_BALANCE" } });
          socket.emit("error", { code: "INSUFFICIENT_BALANCE", message: "Insufficient balance" });
          return;
        }


        const queueKey = `queue:${betAmountCents}`;
        await redis.sadd(MM_QUEUES_SET, queueKey).catch(() => { });
        dbg(ctx, "queueKey", queueKey);

        // socket already searching?
        if (socketSearching.has(socket.id)) {
          dbg(ctx, "ALREADY_IN_QUEUE (socket)");
          if (typeof ack === "function") ack({ ok: true, data: { state: "ALREADY_IN_QUEUE" } });
          socket.emit("info", { code: "ALREADY_IN_QUEUE", message: "Already searching…" });
          return;
        }

        // remove stale entry (this queue)
        const removed = await removeFromQueue(queueKey, userId);
        if (removed) dbg(ctx, "removed stale entry in this queue");

        // enqueue
        const entry = {
          userId,
          username,
          socketId: socket.id,
          joinedAt: Date.now(),
          rid,
          betAmount: betAmountCents,
          room: roomNumber,
          timerDuration: timerDuration
        };
        await redis.rpush(queueKey, JSON.stringify(entry));
        socketSearching.set(socket.id, queueKey);
        startQueueTimeout(socket, queueKey, userId);
        socket.emit("queue_status", {
          searching: true,
          room: roomNumber,
          roomName: ROOMS_CONFIG[roomNumber].name,
          betAmount: betAmountCents,
          timerDuration: timerDuration,
          houseCutPercent: ROOMS_CONFIG[roomNumber].houseCutPercent
        });
        emitDebug(socket, "queued", { queueKey, entry });

        if (typeof ack === "function") ack({
          ok: true,
          data: {
            queued: true,
            ttlMs: QUEUE_TTL,
            room: roomNumber,
            roomName: ROOMS_CONFIG[roomNumber].name,
            betAmount: betAmountCents,
            timerDuration: timerDuration,
            houseCutPercent: ROOMS_CONFIG[roomNumber].houseCutPercent
          }
        });

        // prune stale entries
        const now = Date.now();
        const current = await redis.lrange(queueKey, 0, -1);
        const fresh = current.filter(i => now - JSON.parse(i).joinedAt <= QUEUE_TTL);
        if (fresh.length !== current.length) {
          dbg(ctx, "prune", { before: current.length, after: fresh.length });
          await redis.del(queueKey);
          if (fresh.length) await redis.rpush(queueKey, ...fresh);
        }

        // matcher (with lock)
        console.log(`[MM] Checking queue for betAmount: ${betAmountCents}, queueKey: ${queueKey}`);
        const queueLen = await redis.llen(queueKey).catch(() => 0);
        console.log(`[MM] Current queue length: ${queueLen}`);

        dbg(ctx, "matcher: try lock", { lock: `lock:matcher:${betAmount}` });
        const locked = await withRedisLock(redis, `lock:matcher:${betAmount}`, 2000, async () => {
          dbg(ctx, "matcher: lock acquired");

          while ((await redis.llen(queueKey)) >= 2) {
            // pop two from head (FIFO)
            let popped = await lpopN(queueKey, 2);
            dbg(ctx, "matcher: popped raw", popped);
            
            if (!Array.isArray(popped)) popped = [popped].filter(Boolean);
            
            // If we somehow didn't get 2, but the queue length was >=2, it means 
            // another process might have popped them, or Redis was busy.
            if (popped.length < 2) {
              if (popped.length === 1) await redis.lpush(queueKey, popped[0]);
              break; 
            }

            let p1, p2;
            try { 
              p1 = JSON.parse(popped[0]); 
              p2 = JSON.parse(popped[1]); 
            } catch { 
              dbg(ctx, "matcher: JSON parse error; skip segment"); 
              continue; 
            }

            if (!p1?.userId || !p2?.userId) { dbg(ctx, "matcher: malformed pair; skip"); continue; }
            
            // Critical: Don't match user with themselves. If this happens, push the second one back and try next.
            if (p1.userId === p2.userId) { 
              dbg(ctx, "same user twice; push p2 back to front"); 
              await redis.lpush(queueKey, JSON.stringify(p2)); 
              // We need another player from the queue to match with p1
              const nextRaw = await redis.lpop(queueKey);
              if (!nextRaw) {
                // No one else left, put p1 back for later
                await redis.lpush(queueKey, JSON.stringify(p1));
                break;
              }
              p2 = JSON.parse(nextRaw);
            }

            const s1 = io.sockets.sockets.get(p1.socketId);
            const s2 = io.sockets.sockets.get(p2.socketId);
            
            if (!s1 || !s2) {
              dbg(ctx, "One or both sockets missing, re-queuing survivors", { s1: !!s1, s2: !!s2 });
              if (s1) await redis.lpush(queueKey, JSON.stringify(p1)); // Push to FRONT so they aren't penalized
              if (s2) await redis.lpush(queueKey, JSON.stringify(p2));
              continue;
            }

            const matchId = uuidv4();
            try {
              await lockAndStartMatch(matchId, p1.userId, p2.userId, betAmountCents);
            } catch (e) {
              dbg(ctx, "lockAndStartMatch: FAIL", String(e));
              // Balances might have changed between enqueue and match
              if (String(e).includes("INSUFFICIENT_BALANCE")) {
                s1.emit("error", { code: "INSUFFICIENT_BALANCE", message: "Match failed: Balance check failed." });
                s2.emit("error", { code: "INSUFFICIENT_BALANCE", message: "Match failed: Balance check failed." });
              }
              continue;
            }

            // purge both users from ALL queues (handles dup enqueues)
            await Promise.all([
              purgeUserFromAllQueues(p1.userId),
              purgeUserFromAllQueues(p2.userId),
            ]);

            // build game
            const players = { X: p1.userId, O: p2.userId };
            const sockets = { X: s1, O: s2 };

            const initialTimer = timerDuration;

            const game = {
              id: matchId,
              board: Array(9).fill("_"),
              turn: "X",
              players,
              sockets,
              timers: { X: initialTimer, O: initialTimer },
              betAmount: betAmountCents,
              room: roomNumber,
              timerInterval: null,
              reconnectTimeout: null,
              startTimeout: null,
              status: "countdown", // will start after 3s
              round: 1, // track rounds for history display
            };
            activeGames.set(matchId, game);

            // attach identities
            if (sockets.X) sockets.X.data = { matchId, userId: players.X, symbol: "X" };
            if (sockets.O) sockets.O.data = { matchId, userId: players.O, symbol: "O" };

            // ENSURE all fresh sockets for these users join the game room, not just the original queued socket
            io.in(userRoom(players.X)).socketsJoin(matchId);
            io.in(userRoom(players.O)).socketsJoin(matchId);

            // clear search flags/timers
            socketSearching.delete(p1.socketId);
            socketSearching.delete(p2.socketId);
            clearQueueTimeout(p1.socketId);
            clearQueueTimeout(p2.socketId);
            sockets.X.emit("queue_status", { searching: false });
            sockets.O.emit("queue_status", { searching: false });

            // mark in_game (blocks requeue)
            await redis.set(`in_game:${players.X}`, matchId, "PX", QUEUE_TTL * 10).catch(() => { });
            await redis.set(`in_game:${players.O}`, matchId, "PX", QUEUE_TTL * 10).catch(() => { });

            // payloads with room info — fetch real usernames to avoid UUID display
            const nameRes = await pool.query(
              `SELECT id, COALESCE(display_name, username, number::text) AS display_name FROM users WHERE id = ANY($1::uuid[])`,
              [[players.X, players.O]]
            ).catch(() => ({ rows: [] }));
            const nameMap = new Map(nameRes.rows.map(r => [String(r.id), r.display_name]));
            const nameX = nameMap.get(String(players.X)) || p1.username || players.X.slice(0, 8);
            const nameO = nameMap.get(String(players.O)) || p2.username || players.O.slice(0, 8);

            const payloadX = {
              matchId,
              youAre: "X",
              symbol: "X",
              opponentId: players.O,
              opponentUsername: nameO,
              opponentSymbol: "O",
              players,
              betAmount: Number(betAmountCents), // TRANSLATOR: Send Birr to client
              room: roomNumber,
              roomName: roomNumber ? ROOMS_CONFIG[roomNumber].name : null,
              timerDuration: initialTimer,
              houseCutPercent: roomNumber ? ROOMS_CONFIG[roomNumber].houseCutPercent : null
            };
            const payloadO = {
              matchId,
              youAre: "O",
              symbol: "O",
              opponentId: players.X,
              opponentUsername: nameX,
              opponentSymbol: "X",
              players,
              betAmount: Number(betAmountCents), // TRANSLATOR: Send Birr to client
              room: roomNumber,
              roomName: roomNumber ? ROOMS_CONFIG[roomNumber].name : null,
              timerDuration: initialTimer,
              houseCutPercent: roomNumber ? ROOMS_CONFIG[roomNumber].houseCutPercent : null
            };

            console.log('[MM] MATCH FOUND! Emitting to both players');
            console.log('[MM] Player X:', players.X, 'Socket X:', !!sockets.X);
            console.log('[MM] Player O:', players.O, 'Socket O:', !!sockets.O);
            console.log('[MM] Match ID:', matchId);
            console.log('[MM] Payload X sample:', { matchId, symbol: 'X', opponentUsername: nameO });
            console.log('[MM] Payload O sample:', { matchId, symbol: 'O', opponentUsername: nameX });

            dbg(ctx, "emit match_found", { matchId, players });
            emitToUser(io, players.X, "match_found", payloadX);
            emitToUser(io, players.O, "match_found", payloadO);

            // 3-second pre-start countdown
            scheduleGameStart(io, matchId);
          }

          dbg(ctx, "matcher: exit");
        });

        dbg(`rid=${rid} sid=${socket.id}`, locked ? "matcher ran" : "matcher skipped (lock held)");
      } catch (err) {
        logAlways(`EXCEPTION find_match rid=${rid} sid=${socket.id} uid=${userId || "?"} err=${String(err)}`);
        socket.emit("error", { code: "MATCH_ERROR", message: "Matchmaking error" });
        if (typeof ack === "function") ack({ ok: true, data: { state: "MATCH_ERROR" } });
      }
    });

    // -------------------------------------------------------
    // CANCEL SEARCH
    // -------------------------------------------------------
    socket.on("cancel_find_match", async ({ token }, ack) => {
      let userId = null;
      try {
        const decoded = jwt.verify(token, JWT_SECRET);
        userId = decoded.sub || decoded.id;
        
        // CRITICAL: If already matched/in-game, deny cancellation
        const inGameId = await redis.get(`in_game:${userId}`).catch(() => null);
        if (inGameId) {
           console.log(`[MM] Denying cancel for ${userId} - Already matched in ${inGameId}`);
            if (typeof ack === "function") ack({ ok: false, error: "ALREADY_MATCHED", matchId: inGameId });
            return;
        }

        const queueKey = socketSearching.get(socket.id);
        if (queueKey) {
          await removeAllOccurrencesFromQueue(queueKey, userId);
          socketSearching.delete(socket.id);
          clearQueueTimeout(socket.id);
        }
        await purgeUserFromAllQueues(userId); // belt & suspenders

        socket.emit("queue_status", { searching: false });
        if (typeof ack === "function") ack({ ok: true, data: { removed: !!queueKey } });
      } catch (e) {
        if (typeof ack === "function") ack({ ok: false, error: "Cancel failed" });
      }
    });

    // -------------------------------------------------------
    // AUTO-REGISTER on connect: decode auth token from handshake
    // -------------------------------------------------------
    try {
      const tkn = socket.handshake.auth?.token;
      if (tkn) {
        const decoded = jwt.verify(tkn, JWT_SECRET);
        const uid = decoded.sub || decoded.userId || decoded.id;
        if (uid) {
          rememberUser(uid);
          rememberUserSocket(socket, uid);
          console.log(`[CONNECT] User ${uid} auto-registered on socket connect`);
        }
      }
    } catch { /* token invalid/expired — will be caught later on actual events */ }

    // Cleanup on disconnect
    socket.on("disconnect", () => {
      const uid = socket.data?.userId;
      if (uid) {
        removeUserSocket(uid, socket.id);
      }
    });

    // -------------------------------------------------------
    // FRIEND INVITE (lookup + send)
    // -------------------------------------------------------
    socket.on("friend_invite", async ({ token: tkn, targetUsername, betAmount: rawBet }) => {
      try {
        const decoded = jwt.verify(tkn, JWT_SECRET);
        const senderId = decoded.sub || decoded.id;
        rememberUser(senderId);
        rememberUserSocket(socket, senderId);

        const safeBet = Number(rawBet) || 0;
        const isLookupOnly = safeBet <= 0;

        // Validate bet only when actually sending an invite (not lookup)
        if (!isLookupOnly && (!Number.isFinite(safeBet) || safeBet <= 0)) {
          return socket.emit("friend_invite_result", { ok: false, reason: "invalid_bet" });
        }

        // Fetch target with win caps (no balance exposed)
        const targetRes = await pool.query(
          `SELECT u.id, u.username, u.r1_10_wins, u.r1_25_wins, u.r1_50_wins, u.r1_99_wins,
                  COALESCE(w.available_balance,0)+COALESCE(w.bonus_balance,0) as balance
           FROM users u LEFT JOIN wallets w ON u.id=w.user_id
           WHERE LOWER(u.username)=LOWER($1)`, [targetUsername]
        );
        if (!targetRes.rows.length) return socket.emit("friend_invite_result", { ok: false, reason: "user_not_found" });
        const target = targetRes.rows[0];
        if (target.id === senderId) return socket.emit("friend_invite_result", { ok: false, reason: "cannot_invite_self" });

        // Online detection: check userSockets map + active socket connections
        const targetOnline = userSockets.has(target.id);
        const inGame = await redis.get(`in_game:${target.id}`).catch(() => null);
        const status = inGame ? "in_game" : (targetOnline ? "online" : "offline");

        // Sender balance + caps
        const senderRes = await pool.query(
          `SELECT COALESCE(w.available_balance,0)+COALESCE(w.bonus_balance,0) as balance,
                  u.username, u.r1_10_wins, u.r1_25_wins, u.r1_50_wins, u.r1_99_wins
           FROM users u LEFT JOIN wallets w ON u.id=w.user_id
           WHERE u.id=$1`, [senderId]
        );
        const sender = senderRes.rows[0] || {};
        const senderUsername = sender.username || decoded.username || 'Player';
        const senderBalance = Number(sender.balance || 0);

        // Build caps for lock checks
        const senderCaps = { r1_10: sender.r1_10_wins || 0, r1_25: sender.r1_25_wins || 0, r1_50: sender.r1_50_wins || 0, r1_99: sender.r1_99_wins || 0 };
        const targetCaps = { r1_10: target.r1_10_wins || 0, r1_25: target.r1_25_wins || 0, r1_50: target.r1_50_wins || 0, r1_99: target.r1_99_wins || 0 };
        const targetBalance = Number(target.balance || 0);

        socket.emit("friend_invite_result", {
          ok: true,
          target: { id: target.id, username: target.username, status },
          senderBalance,
          targetBalance,
          senderCaps,
          targetCaps,
          betAmount: safeBet,
        });

        // Only send the actual invite if a real bet was specified and target is online
        if (!isLookupOnly && status === "online") {
          // Race condition guard: use sorted pair key so A→B and B→A share the same lock
          const pairKey = [senderId, target.id].sort().join(":");
          const inviteKey = `friend_inv:${pairKey}`;
          const existing = await redis.get(inviteKey).catch(() => null);

          if (existing) {
            // An invite already exists for this pair — check if it's the OTHER player inviting US
            const existingData = JSON.parse(existing);
            if (existingData.senderId === target.id) {
              // Mutual invite! Auto-accept: the first sender's invite wins
              await redis.del(inviteKey);
              console.log(`[FRIEND MATCH] Mutual invite detected: ${senderId} <-> ${target.id}, auto-starting match`);
              try {
                const result = await startDirectMatch(io, existingData.senderId, senderId, safeBet);
                console.log(`[FRIEND MATCH] Mutual match started: ${result.matchId}`);
              } catch (e) {
                console.error("[FRIEND MATCH] Mutual match failed:", e.message);
                socket.emit("error", { message: e.message || "Failed to start friend match" });
              }
              return;
            }
            // Same sender re-sending — just update the TTL
          }

          await redis.set(inviteKey, JSON.stringify({ senderId, senderName: senderUsername, targetId: target.id, betAmount: safeBet }), "PX", 45000);
          emitToUser(io, target.id, "friend_invite_received", { fromUserId: senderId, fromUsername: senderUsername, betAmount: safeBet });
        }
      } catch (e) { socket.emit("friend_invite_result", { ok: false, reason: "invite_failed" }); }
    });

    // -------------------------------------------------------
    // FRIEND INVITE RESPONSE (accept/decline)
    // -------------------------------------------------------
    socket.on("friend_invite_response", async ({ token: tkn, senderId, accept, betAmount }) => {
      try {
        const decoded = jwt.verify(tkn, JWT_SECRET);
        const responderId = decoded.sub || decoded.id;
        rememberUser(responderId);
        const pairKey = [senderId, responderId].sort().join(":");
        const inviteKey = `friend_inv:${pairKey}`;
        const raw = await redis.get(inviteKey);
        if (!raw) return socket.emit("error", { message: "Invite expired" });
        await redis.del(inviteKey);
        if (!accept) {
          // Fetch responder username so sender sees who declined
          const responderRes = await pool.query(`SELECT username FROM users WHERE id=$1`, [responderId]);
          const responderName = responderRes.rows[0]?.username || 'Your friend';
          emitToUser(io, senderId, "friend_invite_declined", { byUserId: responderId, byUsername: responderName });
          return;
        }
        const result = await startDirectMatch(io, senderId, responderId, Number(betAmount));
        console.log(`[FRIEND MATCH] Started: ${result.matchId}`);
      } catch (e) { socket.emit("error", { message: e.message || "Failed to start friend match" }); }
    });

    // ---------------- Moves ----------------
    socket.on("make_move", async ({ matchId, index }) => {
      const game = activeGames.get(matchId);
      if (!game) return socket.emit("error", { message: "Invalid game" });

      const userId = socket.data?.userId;
      
      // Derive symbol exclusively from server state to prevent client spoofing
      const symbol = game.players.X === userId ? "X" : (game.players.O === userId ? "O" : null);
      if (!symbol || !isValidMove(game, index, symbol)) {
        return;
      }

      game.board[index] = symbol;
      game.turn = opposite(symbol);

      const moveObj = { index, symbol, user: userId, ts: new Date().toISOString() };
      saveMove(matchId, moveObj).catch(e => console.error("saveMove error:", e));

      io.to(matchId).emit("move_made", {
        index, symbol, board: game.board, turn: game.turn, timers: game.timers, round: game.round || 1,
      });

      startTimer(io, matchId);

      if (checkWin(game.board, symbol)) {
        clearInterval(game.timerInterval);
        const { prize } = calculatePrize(game.betAmount); // use room-specific cut
        const prizeBirr = Number(prize); // TRANSLATOR: Send Birr to client
        finishAndPayout(matchId, symbol, userId, prize).catch(err =>
          console.error("finishAndPayout win err:", err)
        );
        io.to(matchId).emit("game_won", { winnerSymbol: symbol, winnerId: userId, reason: "win", prizeAmount: prizeBirr });
        cleanupGame(matchId);
        return;
      }

      if (checkDraw(game.board)) {
        // Board is full — no winner yet, so start the next round automatically
        game.round = (game.round || 1) + 1;
        game.board = [...INITIAL_BOARD];
        game.turn = "X";
        game.timers = { X: game.timers.O, O: game.timers.X };

        const oldPlayers = { ...game.players };
        const oldSockets = { ...game.sockets };
        game.players = { X: oldPlayers.O, O: oldPlayers.X };
        game.sockets = { X: oldSockets.O, O: oldSockets.X };

        if (game.sockets.X) game.sockets.X.data = { ...game.sockets.X.data, symbol: "X" };
        if (game.sockets.O) game.sockets.O.data = { ...game.sockets.O.data, symbol: "O" };

        // Emit new_round to both players — no draw event, game continues automatically
        const roundPayloadX = {
          id: game.id,
          board: game.board,
          turn: game.turn,
          players: game.players,
          timers: game.timers,
          betAmount: game.betAmount,
          symbol: "X",
          opponentSymbol: "O",
          youAre: "X",
          room: game.room,
          roundNumber: game.round,
          roomName: game.room ? ROOMS_CONFIG[game.room].name : null
        };
        const roundPayloadO = {
          id: game.id,
          board: game.board,
          turn: game.turn,
          players: game.players,
          timers: game.timers,
          betAmount: game.betAmount,
          symbol: "O",
          opponentSymbol: "X",
          youAre: "O",
          room: game.room,
          roundNumber: game.round,
          roomName: game.room ? ROOMS_CONFIG[game.room].name : null
        };

        emitToUser(io, game.players.X, "new_round", roundPayloadX);
        emitToUser(io, game.players.O, "new_round", roundPayloadO);

        // No pre-match delay on subsequent rounds, timer just restarts
        startTimer(io, matchId);
      }
    });

    // ---------------- Leave / Forfeit ----------------
    socket.on("leave_match", async ({ token, matchId }, ack) => {
      try {
        const { sub: userId } = jwt.verify(token, JWT_SECRET);
        rememberUser(userId);
        rememberUserSocket(socket, userId);

        const game = activeGames.get(matchId);
        if (!game) { if (typeof ack === "function") ack({ ok: true, data: { done: true } }); return; }
        const mySymbol = game.players.X === userId ? "X" : (game.players.O === userId ? "O" : null);
        if (!mySymbol) { if (typeof ack === "function") ack({ ok: false, error: "Not your game" }); return; }
        const opponentSymbol = opposite(mySymbol);
        const winnerId = game.players[opponentSymbol];
        const { prize } = calculatePrize(game.betAmount); // use room-specific cut
        const prizeBirr = Number(prize); // TRANSLATOR: Send Birr

        await finishAndPayout(matchId, opponentSymbol, winnerId, prize).catch(e => console.error(e));
        emitToUser(io, game.players[opponentSymbol], "opponent_forfeited", { prizeAmount: prizeBirr });
        io.to(matchId).emit("game_won", { winnerSymbol: opponentSymbol, winnerId, reason: "opponent_left", prizeAmount: prizeBirr });
        cleanupGame(matchId);
        if (typeof ack === "function") ack({ ok: true, data: { done: true } });
      } catch (e) {
        if (typeof ack === "function") ack({ ok: false, error: "Leave failed" });
      }
    });

    socket.on("leave_room", async ({ token }) => {
      try {
        const { sub: userId } = jwt.verify(token, JWT_SECRET);
        await redis.del(`in_game:${userId}`).catch(() => {});
      } catch (e) { }
    });

    // ---------------- Disconnect / Reconnect ----------------
    socket.on("disconnect", async () => {
      const qKey = socketSearching.get(socket.id);
      const { userId, matchId, symbol } = socket.data || {};
      if (userId) removeUserSocket(userId, socket.id);

      // If searching → remove from this queue and clear timer
      if (qKey) {
        try {
          if (userId) await removeAllOccurrencesFromQueue(qKey, userId);
          else {
            const items = await redis.lrange(qKey, 0, -1);
            for (const raw of items) {
              try {
                const entry = JSON.parse(raw);
                if (entry.socketId === socket.id) {
                  await redis.lrem(qKey, 1, raw);
                  break;
                }
              } catch { }
            }
          }
        } catch { }
        socketSearching.delete(socket.id);
        clearQueueTimeout(socket.id);
        socket.emit?.("queue_status", { searching: false });
      }

      // Also purge any duplicates the user might have across queues
      if (userId) { try { await purgeUserFromAllQueues(userId); } catch { } }

      // In-game grace → then forfeit
      if (!matchId || !activeGames.has(matchId)) return;
      const game = activeGames.get(matchId);
      if (game.reconnectTimeout) clearTimeout(game.reconnectTimeout);

      game.reconnectTimeout = setTimeout(async () => {
        if (!activeGames.has(matchId)) return;
        const opponentSymbol = symbol === "X" ? "O" : "X";
        const winnerId = game.players[opponentSymbol];
        const { prize } = calculatePrize(game.betAmount); // use room-specific cut
        await finishAndPayout(matchId, opponentSymbol, winnerId, prize).catch(err =>
          console.error("finishAndPayout forfeit err:", err)
        );
        emitToUser(io, game.players[opponentSymbol], "opponent_forfeited");
        cleanupGame(matchId);
      }, RECONNECT_GRACE);
    });

    // === REMATCH: Sender requests a rematch ===========================
    socket.on("rematch_request", async ({ token, opponentId, amount }, ack) => {
      try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const userId = decoded.sub || decoded.id;
        socket.data = { ...(socket.data || {}), userId };

        amount = Number(amount || 0);
        if (!opponentId || amount <= 0) {
          return ack?.({ ok: false, error: "Invalid rematch payload" });
        }

        const lockOk = await withRematchLock(userId, opponentId, 1500, async () => {
          await putRematchOffer(userId, opponentId, { from: userId, to: opponentId, amount, ts: Date.now() });
        });
        if (!lockOk) return ack?.({ ok: false, error: "Busy" });

        // Fetch sender's username for the offer notification
        let fromUsername = "Opponent";
        try {
          const userRow = await pool.query("SELECT username, number FROM users WHERE id = $1", [userId]);
          if (userRow.rows.length) fromUsername = userRow.rows[0].username || `User ${(userRow.rows[0].number || '').slice(-4)}`;
        } catch (e) { /* fallback to "Opponent" */ }

        socket.emit("rematch_waiting", { opponentId, amount, ttlMs: REMATCH_TTL });
        emitToUser(io, opponentId, "rematch_offer", { fromUserId: userId, fromUsername, amount });

        ack?.({ ok: true });
      } catch (e) {
        ack?.({ ok: false, error: "Auth failed" });
      }
    });

    // === EMOJI: Send emoji to opponent ================================
    socket.on("send_emoji", ({ matchId, emoji }) => {
      socket.to(matchId).emit("emoji_received", { emoji });
    });

    // === REMATCH: Receiver answers (accept/decline) ===================
    socket.on("rematch_response", async ({ token, opponentId, accept, amount }, ack) => {
      try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const userId = decoded.sub || decoded.id;
        socket.data = { ...(socket.data || {}), userId };

        amount = Number(amount || 0);
        const offer = await getRematchOffer(userId, opponentId) || await getRematchOffer(opponentId, userId);
        if (!offer) return ack?.({ ok: false, error: "No offer found" });

        // Best-effort ensure same pair; prefer sender's amount if omitted
        if (!amount) amount = Number(offer.amount || 0);

        await clearRematchOffer(userId, opponentId);

        if (!accept) {
          emitToUser(io, opponentId, "rematch_result", { accepted: false });
          return ack?.({ ok: true });
        }

        // Try direct, immediate match (will apply same house cut + 3s delay)
        try {
          const { matchId, X, O } = await startDirectMatch(io, userId, opponentId, Number(amount || 0));

          // Optional: notify that we're transitioning
          emitToUser(io, userId, "rematch_result", { accepted: true, matchId, youAre: X === userId ? "X" : "O" });
          emitToUser(io, opponentId, "rematch_result", { accepted: true, matchId, youAre: X === opponentId ? "X" : "O" });
          ack?.({ ok: true, matchId });
        } catch (err) {
          const msg = String(err || "");
          // Propagate specific reasons
          if (msg.startsWith("OPPONENT_OFFLINE")) {
            emitToUser(io, opponentId, "rematch_result", { accepted: true, error: "Opponent offline" });
            return ack?.({ ok: false, error: "Opponent offline" });
          }
          if (msg.includes("INSUFFICIENT_BALANCE")) {
            // Let each side know their own status
            emitToUser(io, userId, "error", { code: "INSUFFICIENT_BALANCE", message: "Insufficient balance for rematch" });
            emitToUser(io, opponentId, "error", { code: "INSUFFICIENT_BALANCE", message: "Opponent has insufficient balance" });
            return ack?.({ ok: false, error: "Insufficient balance" });
          }
          // Unknown failure
          emitToUser(io, opponentId, "rematch_result", { accepted: true, error: "Failed to start" });
          ack?.({ ok: false, error: "Failed to start rematch" });
        }
      } catch (e) {
        ack?.({ ok: false, error: "Auth failed" });
      }
    });

    socket.on("cancel_rematch", async ({ token, opponentId }, ack) => {
      try {
        const { sub: userId } = jwt.verify(token, JWT_SECRET);
        await clearRematchOffer(userId, opponentId);
        emitToUser(io, opponentId, "rematch_cancelled", {});
        ack?.({ ok: true });
      } catch (e) {
        ack?.({ ok: false, error: "Auth failed" });
      }
    });

    socket.on("reconnect_match", ({ token, matchId }) => {
      try {
        const { sub: userId } = jwt.verify(token, JWT_SECRET);
        rememberUser(userId);
        rememberUserSocket(socket, userId);

        const game = activeGames.get(matchId);
        if (!game) return socket.emit("error", { message: "Game expired" });

        const symbol = (game.players.X === userId ? "X" : (game.players.O === userId ? "O" : null));
        if (!symbol) return socket.emit("error", { message: "Not your game" });

        if (game.reconnectTimeout) clearTimeout(game.reconnectTimeout);
        game.sockets[symbol] = socket;
        socket.data = { matchId, userId, symbol };
        socket.join(matchId);

        socket.emit("reconnected", {
          matchId, symbol, board: game.board, turn: game.turn, timers: game.timers,
          room: game.room,
          roomName: game.room ? ROOMS_CONFIG[game.room].name : null
        });
      } catch (e) {
        socket.emit("error", { message: "Reconnect failed" });
      }
    });
  });
}

module.exports = { setupGameSocket, ROOMS_CONFIG, determineRoomByBetAmount };