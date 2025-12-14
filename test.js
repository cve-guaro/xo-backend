// gameSocket.js
const { v4: uuidv4 } = require("uuid");
const jwt = require("jsonwebtoken");
const { pool } = require("../db/index");
const Redis = require("ioredis");

const JWT_SECRET = process.env.JWT_SECRET || "supersecret";
const redis = new Redis(process.env.REDIS_URL || "redis://127.0.0.1:6379");
const QUEUE_TTL = 120_000; // 2 minutes

// Track who is searching and per-socket queue timeouts
const queueTimers = new Map();     // socket.id -> timeoutId
// Game constants
const BOARD_SIZE = 9;
const INITIAL_BOARD = Array(BOARD_SIZE).fill("_");
const WINNING_COMBINATIONS = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
];
const INITIAL_TIMER = 30;
const RECONNECT_GRACE = 10_000; // 10 sec

// In-memory state
const activeGames = new Map(); // matchId -> { ... }
const socketSearching = new Map(); // socket.id -> queueKey (when searching)
// ---------- Helpers: DB ----------
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
}

// Remove a user from a Redis queue by userId
async function removeFromQueue(queueKey, userId) {
  const items = await redis.lrange(queueKey, 0, -1);
  for (const raw of items) {
    const entry = JSON.parse(raw);
    if (entry.userId === userId) {
      await redis.lrem(queueKey, 1, raw);
      return true;
    }
  }
  return false;
}


async function requeuePreservingPlace(queueKey, entry) {
  // push to the *tail* so FIFO is preserved; we keep original joinedAt
  await redis.rpush(queueKey, JSON.stringify(entry));
}



function startQueueTimeout(socket, queueKey, userId) {
  // clear any existing
  clearQueueTimeout(socket.id);

  const t = setTimeout(async () => {
    try { await removeFromQueue(queueKey, userId); } catch (_) {}
    socketSearching.delete(socket.id);
    queueTimers.delete(socket.id);

    socket.emit("queue_timeout", { reason: "no_match_found", ttlMs: QUEUE_TTL });
    socket.emit("queue_status", { searching: false });
  }, QUEUE_TTL);

  queueTimers.set(socket.id, t);
}

function clearQueueTimeout(socketId) {
  const t = queueTimers.get(socketId);
  if (t) {
    clearTimeout(t);
    queueTimers.delete(socketId);
  }
}


// Deduct balances atomically for both players and create the game row
async function lockAndStartMatch(matchId, playerXId, playerOId, betAmount) {
  return tx(async (client) => {
    // Lock both users (order by value to avoid deadlocks)
    const ordered = [playerXId, playerOId].sort();
    const usersRes = await client.query(
      `SELECT user_id, available_balance
       FROM wallets
       WHERE user_id = ANY($1::uuid[])
       FOR UPDATE`,
      [ordered]
    );
    if (usersRes.rows.length !== 2) {
      throw new Error("USER_NOT_FOUND");
    }
    const bal = new Map(usersRes.rows.map(r => [String(r.user_id), Number(r.available_balance)]));
    const balX = bal.get(String(playerXId));
    const balO = bal.get(String(playerOId));
    if (balX == null || balO == null) throw new Error("USER_NOT_FOUND");
    if (balX < betAmount || balO < betAmount) throw new Error("INSUFFICIENT_BALANCE");

    // Deduct both
    await client.query(
      `UPDATE wallets
         SET available_balance = available_balance - $1,
             withdrawable_balance = withdrawable_balance - $1
       WHERE user_id = $2`,
      [betAmount, playerXId]
    );
    await client.query(
      `UPDATE wallets
         SET available_balance = available_balance - $1,
             withdrawable_balance = withdrawable_balance - $1
       WHERE user_id = $2`,
      [betAmount, playerOId]
    );

    // Create game row (use matchId as games.id)
    const gameRes = await client.query(
      `INSERT INTO games (id, player_x, player_o, bet_amount, status, moves, created_at)
       VALUES ($1, $2, $3, $4, 'ongoing', '[]'::jsonb, NOW())
       RETURNING *`,
      [matchId, playerXId, playerOId, betAmount]
    );
    return gameRes.rows[0];
  });
}

// Append a move to JSONB moves
async function saveMove(gameId, moveObj) {
  await pool.query(
    `UPDATE games SET moves = moves || $1::jsonb WHERE id = $2`,
    [JSON.stringify([moveObj]), gameId]
  );
}

// Finish game: set status, winner, finished_at; credit prize to winner
async function finishAndPayout(gameId, status, winnerUserId, prizeAmount) {
  return tx(async (client) => {
    await client.query(
      `UPDATE games
         SET status = $1, winner = $2, finished_at = NOW()
       WHERE id = $3`,
      [status, winnerUserId || null, gameId]
    );
    if (winnerUserId) {
      await client.query(
        `UPDATE wallets
           SET available_balance = available_balance + $1,
               withdrawable_balance = withdrawable_balance + $1
         WHERE user_id = $2`,
        [prizeAmount, winnerUserId]
      );
    }
  });
}

// ---------- Helpers: Game ----------
function isValidMove(game, index, symbol) {
  return (
    index >= 0 &&
    index < BOARD_SIZE &&
    game.board[index] === "_" &&
    game.turn === symbol
  );
}

function checkWin(board, symbol) {
  return WINNING_COMBINATIONS.some(([a, b, c]) =>
    board[a] === symbol && board[b] === symbol && board[c] === symbol
  );
}

function checkDraw(board) {
  return board.every(cell => cell !== "_");
}

function cleanupGame(matchId) {
  const game = activeGames.get(matchId);
  if (!game) return;
  if (game.timerInterval) clearInterval(game.timerInterval);
  if (game.reconnectTimeout) clearTimeout(game.reconnectTimeout);
  activeGames.delete(matchId);
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
      const winnerSymbol = g.turn === "X" ? "O" : "X";
      const winnerId = g.players[winnerSymbol];
      const prize = g.betAmount * 2;

      finishAndPayout(matchId, winnerSymbol, winnerId, prize)
        .catch(err => console.error("finishAndPayout timeout err:", err));

      io.to(matchId).emit("game_won", { winnerSymbol, winnerId, reason: "timeout" });
      cleanupGame(matchId);
    }
  }, 1000);
}

// ---------- Queue helpers ----------
async function removeFromQueue(queueKey, userId) {
  const items = await redis.lrange(queueKey, 0, -1);
  for (const raw of items) {
    const entry = JSON.parse(raw);
    if (entry.userId === userId) {
      await redis.lrem(queueKey, 1, raw);
      return true;
    }
  }
  return false;
}

// ---------- Socket wiring ----------
// ---------- Socket wiring ----------
function setupGameSocket(io) {
  io.on("connection", (socket) => {
    // ------- Matchmaking -------
    socket.on("find_match", async ({ token, betAmount }, ack) => {
      try {
        const { sub: userId, username } = jwt.verify(token, JWT_SECRET);

        // 1) Pre-queue balance check (caller only)
        const balRes = await pool.query(
          `SELECT available_balance FROM wallets WHERE user_id = $1`,
          [userId]
        );
        const avail = Number(balRes.rows?.[0]?.available_balance ?? 0);
        if (!balRes.rows.length || avail < betAmount) {
          console.log("insufficient balance for user:", userId);
          console.log(avail)
          socket.emit("error", { code: "INSUFFICIENT_BALANCE", message: "Insufficient balance" });
          if (typeof ack === "function") ack({ ok: false, error: "INSUFFICIENT_BALANCE" });
          return;
        }

        const queueKey = `queue:${betAmount}`;

        // 2) Ensure no duplicate entries by this user at this bet
        await removeFromQueue(queueKey, userId);

        // 3) Enqueue (FIFO) with timestamp
        const entry = { userId, username, socketId: socket.id, joinedAt: Date.now() };
        await redis.rpush(queueKey, JSON.stringify(entry));
        socketSearching.set(socket.id, queueKey);

        // 4) Start a *single* queue timeout for this socket
        startQueueTimeout(socket, queueKey, userId);

        if (typeof ack === "function") ack({ ok: true, data: { queued: true, ttlMs: QUEUE_TTL } });
        socket.emit("queue_status", { searching: true });

        // 5) Prune stale (> TTL)
        const now = Date.now();
        const current = await redis.lrange(queueKey, 0, -1);
        const fresh = current.filter(item => now - JSON.parse(item).joinedAt <= QUEUE_TTL);
        if (fresh.length !== current.length) {
          await redis.del(queueKey);
          if (fresh.length) await redis.rpush(queueKey, ...fresh);
        }

        // 6) Try to match repeatedly while we have >= 2 players
        //    (loop protects against "insufficient" on one side by requeueing the other)
        while ((await redis.llen(queueKey)) >= 2) {
          let popped = await redis.lpop(queueKey, 2); // take from head to respect FIFO
          if (!Array.isArray(popped)) popped = [popped].filter(Boolean);
          if (popped.length < 2) {
            // Put back if we only popped one due to race
            if (popped[0]) await redis.lpush(queueKey, popped[0]);
            break;
          }

          let [p1, p2] = popped.map(JSON.parse);

          // Skip if they are the same user
          if (p1.userId === p2.userId) {
            await requeuePreservingPlace(queueKey, p2);
            continue;
          }

          const s1 = io.sockets.sockets.get(p1.socketId);
          const s2 = io.sockets.sockets.get(p2.socketId);

          // If either socket already disconnected, requeue the present one and continue
          if (!s1 || !s2) {
            if (s1) await requeuePreservingPlace(queueKey, p1);
            if (s2) await requeuePreservingPlace(queueKey, p2);
            continue;
          }

          const matchId = uuidv4();

          // 7) Transactional start; if one player is now insufficient, notify only that player and requeue the other
          try {
            await lockAndStartMatch(matchId, p1.userId, p2.userId, betAmount);
          } catch (e) {
            // Read balances without lock to decide who failed (best-effort; lockAndStartMatch already FOR UPDATE checks)
            const bRes = await pool.query(
              `SELECT user_id, available_balance FROM wallets WHERE user_id = ANY($1::uuid[])`,
              [[p1.userId, p2.userId]]
            );
            const map = new Map(bRes.rows.map(r => [String(r.user_id), Number(r.available_balance)]));

            const p1Ok = (map.get(String(p1.userId)) ?? 0) >= betAmount;
            const p2Ok = (map.get(String(p2.userId)) ?? 0) >= betAmount;

            // Case A: only p1 insufficient
            if (!p1Ok && p2Ok) {
              s1.emit("error", { code: "INSUFFICIENT_BALANCE", message: "Insufficient balance" });
              // requeue p2 preserving position with the *original* joinedAt
              await requeuePreservingPlace(queueKey, p2);
              continue;
            }

            // Case B: only p2 insufficient
            if (p1Ok && !p2Ok) {
              s2.emit("error", { code: "INSUFFICIENT_BALANCE", message: "Insufficient balance" });
              await requeuePreservingPlace(queueKey, p1);
              continue;
            }

            // Case C: both insufficient or generic error → notify whoever is connected; do not requeue
            if (!p1Ok && s1) s1.emit("error", { code: "INSUFFICIENT_BALANCE", message: "Insufficient balance" });
            if (!p2Ok && s2) s2.emit("error", { code: "INSUFFICIENT_BALANCE", message: "Insufficient balance" });
            if (p1Ok && p2Ok) {
              // generic start error, push both back so others can match while this resolves
              await requeuePreservingPlace(queueKey, p1);
              await requeuePreservingPlace(queueKey, p2);
            }
            continue;
          }

          // 8) Build in-memory game
          const game = {
            id: matchId,
            board: Array(9).fill("_"),
            turn: "X",
            players: { X: p1.userId, O: p2.userId },
            sockets: { X: s1, O: s2 },
            timers: { X: INITIAL_TIMER, O: INITIAL_TIMER },
            betAmount,
            timerInterval: null,
            reconnectTimeout: null,
          };
          activeGames.set(matchId, game);

          // 9) Attach socket data and rooms
          s1.data = { matchId, userId: p1.userId, symbol: "X" };
          s2.data = { matchId, userId: p2.userId, symbol: "O" };
          s1.join(matchId);
          s2.join(matchId);

          // 10) Clear queue flags + timers for both
          socketSearching.delete(p1.socketId);
          socketSearching.delete(p2.socketId);
          clearQueueTimeout(p1.socketId);
          clearQueueTimeout(p2.socketId);
          s1.emit("queue_status", { searching: false });
          s2.emit("queue_status", { searching: false });

          // 11) Notify and start game
          s1.emit("match_found", { matchId, symbol: "X", opponentId: p2.userId, betAmount });
          s2.emit("match_found", { matchId, symbol: "O", opponentId: p1.userId, betAmount });
          startTimer(io, matchId);
        }
      } catch (err) {
        console.error("find_match error:", err);
        if (typeof ack === "function") ack({ ok: false, error: "Matchmaking error" });
        socket.emit("error", { code: "MATCH_ERROR", message: "Matchmaking error" });
      }
    });

    // -------------------------------------------------------
    // CANCEL SEARCH
    // -------------------------------------------------------
    socket.on("cancel_find_match", async ({ token }, ack) => {
      try {
        const { sub: userId } = jwt.verify(token, JWT_SECRET);
        const queueKey = socketSearching.get(socket.id);
        if (queueKey) {
          await removeFromQueue(queueKey, userId);
          socketSearching.delete(socket.id);
          clearQueueTimeout(socket.id);
        }
        socket.emit("queue_status", { searching: false });
        if (typeof ack === "function") ack({ ok: true, data: { removed: !!queueKey } });
      } catch (e) {
        if (typeof ack === "function") ack({ ok: false, error: "Cancel failed" });
      }
    });

    socket.on("make_move", async ({ matchId, index, symbol }) => {
      const game = activeGames.get(matchId);
      if (!game) return socket.emit("error", { message: "Invalid game" });

      const userId = socket.data?.userId;
      if (!isValidMove(game, index, symbol) || game.players[symbol] !== userId) {
        return socket.emit("error", { message: "Invalid move" });
      }

      // Apply move
      game.board[index] = symbol;
      game.turn = symbol === "X" ? "O" : "X";

      // Save move to DB
      const moveObj = { index, symbol, user: userId, ts: new Date().toISOString() };
      saveMove(matchId, moveObj).catch(e => console.error("saveMove error:", e));

      // Broadcast
      io.to(matchId).emit("move_made", {
        index,
        symbol,
        board: game.board,
        turn: game.turn,
        timers: game.timers,
      });

      // Keep timer ticking for next turn
      startTimer(io, matchId);

      // Win?
      if (checkWin(game.board, symbol)) {
        clearInterval(game.timerInterval);
        const prize = game.betAmount * 2;
        finishAndPayout(matchId, symbol, userId, prize)
          .catch(err => console.error("finishAndPayout win err:", err));

        io.to(matchId).emit("game_won", {
          winnerSymbol: symbol,
          winnerId: userId,
          reason: "win",
        });
        cleanupGame(matchId);
        return;
      }

      // Draw → new round
      if (checkDraw(game.board)) {
        // reset board & swap symbols/sockets
        game.board = [...INITIAL_BOARD];
        game.turn = "X";
        const oldPlayers = { ...game.players };
        const oldSockets = { ...game.sockets };
        game.players = { X: oldPlayers.O, O: oldPlayers.X };
        game.sockets = { X: oldSockets.O, O: oldSockets.X };

        // update symbols on socket.data
        if (game.sockets.X) game.sockets.X.data.symbol = "X";
        if (game.sockets.O) game.sockets.O.data.symbol = "O";

        io.to(matchId).emit("game_draw");

        if (game.sockets.X) {
          game.sockets.X.emit("new_round", {
            id: game.id,
            board: game.board,
            turn: game.turn,
            players: game.players,
            timers: game.timers,
            betAmount: game.betAmount,
            symbol: "X",
          });
        }
        if (game.sockets.O) {
          game.sockets.O.emit("new_round", {
            id: game.id,
            board: game.board,
            turn: game.turn,
            players: game.players,
            timers: game.timers,
            betAmount: game.betAmount,
            symbol: "O",
          });
        }

        startTimer(io, matchId);
      }
    });

    // ------- Leave match (forfeit) -------
    socket.on("leave_match", async ({ token, matchId }, ack) => {
      try {
        const { sub: userId } = jwt.verify(token, JWT_SECRET);
        const game = activeGames.get(matchId);
        if (!game) {
          if (typeof ack === "function") ack({ ok: true, data: { done: true } });
          return;
        }
        // determine opponent
        const mySymbol = game.players.X === userId ? "X" : (game.players.O === userId ? "O" : null);
        if (!mySymbol) {
          if (typeof ack === "function") ack({ ok: false, error: "Not your game" });
          return;
        }
        const opponentSymbol = mySymbol === "X" ? "O" : "X";
        const winnerId = game.players[opponentSymbol];
        const prize = game.betAmount * 2;

        await finishAndPayout(matchId, opponentSymbol, winnerId, prize).catch(e => console.error(e));
        if (game.sockets[opponentSymbol]) {
          game.sockets[opponentSymbol].emit("opponent_forfeited");
        }
        io.to(matchId).emit("game_won", {
          winnerSymbol: opponentSymbol,
          winnerId,
          reason: "opponent_left",
        });
        cleanupGame(matchId);
        if (typeof ack === "function") ack({ ok: true, data: { done: true } });
      } catch (e) {
        if (typeof ack === "function") ack({ ok: false, error: "Leave failed" });
      }
    });
    // ------- Disconnect / Reconnect -------
    socket.on("disconnect", async () => {
      // if searching: remove from queue and clear timer
      const qKey = socketSearching.get(socket.id);
      if (qKey) {
        const items = await redis.lrange(qKey, 0, -1);
        for (const raw of items) {
          const entry = JSON.parse(raw);
          if (entry.socketId === socket.id) {
            await redis.lrem(qKey, 1, raw);
            break;
          }
        }
        socketSearching.delete(socket.id);
        clearQueueTimeout(socket.id); // NEW
        socket.emit?.("queue_status", { searching: false });
      }

      const { matchId, symbol } = socket.data || {};
      if (!matchId || !activeGames.has(matchId)) return;

      const game = activeGames.get(matchId);
      if (game.reconnectTimeout) clearTimeout(game.reconnectTimeout);

      game.reconnectTimeout = setTimeout(async () => {
        if (!activeGames.has(matchId)) return;
        const opponentSymbol = symbol === "X" ? "O" : "X";
        const winnerId = game.players[opponentSymbol];
        const prize = game.betAmount * 2;

        await finishAndPayout(matchId, opponentSymbol, winnerId, prize)
          .catch(err => console.error("finishAndPayout forfeit err:", err));

        const oppSock = game.sockets[opponentSymbol];
        if (oppSock) oppSock.emit("opponent_forfeited");
        cleanupGame(matchId);
      }, RECONNECT_GRACE);
    });

        socket.on("reconnect_match", ({ token, matchId }) => {
          try {
            const { sub: userId } = jwt.verify(token, JWT_SECRET);
            const game = activeGames.get(matchId);
            if (!game) return socket.emit("error", { message: "Game expired" });
    
            const symbol =
              game.players.X === userId ? "X" :
              game.players.O === userId ? "O" : null;
    
            if (!symbol) return socket.emit("error", { message: "Not your game" });
    
            if (game.reconnectTimeout) clearTimeout(game.reconnectTimeout);
            game.sockets[symbol] = socket;
            socket.data = { matchId, userId, symbol };
            socket.join(matchId);
    
            socket.emit("reconnected", {
              matchId,
              symbol,
              board: game.board,
              turn: game.turn,
              timers: game.timers,
            });
          } catch (e) {
            socket.emit("error", { message: "Reconnect failed" });
          }
        });
  });
}

module.exports = { setupGameSocket };
