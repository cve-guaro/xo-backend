// src/socket/spinRoom.js
// ────────────────────────────────────────────────────────────────────────────
// Spin room state machine + Socket.IO event handlers.
// Server-authoritative: the winning slice is determined AT LOCK TIME,
// before any animation plays on any client.
//
// Room lifecycle: waiting → locked → spinning → resolved → payout → reset
// ────────────────────────────────────────────────────────────────────────────
const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");
const jwt = require("jsonwebtoken");
const { pool, redis, getGlobalSetting } = require("../db/index");
const { debitWager, creditWinnings, refundWager, calculateSpinPrize } = require("../services/spinWalletService");
const { scheduleBotFill } = require("./spinBot");

const LOG_PREFIX = "[SPIN_ROOM]";
const JWT_SECRET = process.env.JWT_SECRET;

// ── In-memory state ────────────────────────────────────────────────────────
// activeSpinRounds: Map<roundId, RoundState>
const activeSpinRounds = new Map();

// playerToRound: Map<userId, roundId> — prevents double-joining
const playerToRound = new Map();

// ── Round state shape ──────────────────────────────────────────────────────
// {
//   id: string (UUID),
//   configId: number,
//   betAmount: number,
//   maxPlayers: number,
//   houseCutPercent: number,
//   roomName: string,
//   status: 'waiting' | 'locked' | 'spinning' | 'resolved' | 'paid',
//   players: [{ userId, username, isBot, seatIndex, bonusUsed, avatar }],
//   winningSlice: number | null,
//   winnerId: string | null,
//   winnerName: string | null,
//   prizeAmount: number,
//   countdown: number,
//   countdownInterval: NodeJS.Timeout | null,
//   botCancelFn: (() => void) | null,
//   createdAt: Date,
// }

// ── Config cache (refreshed from DB on demand) ─────────────────────────────
let _configCache = null;
let _configCacheTs = 0;
const CONFIG_CACHE_TTL = 30_000; // 30s



async function getSpinConfigs() {
  const now = Date.now();
  if (_configCache && (now - _configCacheTs) < CONFIG_CACHE_TTL) {
    const entryAmount = await getGlobalSetting('spin_5p_entry_amount', 100);
    _configCache = _configCache.map(c => {
      if (c.id === 1) return { ...c, bet_amount: entryAmount };
      return c;
    });
    return _configCache;
  }
  try {
    const { rows } = await pool.query(
      `SELECT id, name, bet_amount, max_players, house_cut_percent, is_active
       FROM spin_room_configs WHERE is_active = true ORDER BY id ASC`
    );
    const entryAmount = await getGlobalSetting('spin_5p_entry_amount', 100);
    const updatedRows = rows.map(c => {
      if (c.id === 1) return { ...c, bet_amount: entryAmount };
      return c;
    });
    _configCache = updatedRows;
    _configCacheTs = now;
    return updatedRows;
  } catch (err) {
    console.error(`${LOG_PREFIX} Failed to load configs:`, err.message);
    return _configCache || [];
  }
}

// ── Find or create a waiting round for a given config ──────────────────────
function findWaitingRound(configId) {
  for (const [id, round] of activeSpinRounds) {
    if (round.configId === configId && round.status === "waiting" && round.players.length < round.maxPlayers) {
      return round;
    }
  }
  return null;
}

function createRound(config) {
  const isRail = config.id === 2;
  const round = {
    id: uuidv4(),
    configId: config.id,
    mode: isRail ? "RAIL" : "5_PLAYER",
    betAmount: isRail ? 0 : Number(config.bet_amount),
    maxPlayers: isRail ? 9999 : (config.max_players || 5),
    houseCutPercent: Number(config.house_cut_percent || 10),
    roomName: isRail ? "Rail Spin" : "5-Player Spin",
    status: "waiting",
    players: [],
    winningSlice: null,
    winnerId: null,
    winnerName: null,
    prizeAmount: 0,
    countdown: isRail ? 60 : 0, // 60s countdown for Rail, 5_PLAYER has NO countdown (waits for 5 players)
    countdownInterval: null,
    botCancelFn: null,
    createdAt: new Date(),
  };
  activeSpinRounds.set(round.id, round);
  return round;
}

// ── JWT verification (same as game.js) ─────────────────────────────────────
function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] });
}

// ── Broadcast helpers ──────────────────────────────────────────────────────
function broadcastToRound(io, round, event, payload) {
  io.to(`spin:${round.id}`).emit(event, payload);
}

function buildRoomState(round) {
  const pot = round.players.reduce((sum, p) => sum + Number(p.stake), 0);
  return {
    roundId: round.id,
    configId: round.configId,
    mode: round.mode,
    betAmount: round.betAmount,
    maxPlayers: round.maxPlayers,
    roomName: round.roomName,
    status: round.status,
    countdown: round.countdown,
    players: round.players.map(p => ({
      userId: p.userId,
      username: p.username,
      seatIndex: p.seatIndex,
      avatar: p.avatar || null,
      isBot: p.isBot,
      stake: Number(p.stake),
    })),
    pot,
  };
}

// ── Countdown & auto-lock ──────────────────────────────────────────────────
function startCountdown(io, round) {
  if (round.countdownInterval) return; // already running

  round.countdownInterval = setInterval(() => {
    round.countdown -= 1;

    broadcastToRound(io, round, "spin:countdown", { secondsLeft: round.countdown });

    if (round.countdown <= 0) {
      clearInterval(round.countdownInterval);
      round.countdownInterval = null;

      // Cancel pending bots
      if (round.botCancelFn) {
        round.botCancelFn();
        round.botCancelFn = null;
      }

      // Need at least 2 players to proceed
      if (round.players.length >= 2) {
        lockRound(io, round);
      } else {
        // Not enough players — cancel and refund
        cancelRound(io, round);
      }
    }
  }, 1000);
}

// ── Lock round (determine outcome) ────────────────────────────────────────
async function lockRound(io, round) {
  if (round.status !== "waiting") return;

  round.status = "locked";
  
  const pot = round.players.reduce((sum, p) => sum + Number(p.stake), 0);
  
  // ★ SERVER-AUTHORITATIVE OUTCOME ★
  // Determine winner with weighted stakes for RAIL mode
  let winnerIndex = 0;
  if (round.mode === "5_PLAYER") {
    winnerIndex = crypto.randomInt(0, round.players.length);
  } else {
    // Weighted stake probability selection
    const rand = Math.random() * pot;
    let accum = 0;
    for (let i = 0; i < round.players.length; i++) {
      accum += Number(round.players[i].stake);
      if (rand < accum) {
        winnerIndex = i;
        break;
      }
    }
  }

  round.winningSlice = winnerIndex;
  const winner = round.players[winnerIndex];
  round.winnerId = winner.userId;
  round.winnerName = winner.username;

  // Calculate prize
  const { prize } = calculateSpinPrize(pot, round.houseCutPercent);
  round.prizeAmount = prize;

  console.log(
    `${LOG_PREFIX} LOCKED round=${round.id} mode=${round.mode} players=${round.players.length} ` +
    `winner=${winner.username}(slot=${round.winningSlice}) pot=${pot} prize=${prize}`
  );

  // Persist to DB
  try {
    await pool.query(
      `UPDATE spin_rounds SET status = 'locked', winning_slice = $1, winner_user_id = $2,
       pot_amount = $3, prize_amount = $4, players = $5::jsonb, locked_at = NOW()
       WHERE id = $6::uuid`,
      [round.winningSlice, winner.isBot ? null : winner.userId, pot, prize, JSON.stringify(round.players), round.id]
    );
  } catch (err) {
    console.error(`${LOG_PREFIX} DB lock update failed:`, err.message);
  }

  // Broadcast locked state
  broadcastToRound(io, round, "spin:locked", {
    roundId: round.id,
    players: round.players.map(p => ({
      userId: p.userId,
      username: p.username,
      seatIndex: p.seatIndex,
      avatar: p.avatar || null,
      stake: Number(p.stake),
    })),
    pot,
  });

  // Start spin after brief pause (1.5s)
  setTimeout(() => startSpin(io, round), 1500);
}

// ── Spin phase ─────────────────────────────────────────────────────────────
function startSpin(io, round) {
  if (round.status !== "locked") return;

  round.status = "spinning";
  const spinDuration = 5000; // 5 seconds of animation

  // Broadcast spin start with the winning slice
  // Client uses this to calculate the final rotation angle
  broadcastToRound(io, round, "spin:start", {
    roundId: round.id,
    winningSlice: round.winningSlice,
    spinDuration,
    playerCount: round.players.length,
  });

  console.log(`${LOG_PREFIX} SPINNING round=${round.id} duration=${spinDuration}ms`);

  // Wait for animation to finish, then resolve
  setTimeout(() => resolveRound(io, round), spinDuration + 500);
}

// ── Resolve & Payout ───────────────────────────────────────────────────────
async function resolveRound(io, round) {
  if (round.status !== "spinning") return;

  round.status = "resolved";

  // Broadcast result
  broadcastToRound(io, round, "spin:result", {
    roundId: round.id,
    winnerId: round.winnerId,
    winnerName: round.winnerName,
    winningSlice: round.winningSlice,
    prizeAmount: round.prizeAmount,
  });

  console.log(`${LOG_PREFIX} RESOLVED round=${round.id} winner=${round.winnerName} prize=${round.prizeAmount}`);

  // Payout
  try {
    const winner = round.players[round.winningSlice];
    await creditWinnings({
      userId: winner.userId,
      prizeAmount: round.prizeAmount,
      bonusUsed: winner.bonusUsed || 0,
      roundId: round.id,
      isBot: winner.isBot,
    });

    round.status = "paid";

    // Update DB
    await pool.query(
      `UPDATE spin_rounds SET status = 'paid', resolved_at = NOW() WHERE id = $1::uuid`,
      [round.id]
    );

    // Emit global win event (same pattern as XO Game)
    if (!winner.isBot) {
      io.emit("global_win", {
        username: winner.username,
        amount: round.prizeAmount,
        timestamp: Date.now(),
        game_type: "SPIN",
      });
    }
  } catch (err) {
    console.error(`${LOG_PREFIX} Payout failed for round=${round.id}:`, err.message);
  }

  // Clean up after 5 seconds
  setTimeout(() => cleanupRound(round), 5000);
}

// ── Cancel round (not enough players) ──────────────────────────────────────
async function cancelRound(io, round) {
  if (round.status !== "waiting") return;

  round.status = "cancelled";
  if (round.countdownInterval) {
    clearInterval(round.countdownInterval);
    round.countdownInterval = null;
  }
  if (round.botCancelFn) {
    round.botCancelFn();
    round.botCancelFn = null;
  }

  console.log(`${LOG_PREFIX} CANCELLED round=${round.id} (only ${round.players.length} players)`);

  // Refund all real players their specific wagers
  for (const player of round.players) {
    try {
      await refundWager({
        userId: player.userId,
        amount: player.stake,
        bonusUsed: player.bonusUsed || 0,
        roundId: round.id,
        isBot: player.isBot,
      });
    } catch (err) {
      console.error(`${LOG_PREFIX} Refund failed for user=${player.userId}:`, err.message);
    }
    playerToRound.delete(player.userId);
  }

  broadcastToRound(io, round, "spin:cancelled", {
    roundId: round.id,
    reason: "Not enough players",
  });

  // Update DB
  try {
    await pool.query(
      `UPDATE spin_rounds SET status = 'cancelled', resolved_at = NOW() WHERE id = $1::uuid`,
      [round.id]
    );
  } catch (err) {
    console.error(`${LOG_PREFIX} DB cancel update failed:`, err.message);
  }

  cleanupRound(round);
}

// ── Cleanup ────────────────────────────────────────────────────────────────
function cleanupRound(round) {
  // Remove player→round mappings
  for (const player of round.players) {
    if (playerToRound.get(player.userId) === round.id) {
      playerToRound.delete(player.userId);
    }
  }
  activeSpinRounds.delete(round.id);
  console.log(`${LOG_PREFIX} Cleaned up round=${round.id}`);
}

// ── Add player to round (with debit) ───────────────────────────────────────
async function addPlayerToRound(io, round, { userId, username, isBot, avatar, stake }) {
  if (round.status !== "waiting") {
    throw new Error("ROUND_NOT_WAITING");
  }
  if (round.players.length >= round.maxPlayers) {
    throw new Error("ROUND_FULL");
  }
  if (round.players.some(p => p.userId === userId)) {
    throw new Error("ALREADY_IN_ROUND");
  }

  const finalStake = round.mode === "5_PLAYER" ? round.betAmount : Number(stake);
  if (isNaN(finalStake) || finalStake <= 0) {
    throw new Error("INVALID_STAKE");
  }

  const seatIndex = round.players.length;

  // Debit wager (inside a transaction for real players)
  let bonusUsed = 0;
  if (!isBot) {
    const { pool: pgPool } = require("../db/index");
    const client = await pgPool.connect();
    try {
      await client.query("BEGIN");
      const result = await debitWager(client, {
        userId,
        amount: finalStake,
        roundId: round.id,
        isBot: false,
      });
      bonusUsed = result.bonusUsed;

      // Record bet in DB
      await client.query(
        `INSERT INTO spin_bets (id, round_id, user_id, amount, is_bot, seat_index)
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3, $4, $5)`,
        [round.id, userId, finalStake, false, seatIndex]
      );

      await client.query("COMMIT");
    } catch (err) {
      try { await client.query("ROLLBACK"); } catch {}
      throw err;
    } finally {
      client.release();
    }
  } else {
    // Bot — just record the bet, no real debit
    try {
      await pool.query(
        `INSERT INTO spin_bets (id, round_id, user_id, amount, is_bot, seat_index)
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3, $4, $5)`,
        [round.id, userId, finalStake, true, seatIndex]
      );
    } catch (err) {
      console.error(`${LOG_PREFIX} Bot bet record failed:`, err.message);
    }
  }

  const player = { userId, username, isBot, seatIndex, bonusUsed, avatar, stake: finalStake };
  round.players.push(player);

  if (!isBot) {
    playerToRound.set(userId, round.id);
  }

  // Broadcast player joined
  broadcastToRound(io, round, "spin:player_joined", {
    roundId: round.id,
    userId,
    username,
    seatIndex,
    avatar,
    stake: finalStake,
    currentPlayers: round.players.length,
    maxPlayers: round.maxPlayers,
  });

  console.log(`${LOG_PREFIX} Player joined: ${username}${isBot ? ' (BOT)' : ''} seat=${seatIndex} stake=${finalStake} round=${round.id} (${round.players.length}/${round.maxPlayers})`);

  // If 5_PLAYER room is full, lock immediately
  if (round.mode === "5_PLAYER" && round.players.length >= round.maxPlayers) {
    if (round.countdownInterval) {
      clearInterval(round.countdownInterval);
      round.countdownInterval = null;
    }
    if (round.botCancelFn) {
      round.botCancelFn();
      round.botCancelFn = null;
    }
    lockRound(io, round);
  }

  return { seatIndex, roundId: round.id };
}

// ══════════════════════════════════════════════════════════════════════════════
// ██  SOCKET.IO SETUP
// ══════════════════════════════════════════════════════════════════════════════
function setupSpinSocket(io) {
  console.log(`${LOG_PREFIX} Spin socket handlers registered.`);

  io.on("connection", (socket) => {
    // ── spin:join ──────────────────────────────────────────────────────
    socket.on("spin:join", async (data, ack) => {
      try {
        const { mode, token, stake } = data || {};
        if (!token || !mode) {
          return ack?.({ ok: false, error: "Missing mode or token" });
        }

        // Verify JWT
        let decoded;
        try {
          decoded = verifyToken(token);
        } catch {
          return ack?.({ ok: false, error: "AUTH_FAILED" });
        }

        const userId = decoded.sub || decoded.userId || decoded.id;
        if (!userId) return ack?.({ ok: false, error: "AUTH_FAILED" });

        // Check if Spin game is globally enabled
        const isEnabled = await getGlobalSetting("spin_game_enabled", true);
        if (!isEnabled) {
          return ack?.({ ok: false, error: "SPIN_GAME_DISABLED" });
        }

        // Check if player is already in a spin round
        if (playerToRound.has(userId)) {
          const existingRoundId = playerToRound.get(userId);
          const existingRound = activeSpinRounds.get(existingRoundId);
          if (existingRound && existingRound.status !== "resolved" && existingRound.status !== "paid" && existingRound.status !== "cancelled") {
            // Reconnect to existing round
            socket.join(`spin:${existingRoundId}`);
            socket.data = { ...(socket.data || {}), spinRoundId: existingRoundId, userId };
            return ack?.({ ok: true, reconnect: true, data: buildRoomState(existingRound) });
          }
          // Stale mapping — clean up
          playerToRound.delete(userId);
        }

        // Check if player is in an XO game
        const inGame = await redis.get(`in_game:${userId}`).catch(() => null);
        if (inGame) {
          return ack?.({ ok: false, error: "ALREADY_IN_GAME" });
        }

        // Resolve Config
        const configs = await getSpinConfigs();
        const config = configs.find(c => c.name === mode || (mode === "5_PLAYER" && c.id === 1) || (mode === "RAIL" && c.id === 2));
        if (!config) {
          return ack?.({ ok: false, error: "INVALID_ROOM" });
        }

        // Get user info
        const userRes = await pool.query(
          `SELECT id, username, avatar FROM users WHERE id = $1::uuid`,
          [userId]
        );
        if (userRes.rowCount === 0) {
          return ack?.({ ok: false, error: "USER_NOT_FOUND" });
        }
        const user = userRes.rows[0];

        // Find or create a waiting round
        let round = findWaitingRound(config.id);
        if (!round) {
          round = createRound(config);
          
          // Persist round to DB
          try {
            await pool.query(
              `INSERT INTO spin_rounds (id, config_id, status, players, created_at)
               VALUES ($1::uuid, $2, 'waiting', '[]'::jsonb, NOW())`,
              [round.id, config.id]
            );
          } catch (err) {
            console.error(`${LOG_PREFIX} DB round insert failed:`, err.message);
          }
        }

        // Join socket room
        socket.join(`spin:${round.id}`);
        socket.data = { ...(socket.data || {}), spinRoundId: round.id, userId };

        // Add player
        const result = await addPlayerToRound(io, round, {
          userId,
          username: user.username || "Player",
          isBot: false,
          avatar: user.avatar || null,
          stake: Number(stake || 0),
        });

        // Manage bot scheduling
        const railBotsEnabled = await getGlobalSetting("spin_rail_bots_enabled", true);
        const fivepBotsEnabled = await getGlobalSetting("spin_5p_bots_enabled", false);

        if (round.status === "waiting" && round.players.length < round.maxPlayers) {
          if (round.botCancelFn) {
            round.botCancelFn();
            round.botCancelFn = null;
          }

          if (round.mode === "RAIL") {
            if (round.players.length - round.players.filter(p => p.isBot).length === 1 && !round.countdownInterval) {
              startCountdown(io, round);
            }
            if (railBotsEnabled) {
              round.botCancelFn = scheduleBotFill({
                maxBots: 5,
                currentPlayerCount: round.players.length,
                maxPlayers: round.maxPlayers,
                onBotJoin: async (bot) => {
                  if (round.status !== "waiting" || round.players.length >= round.maxPlayers) return;
                  const botStake = 10;
                  try {
                    await addPlayerToRound(io, round, {
                      userId: bot.id,
                      username: bot.username,
                      isBot: true,
                      avatar: null,
                      stake: botStake,
                    });
                  } catch (err) {
                    console.error(`${LOG_PREFIX} Bot join failed:`, err.message);
                  }
                },
                minDelayMs: 8000,
                maxDelayMs: 15000,
              });
            }
          } else if (round.mode === "5_PLAYER") {
            if (fivepBotsEnabled) {
              const spin5pEntryStr = await getGlobalSetting("spin_5p_entry_amount", "100");
              const spin5pEntry = Number(spin5pEntryStr || 100);

              round.botCancelFn = scheduleBotFill({
                maxBots: 4,
                currentPlayerCount: round.players.length,
                maxPlayers: round.maxPlayers,
                onBotJoin: async (bot) => {
                  if (round.status !== "waiting" || round.players.length >= round.maxPlayers) return;
                  try {
                    await addPlayerToRound(io, round, {
                      userId: bot.id,
                      username: bot.username,
                      isBot: true,
                      avatar: null,
                      stake: spin5pEntry,
                    });
                  } catch (err) {
                    console.error(`${LOG_PREFIX} 5-Player Bot join failed:`, err.message);
                  }
                },
                minDelayMs: 6000,
                maxDelayMs: 12000,
              });
            }
          }
        }

        // Send full state to the joining player
        ack?.({ ok: true, data: buildRoomState(round), seatIndex: result.seatIndex });

      } catch (err) {
        console.error(`${LOG_PREFIX} spin:join error:`, err);
        const errorMsg = err.message === "INSUFFICIENT_BALANCE" ? "INSUFFICIENT_BALANCE" :
                         err.message === "ALREADY_IN_ROUND" ? "ALREADY_IN_ROUND" :
                         err.message === "ROUND_FULL" ? "ROUND_FULL" :
                         err.message === "INVALID_STAKE" ? "INVALID_STAKE" :
                         "JOIN_FAILED";
        ack?.({ ok: false, error: errorMsg });
      }
    });

    // ── spin:add_stake ──────────────────────────────────────────────────
    socket.on("spin:add_stake", async (data, ack) => {
      try {
        const { amount, token } = data || {};
        if (!token) return ack?.({ ok: false, error: "AUTH_FAILED" });

        let decoded;
        try { decoded = verifyToken(token); } catch { return ack?.({ ok: false, error: "AUTH_FAILED" }); }

        const userId = decoded.sub || decoded.userId || decoded.id;
        const roundId = socket.data?.spinRoundId;
        if (!roundId) return ack?.({ ok: false, error: "NOT_IN_ROUND" });

        const round = activeSpinRounds.get(roundId);
        if (!round) return ack?.({ ok: false, error: "ROUND_NOT_FOUND" });

        if (round.status !== "waiting") {
          return ack?.({ ok: false, error: "ROUND_LOCKED" });
        }

        // Lock period constraint: cannot add stake if countdown is less than or equal to 3 seconds
        if (round.countdown !== undefined && round.countdown <= 3) {
          return ack?.({ ok: false, error: "ROUND_LOCKED" });
        }

        const stakeAdd = Number(amount);
        if (isNaN(stakeAdd) || stakeAdd <= 0) {
          return ack?.({ ok: false, error: "INVALID_STAKE" });
        }

        // Find the player in round.players
        const player = round.players.find(p => p.userId === userId);
        if (!player) return ack?.({ ok: false, error: "PLAYER_NOT_IN_ROUND" });

        // Debit the additional wager
        const { pool: pgPool } = require("../db/index");
        const client = await pgPool.connect();
        try {
          await client.query("BEGIN");
          
          const debitResult = await debitWager(client, {
            userId,
            amount: stakeAdd,
            roundId: round.id,
            isBot: false,
          });

          // Accumulate the bonus used
          player.bonusUsed = Number(player.bonusUsed || 0) + Number(debitResult.bonusUsed || 0);

          // Update the existing bet in spin_bets
          await client.query(
            `UPDATE spin_bets 
             SET amount = amount + $1 
             WHERE round_id = $2::uuid AND user_id = $3::uuid`,
            [stakeAdd, round.id, userId]
          );

          await client.query("COMMIT");
        } catch (err) {
          try { await client.query("ROLLBACK"); } catch {}
          throw err;
        } finally {
          client.release();
        }

        // Update memory state
        player.stake = Number(player.stake || 0) + stakeAdd;
        round.pot = round.players.reduce((sum, p) => sum + Number(p.stake || 0), 0);

        // Broadcast stake increase to everyone in the room
        broadcastToRound(io, round, "spin:stake_updated", {
          roundId: round.id,
          userId,
          newStake: player.stake,
          pot: round.pot,
        });

        console.log(`${LOG_PREFIX} Player ${player.username} added ${stakeAdd} stake. Total stake: ${player.stake}. Round: ${round.id}. Pot: ${round.pot}`);

        ack?.({ ok: true, newStake: player.stake, pot: round.pot });
      } catch (err) {
        console.error(`${LOG_PREFIX} spin:add_stake error:`, err.message);
        const errorMsg = err.message === "INSUFFICIENT_BALANCE" ? "INSUFFICIENT_BALANCE" : "STAKE_ADD_FAILED";
        ack?.({ ok: false, error: errorMsg });
      }
    });

    // ── spin:leave ─────────────────────────────────────────────────────
    socket.on("spin:leave", async (data, ack) => {
      try {
        const { roundId, token } = data || {};
        if (!token) return ack?.({ ok: false, error: "AUTH_FAILED" });

        let decoded;
        try { decoded = verifyToken(token); } catch { return ack?.({ ok: false, error: "AUTH_FAILED" }); }

        const userId = decoded.sub || decoded.userId || decoded.id;
        let round = activeSpinRounds.get(roundId);

        // Fallback lookup via playerToRound mapping
        if (!round && playerToRound.has(userId)) {
          const userRoundId = playerToRound.get(userId);
          round = activeSpinRounds.get(userRoundId);
        }

        if (!round) {
          playerToRound.delete(userId);
          return ack?.({ ok: true });
        }

        const playerIdx = round.players.findIndex(p => p.userId === userId && !p.isBot);
        if (playerIdx === -1) {
          playerToRound.delete(userId);
          return ack?.({ ok: true });
        }

        const player = round.players[playerIdx];

        // Refund if leaving before spin starts (waiting or pre_countdown)
        if (round.status === "waiting" || round.status === "pre_countdown") {
          await refundWager({
            userId,
            amount: player.stake,
            bonusUsed: player.bonusUsed || 0,
            roundId: round.id,
            isBot: false,
          }).catch(err => console.error(`${LOG_PREFIX} Refund on leave error:`, err.message));
        }

        // Remove from round
        round.players.splice(playerIdx, 1);
        // Re-index seat numbers
        round.players.forEach((p, i) => { p.seatIndex = i; });

        playerToRound.delete(userId);
        socket.leave(`spin:${round.id}`);

        broadcastToRound(io, round, "spin:player_left", {
          roundId: round.id,
          userId,
          currentPlayers: round.players.length,
        });

        // If no real players left, cancel the round
        const realPlayers = round.players.filter(p => !p.isBot);
        if (realPlayers.length === 0) {
          cancelRound(io, round);
        }

        console.log(`${LOG_PREFIX} User ${userId} successfully left round ${round.id}`);
        ack?.({ ok: true });
      } catch (err) {
        console.error(`${LOG_PREFIX} spin:leave error:`, err.message);
        ack?.({ ok: false, error: "LEAVE_FAILED" });
      }
    });

    // ── spin:get_rooms ─────────────────────────────────────────────────
    socket.on("spin:get_rooms", async (data, ack) => {
      try {
        const configs = await getSpinConfigs();

        const rooms = configs.map(config => {
          // Count active waiting rounds for this config
          let currentPlayers = 0;
          let activeRoundId = null;
          for (const [id, round] of activeSpinRounds) {
            if (round.configId === config.id && round.status === "waiting") {
              currentPlayers = round.players.length;
              activeRoundId = id;
              break;
            }
          }

          return {
            id: config.id,
            name: config.name,
            betAmount: Number(config.bet_amount),
            maxPlayers: config.max_players || 5,
            houseCutPercent: Number(config.house_cut_percent || 10),
            currentPlayers,
            activeRoundId,
            estimatedPrize: calculateSpinPrize(
              Number(config.bet_amount) * (config.max_players || 5),
              Number(config.house_cut_percent || 10)
            ).prize,
          };
        });

        ack?.({ ok: true, data: rooms });
      } catch (err) {
        console.error(`${LOG_PREFIX} spin:get_rooms error:`, err.message);
        ack?.({ ok: false, error: "LOAD_FAILED" });
      }
    });

    // ── Handle voice chat relay ─────────────────────────────────────────
    socket.on("spin:voice_chunk", (data) => {
      const userId = socket.data?.userId;
      const roundId = socket.data?.spinRoundId;
      if (!userId || !roundId) return;

      // Broadcast voice chunk to other players in the room
      socket.to(`spin:${roundId}`).emit("spin:voice_chunk", {
        userId,
        chunk: data.chunk, // ArrayBuffer or base64 audio data
      });
    });

    // ── Handle host voice moderation ────────────────────────────────────
    socket.on("spin:mute_player", async (data, ack) => {
      const userId = socket.data?.userId;
      const roundId = socket.data?.spinRoundId;
      if (!userId || !roundId) return ack?.({ ok: false, error: "UNAUTHORIZED" });

      const round = activeSpinRounds.get(roundId);
      if (!round) return ack?.({ ok: false, error: "ROOM_NOT_FOUND" });

      // Host is the first player who joined
      const host = round.players[0];
      if (!host || host.userId !== userId) {
        return ack?.({ ok: false, error: "NOT_HOST" });
      }

      const { targetUserId, muted } = data || {};
      if (!targetUserId) return ack?.({ ok: false, error: "INVALID_TARGET" });

      // Find target player
      const targetPlayer = round.players.find(p => p.userId === targetUserId);
      if (!targetPlayer) return ack?.({ ok: false, error: "PLAYER_NOT_IN_ROOM" });
      if (targetPlayer.isBot) return ack?.({ ok: false, error: "CANNOT_MUTE_BOT" });

      // Broadcast to room
      io.to(`spin:${roundId}`).emit("spin:player_muted", {
        userId: targetUserId,
        muted,
        mutedBy: userId,
      });

      ack?.({ ok: true });
    });

    // ── Handle disconnect ──────────────────────────────────────────────
    socket.on("disconnect", async () => {
      const userId = socket.data?.userId;
      let roundId = socket.data?.spinRoundId;

      if (!userId) return;
      if (!roundId && playerToRound.has(userId)) {
        roundId = playerToRound.get(userId);
      }
      if (!roundId) return;

      const round = activeSpinRounds.get(roundId);
      if (!round) {
        playerToRound.delete(userId);
        return;
      }

      const playerIdx = round.players.findIndex(p => p.userId === userId && !p.isBot);
      if (playerIdx !== -1) {
        const player = round.players[playerIdx];

        if (round.status === "waiting" || round.status === "pre_countdown") {
          await refundWager({
            userId,
            amount: player.stake,
            bonusUsed: player.bonusUsed || 0,
            roundId: round.id,
            isBot: false,
          }).catch(err => console.error(`${LOG_PREFIX} Disconnect refund error:`, err.message));

          round.players.splice(playerIdx, 1);
          round.players.forEach((p, i) => { p.seatIndex = i; });
          playerToRound.delete(userId);

          broadcastToRound(io, round, "spin:player_left", {
            roundId: round.id,
            userId,
            currentPlayers: round.players.length,
          });

          const realPlayers = round.players.filter(p => !p.isBot);
          if (realPlayers.length === 0) {
            cancelRound(io, round);
          }
        }
      }
    });
  });
}

module.exports = {
  setupSpinSocket,
  activeSpinRounds,
  getSpinConfigs,
};
