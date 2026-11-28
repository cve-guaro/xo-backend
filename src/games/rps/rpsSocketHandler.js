/**
 * rpsSocketHandler.js — Socket.IO event handler for Rock Paper Scissors.
 *
 * Wiring: called from server.js as setupRPSSocket(io).
 *
 * Events (client → server):
 *   rps:find_match   { stakeAmount }              → join matchmaking queue
 *   rps:cancel_search                              → leave matchmaking queue
 *   rps:lock_choice  { roomId, choice }            → commit a choice
 *   rps:leave        { roomId }                    → leave a room
 *
 * Events (server → client):
 *   rps:searching     { stakeAmount, position }
 *   rps:match_found   { roomId, opponentId, opponentUsername, stakeAmount, youAre, prizeAmount }
 *   rps:phase_change  { phase, duration, round? }
 *   rps:opponent_locked {}
 *   rps:round_reveal  { round, choiceP1, choiceP2, result, roundWinner, scoreP1, scoreP2 }
 *   rps:match_result  { winnerId, loserId, scoreP1, scoreP2, prizeAmount, rounds }
 *   rps:match_cancelled { reason }
 *   rps:error         { code, message }
 *
 * COMMIT-REVEAL: opponent's choice is NEVER sent until both are locked.
 * MONEY: all payout and refund happen inside DB transactions with idempotency keys.
 */

const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { pool, redis } = require('../../db/index');
const { deductStake } = require('../../models/stake');
const { ledgerFirstCredit } = require('../../models/ledgerFirstCredit');
const {
  PHASES, TIMINGS, BET_TIERS, VALID_BETS, FEE_PERCENT,
  createGame, startMatch, startRound, lockChoice, handleTimeout,
  handleDisconnect, cancelGame, generatePayoutIdempotencyKey,
} = require('./RPSGame');
const {
  activeRooms, playerToRoom,
  enqueue, dequeue, getRoom, getPlayerRoomId, getPlayerGame,
  cleanupRoom, isPlayerInGame, getQueueSizes, listActiveRooms,
} = require('./RPSRoomManager');

const LOG_PREFIX = '[RPS_SOCKET]';
const JWT_SECRET = process.env.JWT_SECRET;
const IN_GAME_TTL_MS = 3600_000;

async function setRpsInGameLocks(p1Id, p2Id) {
  const tasks = [];
  if (p1Id) tasks.push(redis.set(`in_game:${p1Id}`, 'rps', 'PX', IN_GAME_TTL_MS).catch(() => {}));
  if (p2Id) tasks.push(redis.set(`in_game:${p2Id}`, 'rps', 'PX', IN_GAME_TTL_MS).catch(() => {}));
  await Promise.all(tasks);
}

async function clearRpsInGameLockForUser(userId) {
  if (!userId) return;
  const key = `in_game:${userId}`;
  try {
    const val = await redis.get(key);
    if (val === 'rps') {
      await redis.del(key);
    }
  } catch (_) {}
}

async function clearRpsInGameLocks(game) {
  if (!game) return;
  await Promise.all([
    clearRpsInGameLockForUser(game.player1Id),
    clearRpsInGameLockForUser(game.player2Id),
  ]);
}

async function isUserInExternalGame(userId) {
  try {
    const val = await redis.get(`in_game:${userId}`);
    if (!val) return false;
    if (val === 'rps') {
      if (getPlayerRoomId(userId)) return true;
      await clearRpsInGameLockForUser(userId);
      return false;
    }
    return true;
  } catch (_) {
    return false;
  }
}

// ── Timer management ─────────────────────────────────────────────────────
// roomTimers: Map<roomId, { type, timeoutId }>
const roomTimers = new Map();

function setRoomTimer(roomId, type, durationMs, callback) {
  clearRoomTimer(roomId);
  const timeoutId = setTimeout(callback, durationMs);
  roomTimers.set(roomId, { type, timeoutId });
}

function clearRoomTimer(roomId) {
  const timer = roomTimers.get(roomId);
  if (timer) {
    clearTimeout(timer.timeoutId);
    roomTimers.delete(roomId);
  }
}

// ── Socket user tracking ─────────────────────────────────────────────────
// rpsUserSockets: Map<userId, Set<socketId>>
const rpsUserSockets = new Map();
// rpsSocketUsers: Map<socketId, userId>
const rpsSocketUsers = new Map();

function trackSocket(userId, socketId) {
  const uid = String(userId);
  if (!rpsUserSockets.has(uid)) rpsUserSockets.set(uid, new Set());
  rpsUserSockets.get(uid).add(socketId);
  rpsSocketUsers.set(socketId, uid);
}

function untrackSocket(socketId) {
  const uid = rpsSocketUsers.get(socketId);
  if (uid) {
    const set = rpsUserSockets.get(uid);
    if (set) {
      set.delete(socketId);
      if (set.size === 0) rpsUserSockets.delete(uid);
    }
    rpsSocketUsers.delete(socketId);
  }
  return uid;
}

function findSocket(io, userId) {
  const uid = String(userId);
  const ids = rpsUserSockets.get(uid);
  if (ids) {
    for (const sid of ids) {
      const s = io.sockets.sockets.get(sid);
      if (s && !s.disconnected) return s;
    }
  }
  // Fallback: check all connected sockets in io matching socket.data.userId
  if (io && io.sockets && io.sockets.sockets) {
    for (const [, s] of io.sockets.sockets) {
      if (String(s.data?.userId) === uid && !s.disconnected) {
        trackSocket(uid, s.id);
        return s;
      }
    }
  }
  return null;
}

// ── RPS Games column detection (graceful schema tolerance) ────────────────
let cachedRpsColumns = null;
async function getRpsColumns(client) {
  if (cachedRpsColumns) return cachedRpsColumns;
  try {
    const res = await (client || pool).query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'rps_games'"
    );
    cachedRpsColumns = new Set(res.rows.map(r => r.column_name));
  } catch (_) {
    cachedRpsColumns = new Set([
      'id', 'room_id', 'stake_amount', 'pot_amount', 'fee_amount', 'prize_amount',
      'winner_id', 'score_p1', 'score_p2', 'rounds_data', 'status', 'best_of',
      'player_1', 'player_2', 'created_at', 'finished_at'
    ]);
  }
  return cachedRpsColumns;
}

// ── DB transaction helper ────────────────────────────────────────────────
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const res = await fn(client);
    await client.query('COMMIT');
    return res;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
}

// ── Deduct stakes for both players ───────────────────────────────────────
async function deductBothStakes(game) {
  return tx(async (client) => {
    // deductStake expects playerXId/playerOId — reuse with P1=X, P2=O
    const stakes = await deductStake(client, {
      playerXId: game.player1Id,
      playerOId: game.player2Id,
      betAmount: game.stakeAmount,
    });

    // Store bucket splits for potential refund
    game.bucketP1 = stakes[game.player1Id] || { bonusUsed: 0, wdUsed: 0, lockedUsed: 0 };
    game.bucketP2 = stakes[game.player2Id] || { bonusUsed: 0, wdUsed: 0, lockedUsed: 0 };

    // Insert rps_games row with schema-tolerant column detection
    const cols = await getRpsColumns(client);
    const colNames = ['room_id', 'player_1', 'player_2', 'stake_amount', 'pot_amount', 'fee_amount', 'status', 'best_of'];
    const values = [game.roomId, game.player1Id, game.player2Id, game.stakeAmount, game.potAmount, game.feeAmount, 'active', game.bestOf];

    if (cols.has('prize_amount')) {
      colNames.push('prize_amount');
      values.push(game.prizeAmount);
    }
    if (cols.has('fee_percent')) {
      colNames.push('fee_percent');
      values.push(game.feePercent);
    }
    if (cols.has('wins_needed')) {
      colNames.push('wins_needed');
      values.push(game.winsNeeded);
    }
    if (cols.has('started_at')) {
      colNames.push('started_at');
      values.push(new Date());
    }
    if (cols.has('bonus_used_p1')) {
      colNames.push('bonus_used_p1', 'bonus_used_p2', 'withdrawable_used_p1', 'withdrawable_used_p2', 'locked_used_p1', 'locked_used_p2');
      values.push(
        game.bucketP1.bonusUsed, game.bucketP2.bonusUsed,
        game.bucketP1.wdUsed, game.bucketP2.wdUsed,
        game.bucketP1.lockedUsed, game.bucketP2.lockedUsed
      );
    }

    const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');
    await client.query(`
      INSERT INTO rps_games (${colNames.join(', ')})
      VALUES (${placeholders})
    `, values);

    console.log(`${LOG_PREFIX} Stakes deducted for room ${game.roomId}: P1=${game.player1Id} P2=${game.player2Id} stake=${game.stakeAmount}`);
    return stakes;
  });
}

// ── Payout to winner ─────────────────────────────────────────────────────
async function payoutWinner(game) {
  if (!game.winnerId || !game.finished) return;

  const idempotencyKey = generatePayoutIdempotencyKey(game);

  await tx(async (client) => {
    // Lock and verify game status in DB
    const { rows } = await client.query(
      `SELECT status FROM rps_games WHERE room_id = $1 FOR UPDATE`,
      [game.roomId]
    );
    if (!rows[0] || rows[0].status !== 'active') {
      console.warn(`${LOG_PREFIX} Payout skipped — game ${game.roomId} already ${rows[0]?.status}`);
      return;
    }

    // Ledger-first credit: ensures exactly one payout per match
    const { inserted } = await ledgerFirstCredit(client, {
      userId: game.winnerId,
      txType: 'PRIZE',
      amount: game.prizeAmount,
      status: 'COMPLETED',
      idempotencyKey,
      provider: 'RPS',
      meta: {
        roomId: game.roomId,
        stakeAmount: game.stakeAmount,
        feeAmount: game.feeAmount,
        scoreP1: game.scoreP1,
        scoreP2: game.scoreP2,
      },
    });

    if (!inserted) {
      console.warn(`${LOG_PREFIX} Payout already processed for room ${game.roomId} (idempotency guard)`);
      return;
    }

    // Determine winner's bonus bucket for withdrawable calculation
    const isP1Winner = String(game.winnerId) === String(game.player1Id);
    const winnerBucket = isP1Winner ? game.bucketP1 : game.bucketP2;
    const bonusUsed = winnerBucket ? winnerBucket.bonusUsed : 0;
    const prizeWithdrawable = Math.max(0, game.prizeAmount - bonusUsed);

    // Credit winner's wallet (same pattern as game.js finishAndPayout)
    await client.query(`
      UPDATE wallets
      SET available_balance = available_balance + $1,
          bonus_balance = bonus_balance + $2,
          withdrawable_balance = withdrawable_balance + $3,
          updated_at = NOW()
      WHERE user_id = $4::uuid
    `, [game.prizeAmount, bonusUsed, prizeWithdrawable, game.winnerId]);

    // Update rps_games row with schema tolerance
    const cols = await getRpsColumns(client);
    let updateCols = [
      "status = 'completed'",
      "winner_id = $1::uuid",
      "score_p1 = $2",
      "score_p2 = $3",
      "rounds_data = $4::jsonb",
      "prize_amount = $5",
      "finished_at = NOW()"
    ];
    let updateVals = [
      game.winnerId,
      game.scoreP1,
      game.scoreP2,
      JSON.stringify(game.rounds),
      game.prizeAmount
    ];
    if (cols.has('payout_idempotency_key')) {
      updateVals.push(idempotencyKey);
      updateCols.push(`payout_idempotency_key = $${updateVals.length}`);
    }
    if (cols.has('updated_at')) {
      updateCols.push('updated_at = NOW()');
    }
    updateVals.push(game.roomId);
    await client.query(`
      UPDATE rps_games
      SET ${updateCols.join(', ')}
      WHERE room_id = $${updateVals.length}
    `, updateVals);

    // Audit log
    await client.query(`
      INSERT INTO admin_audit_logs (admin_id, action, target_id, details)
      VALUES (NULL, 'rps_payout', $1, $2::jsonb)
    `, [
      game.roomId,
      JSON.stringify({
        winnerId: game.winnerId,
        loserId: game.loserId,
        prize: game.prizeAmount,
        fee: game.feeAmount,
        stake: game.stakeAmount,
      }),
    ]);

    console.log(`${LOG_PREFIX} Payout complete: room=${game.roomId} winner=${game.winnerId} prize=${game.prizeAmount} fee=${game.feeAmount}`);
  });
}

// ── Refund both players (cancel/error) ───────────────────────────────────
async function refundBothPlayers(game) {
  await tx(async (client) => {
    const { rows } = await client.query(
      `SELECT status FROM rps_games WHERE room_id = $1 FOR UPDATE`,
      [game.roomId]
    );
    if (!rows[0] || rows[0].status === 'refunded' || rows[0].status === 'completed') {
      console.warn(`${LOG_PREFIX} Refund skipped — game ${game.roomId} already ${rows[0]?.status}`);
      return;
    }

    // Refund each player's exact buckets
    for (const { userId, bucket } of [
      { userId: game.player1Id, bucket: game.bucketP1 },
      { userId: game.player2Id, bucket: game.bucketP2 },
    ]) {
      if (!bucket || !userId) continue;

      const refundKey = `rps_refund:${game.roomId}:${userId}`;
      const { inserted } = await ledgerFirstCredit(client, {
        userId,
        txType: 'REFUND',
        amount: game.stakeAmount,
        status: 'COMPLETED',
        idempotencyKey: refundKey,
        provider: 'RPS',
        meta: { roomId: game.roomId, reason: 'game_cancelled' },
      });

      if (inserted) {
        await client.query(`
          UPDATE wallets
          SET available_balance = available_balance + $1,
              bonus_balance = bonus_balance + $2,
              withdrawable_balance = withdrawable_balance + $3,
              updated_at = NOW()
          WHERE user_id = $4::uuid
        `, [
          game.stakeAmount,
          bucket.bonusUsed,
          bucket.wdUsed,
          userId,
        ]);
      }
    }

    const cols = await getRpsColumns(client);
    let refundCols = ["status = 'refunded'", "finished_at = NOW()"];
    if (cols.has('updated_at')) refundCols.push("updated_at = NOW()");
    await client.query(`
      UPDATE rps_games SET ${refundCols.join(', ')}
      WHERE room_id = $1
    `, [game.roomId]);

    console.log(`${LOG_PREFIX} Refunded both players for room ${game.roomId}`);
  });
}

// ── Phase progression with timers ────────────────────────────────────────
function drivePhase(io, game) {
  const roomId = game.roomId;

  switch (game.phase) {
    case PHASES.COUNTDOWN: {
      emitToRoom(io, game, 'rps:phase_change', {
        phase: PHASES.COUNTDOWN,
        duration: TIMINGS.COUNTDOWN_MS,
      });
      setRoomTimer(roomId, 'countdown', TIMINGS.COUNTDOWN_MS, () => {
        const events = startRound(game);
        drivePhase(io, game);
      });
      break;
    }

    case PHASES.CHOOSE: {
      emitToRoom(io, game, 'rps:phase_change', {
        phase: PHASES.CHOOSE,
        round: game.currentRound,
        duration: TIMINGS.CHOOSE_MS,
      });
      setRoomTimer(roomId, 'choose', TIMINGS.CHOOSE_MS, () => {
        const events = handleTimeout(game);
        processEvents(io, game, events);
      });
      break;
    }

    case PHASES.LOCKED:
    case PHASES.REVEAL: {
      // Reveal phase: show choices after shake animation
      emitToRoom(io, game, 'rps:phase_change', {
        phase: PHASES.REVEAL,
        duration: TIMINGS.SHAKE_MS,
      });
      // After shake, send the actual round reveal
      setRoomTimer(roomId, 'shake', TIMINGS.SHAKE_MS, () => {
        const lastRound = game.rounds[game.rounds.length - 1];
        emitToRoom(io, game, 'rps:round_reveal', {
          round: lastRound.round,
          choiceP1: lastRound.choiceP1,
          choiceP2: lastRound.choiceP2,
          result: lastRound.result,
          roundWinner: lastRound.winner,
          scoreP1: game.scoreP1,
          scoreP2: game.scoreP2,
        });

        if (game.finished) {
          // Match over — send final result and handle payout
          handleMatchEnd(io, game);
        } else {
          // Show round result, then start next round
          game.phase = PHASES.ROUND_RESULT;
          emitToRoom(io, game, 'rps:phase_change', {
            phase: PHASES.ROUND_RESULT,
            duration: TIMINGS.ROUND_RESULT_MS,
          });
          setRoomTimer(roomId, 'roundResult', TIMINGS.ROUND_RESULT_MS, () => {
            startRound(game);
            drivePhase(io, game);
          });
        }
      });
      break;
    }

    case PHASES.FINAL: {
      handleMatchEnd(io, game);
      break;
    }
  }
}

function processEvents(io, game, events) {
  for (const event of events) {
    switch (event.type) {
      case 'opponent_locked':
        emitToPlayer(io, event.targetPlayerId, 'rps:opponent_locked', {});
        break;
      case 'choice_locked':
        // Confirm to the player that their choice was received
        emitToPlayer(io, event.playerId, 'rps:choice_confirmed', { locked: true });
        break;
      case 'error':
        emitToPlayer(io, event.playerId, 'rps:error', { code: event.code, message: event.message });
        break;
    }
  }

  // Trigger reveal shake whenever resolveRound just resolved a round
  // (including the match-winning round where resolveRound advances phase to FINAL).
  const hasRoundReveal = events.some((e) => e.type === 'round_reveal');
  if (game.phase === PHASES.LOCKED || (hasRoundReveal && game.finished)) {
    game.phase = PHASES.REVEAL;
    drivePhase(io, game);
  }
}

async function handleMatchEnd(io, game) {
  clearRoomTimer(game.roomId);
  game.phase = PHASES.FINAL;

  if (game.winnerId) {
    // Send match result
    emitToRoom(io, game, 'rps:match_result', {
      winnerId: game.winnerId,
      loserId: game.loserId,
      scoreP1: game.scoreP1,
      scoreP2: game.scoreP2,
      prizeAmount: game.prizeAmount,
      feeAmount: game.feeAmount,
      rounds: game.rounds,
    });

    // Payout
    try {
      await payoutWinner(game);
    } catch (err) {
      console.error(`${LOG_PREFIX} Payout FAILED for room ${game.roomId}:`, err.message);
      // Mark as payout_failed for admin attention
      try {
        const cols = await getRpsColumns();
        const setClause = cols.has('updated_at')
          ? `status = 'payout_failed', updated_at = NOW()`
          : `status = 'payout_failed'`;
        await pool.query(
          `UPDATE rps_games SET ${setClause} WHERE room_id = $1`,
          [game.roomId]
        );
      } catch (_) {}
    }
  } else {
    // Cancelled — refund
    emitToRoom(io, game, 'rps:match_cancelled', { reason: 'game_cancelled' });
    try {
      await refundBothPlayers(game);
    } catch (err) {
      console.error(`${LOG_PREFIX} Refund FAILED for room ${game.roomId}:`, err.message);
    }
  }

  await clearRpsInGameLocks(game);

  // Cleanup after a delay (let clients process the result)
  setTimeout(() => {
    clearRpsInGameLocks(game).catch(() => {});
    cleanupRoom(game.roomId);
  }, TIMINGS.FINAL_HOLD_MS);
}

// ── Emit helpers ─────────────────────────────────────────────────────────
function emitToRoom(io, game, event, payload) {
  emitToPlayer(io, game.player1Id, event, payload);
  if (game.player2Id) emitToPlayer(io, game.player2Id, event, payload);
}

function emitToPlayer(io, userId, event, payload) {
  const roomName = `user:${userId}`;
  const socket = findSocket(io, userId);
  const roomSet = io?.sockets?.adapter?.rooms?.get(roomName);
  const socketInRoom = Boolean(socket && roomSet && roomSet.has(socket.id));

  if (io && typeof io.to === 'function' && roomSet && roomSet.size > 0) {
    try {
      io.to(roomName).emit(event, payload);
    } catch (_) {}
  }
  if (socket && !socketInRoom) {
    socket.emit(event, payload);
  }
}

// ── Direct RPS Match (Friend Challenge) ──────────────────────────────────
async function startDirectRPSMatch(io, player1Id, player2Id, stakeAmount) {
  const p1Id = String(player1Id);
  const p2Id = String(player2Id);
  const stake = Math.round(Number(stakeAmount));

  if (p1Id === p2Id) {
    throw new Error('CANNOT_PLAY_SELF');
  }

  if (!VALID_BETS.has(stake)) {
    throw new Error(`INVALID_BET: ${stake} is not in [${BET_TIERS.join(', ')}]`);
  }

  // Clear any finished stale room references or reject if active
  const existing1 = getPlayerRoomId(p1Id);
  if (existing1) {
    const g1 = activeRooms.get(existing1);
    if (!g1 || g1.finished) cleanupRoom(existing1);
    else throw new Error('ALREADY_IN_GAME');
  }
  const existing2 = getPlayerRoomId(p2Id);
  if (existing2) {
    const g2 = activeRooms.get(existing2);
    if (!g2 || g2.finished) cleanupRoom(existing2);
    else throw new Error('ALREADY_IN_GAME');
  }

  // Check cross-game Redis locks (e.g., XO or Spin)
  if (await isUserInExternalGame(p1Id) || await isUserInExternalGame(p2Id)) {
    throw new Error('ALREADY_IN_GAME');
  }

  // Dequeue both from matchmaking queues if they were searching
  dequeue(p1Id);
  dequeue(p2Id);

  const roomId = `rps_${uuidv4().slice(0, 12)}`;
  const game = createGame({
    roomId,
    player1Id: p1Id,
    player2Id: p2Id,
    stakeAmount: stake,
    bestOf: 3,
  });

  activeRooms.set(roomId, game);
  playerToRoom.set(p1Id, roomId);
  playerToRoom.set(p2Id, roomId);

  try {
    await deductBothStakes(game);
  } catch (err) {
    console.error(`${LOG_PREFIX} Direct friend RPS stake deduction failed:`, err.message);
    cancelGame(game, 'stake_deduction_failed');
    cleanupRoom(roomId);
    await clearRpsInGameLocks(game);
    throw err;
  }

  await setRpsInGameLocks(p1Id, p2Id);

  const p1Socket = findSocket(io, p1Id);
  if (p1Socket) {
    trackSocket(p1Id, p1Socket.id);
    p1Socket.join?.(roomId);
    p1Socket.data = { ...(p1Socket.data || {}), userId: p1Id, rpsActive: true };
  }
  const p2Socket = findSocket(io, p2Id);
  if (p2Socket) {
    trackSocket(p2Id, p2Socket.id);
    p2Socket.join?.(roomId);
    p2Socket.data = { ...(p2Socket.data || {}), userId: p2Id, rpsActive: true };
  }

  // Fetch usernames
  const usersRes = await pool.query(
    'SELECT id, username, display_name FROM users WHERE id = ANY($1::uuid[])',
    [[p1Id, p2Id]]
  );
  const userMap = {};
  for (const r of usersRes.rows) userMap[r.id] = r.display_name || r.username || 'Player';

  const basePayload = {
    roomId: game.roomId,
    stakeAmount: game.stakeAmount,
    prizeAmount: game.prizeAmount,
    feePercent: game.feePercent,
    bestOf: game.bestOf,
  };

  const payloadP1 = {
    ...basePayload,
    youAre: 'p1',
    opponentId: p2Id,
    opponentUsername: userMap[p2Id] || 'Player',
  };
  const payloadP2 = {
    ...basePayload,
    youAre: 'p2',
    opponentId: p1Id,
    opponentUsername: userMap[p1Id] || 'Player',
  };

  emitToPlayer(io, p1Id, 'rps:match_found', payloadP1);
  emitToPlayer(io, p2Id, 'rps:match_found', payloadP2);

  startMatch(game);
  drivePhase(io, game);

  console.log(`${LOG_PREFIX} Direct friend RPS match started: ${roomId} (${p1Id} vs ${p2Id}, stake=${stake})`);
  return { ok: true, roomId };
}

// ── Main setup ───────────────────────────────────────────────────────────
function setupRPSSocket(io) {
  io.on('connection', (socket) => {
    // ── rps:find_match ─────────────────────────────────────────────────
    socket.on('rps:find_match', async (payload, ack) => {
      try {
        const stakeAmount = typeof payload === 'object' ? payload?.stakeAmount : payload;
        const payloadToken = typeof payload === 'object' ? payload?.token : null;

        // Authenticate via payload token, socket.data, handshake auth or headers
        let userId = socket.data?.userId;
        const token = payloadToken || socket.handshake?.auth?.token || socket.handshake?.headers?.authorization?.replace('Bearer ', '');

        if (!userId && token) {
          try {
            const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
            userId = String(decoded.sub || decoded.userId || decoded.id);
          } catch (e) {
            return ack?.({ ok: false, error: 'INVALID_TOKEN' });
          }
        }

        if (!userId) {
          return ack?.({ ok: false, error: 'AUTH_REQUIRED' });
        }

        // Track socket
        trackSocket(userId, socket.id);
        socket.data = { ...(socket.data || {}), userId, rpsActive: true };

        // Check ban
        const banCheck = await pool.query('SELECT banned FROM users WHERE id = $1::uuid', [userId]);
        if (banCheck.rows[0]?.banned) {
          return ack?.({ ok: false, error: 'ACCOUNT_BANNED' });
        }

        // Cross-game / active-room lock check
        if (getPlayerRoomId(userId) || await isUserInExternalGame(userId)) {
          return ack?.({ ok: false, error: 'ALREADY_IN_GAME' });
        }

        // Enqueue / match (pruning disconnected ghost entries in queue)
        const result = enqueue(userId, socket.id, stakeAmount, (queuedSocketId, queuedUserId) => {
          const qs = io?.sockets?.sockets?.get(queuedSocketId);
          if (qs && !qs.disconnected) return true;
          return Boolean(findSocket(io, queuedUserId));
        });

        if (result.matched) {
          const game = result.game;

          // Deduct stakes from both players
          try {
            await deductBothStakes(game);
          } catch (err) {
            const isMissingTable = err.code === '42P01' || (err.message && err.message.includes('rps_games'));
            console.error(`${LOG_PREFIX} Stake deduction failed:`, err.message);
            if (isMissingTable) {
              console.error(`${LOG_PREFIX} CRITICAL: rps_games table missing — apply migration_009_rps_schema.sql.`);
            }
            cancelGame(game, 'stake_deduction_failed');
            cleanupRoom(game.roomId);
            await clearRpsInGameLocks(game);
            const errCode = err.message === 'INSUFFICIENT_BALANCE'
              ? 'INSUFFICIENT_BALANCE'
              : (isMissingTable ? 'RPS_SCHEMA_MISSING' : 'STAKE_FAILED');
            const errMessage = errCode === 'INSUFFICIENT_BALANCE'
              ? 'One of the matched players has insufficient balance.'
              : (isMissingTable ? 'RPS service is updating. Please try again shortly.' : 'Failed to lock stakes for match.');
            ack?.({ ok: false, error: errCode, message: errMessage });
            // Notify BOTH players so neither player gets stuck searching
            emitToPlayer(io, game.player1Id, 'rps:error', { code: errCode, message: errMessage });
            emitToPlayer(io, game.player1Id, 'rps:match_cancelled', { reason: errCode });
            if (game.player2Id) {
              emitToPlayer(io, game.player2Id, 'rps:error', { code: errCode, message: errMessage });
              emitToPlayer(io, game.player2Id, 'rps:match_cancelled', { reason: errCode });
            }
            return;
          }

          await setRpsInGameLocks(game.player1Id, game.player2Id);

          // Fetch usernames
          const usersRes = await pool.query(
            'SELECT id, username, display_name FROM users WHERE id = ANY($1::uuid[])',
            [[game.player1Id, game.player2Id]]
          );
          const userMap = {};
          for (const r of usersRes.rows) userMap[r.id] = r.display_name || r.username || 'Player';

          // Notify both players (emitToPlayer delivers to user room + direct socket)
          const p1Socket = findSocket(io, game.player1Id);
          const p2Socket = findSocket(io, game.player2Id);
          p1Socket?.join?.(game.roomId);
          p2Socket?.join?.(game.roomId);

          const basePayload = {
            roomId: game.roomId,
            stakeAmount: game.stakeAmount,
            prizeAmount: game.prizeAmount,
            feePercent: game.feePercent,
            bestOf: game.bestOf,
          };

          emitToPlayer(io, game.player1Id, 'rps:match_found', {
            ...basePayload,
            youAre: 'p1',
            opponentId: game.player2Id,
            opponentUsername: userMap[game.player2Id] || 'Player',
          });
          emitToPlayer(io, game.player2Id, 'rps:match_found', {
            ...basePayload,
            youAre: 'p2',
            opponentId: game.player1Id,
            opponentUsername: userMap[game.player1Id] || 'Player',
          });

          ack?.({ ok: true, matched: true, roomId: game.roomId });

          // Start the match after a brief delay for UI
          const events = startMatch(game);
          drivePhase(io, game);

        } else {
          // In queue
          socket.emit('rps:searching', { stakeAmount, position: result.position });
          ack?.({ ok: true, matched: false, position: result.position });
        }

      } catch (err) {
        console.error(`${LOG_PREFIX} rps:find_match error:`, err.message);
        ack?.({ ok: false, error: err.message });
      }
    });

    // ── rps:cancel_search ──────────────────────────────────────────────
    socket.on('rps:cancel_search', (_, ack) => {
      const userId = socket.data?.userId || rpsSocketUsers.get(socket.id);
      if (userId) {
        dequeue(userId);
      }
      ack?.({ ok: true });
    });

    // ── rps:lock_choice ────────────────────────────────────────────────
    socket.on('rps:lock_choice', ({ roomId, choice, token }, ack) => {
      try {
        let userId = socket.data?.userId || rpsSocketUsers.get(socket.id);
        const payloadToken = token || socket.handshake?.auth?.token;
        if (!userId && payloadToken) {
          try {
            const decoded = jwt.verify(payloadToken, JWT_SECRET, { algorithms: ['HS256'] });
            userId = String(decoded.sub || decoded.userId || decoded.id);
            if (userId) {
              trackSocket(userId, socket.id);
              socket.data = { ...(socket.data || {}), userId };
            }
          } catch (_) {}
        }
        if (!userId) return ack?.({ ok: false, error: 'AUTH_REQUIRED' });

        const game = getRoom(roomId);
        if (!game) return ack?.({ ok: false, error: 'ROOM_NOT_FOUND' });

        const events = lockChoice(game, userId, choice);
        processEvents(io, game, events);

        // Check for errors in events
        const errorEvent = events.find(e => e.type === 'error');
        if (errorEvent) {
          return ack?.({ ok: false, error: errorEvent.code });
        }

        ack?.({ ok: true });
      } catch (err) {
        console.error(`${LOG_PREFIX} rps:lock_choice error:`, err.message);
        ack?.({ ok: false, error: err.message });
      }
    });

    // ── rps:sync ───────────────────────────────────────────────────────
    socket.on('rps:sync', async ({ roomId, token: payloadToken }, ack) => {
      try {
        let userId = socket.data?.userId || rpsSocketUsers.get(socket.id);
        const token = payloadToken || socket.handshake?.auth?.token;
        if (!userId && token) {
          try {
            const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
            userId = String(decoded.sub || decoded.userId || decoded.id);
            if (userId) {
              trackSocket(userId, socket.id);
              socket.data = { ...(socket.data || {}), userId };
            }
          } catch (_) {}
        }
        if (!userId) return ack?.({ ok: false, error: 'AUTH_REQUIRED' });

        const game = getRoom(roomId);
        if (!game) return ack?.({ ok: false, error: 'ROOM_NOT_FOUND' });

        const isP1 = String(game.player1Id) === String(userId);
        const isP2 = String(game.player2Id) === String(userId);
        if (!isP1 && !isP2) return ack?.({ ok: false, error: 'NOT_IN_ROOM' });

        trackSocket(userId, socket.id);
        socket.join(roomId);

        const oppId = isP1 ? game.player2Id : game.player1Id;
        const oppRes = await pool.query('SELECT username, display_name FROM users WHERE id = $1::uuid', [oppId]);
        const oppName = oppRes.rows[0]?.display_name || oppRes.rows[0]?.username || 'Opponent';

        const gamePayload = {
          roomId: game.roomId,
          stakeAmount: game.stakeAmount,
          potAmount: game.potAmount,
          feePercent: game.feePercent,
          prizeAmount: game.prizeAmount,
          bestOf: game.bestOf,
          winsNeeded: game.winsNeeded,
          youAre: isP1 ? 'p1' : 'p2',
          opponentId: oppId,
          opponentUsername: oppName,
          scoreYou: isP1 ? game.scoreP1 : game.scoreP2,
          scoreOpponent: isP1 ? game.scoreP2 : game.scoreP1,
          currentRound: game.currentRound,
          phase: game.phase,
          yourLocked: isP1 ? !!(game.p1Locked || game.lockedP1) : !!(game.p2Locked || game.lockedP2),
          opponentLocked: isP1 ? !!(game.p2Locked || game.lockedP2) : !!(game.p1Locked || game.lockedP1),
        };
        ack?.({
          ok: true,
          data: gamePayload,
          game: gamePayload,
        });
      } catch (err) {
        console.error(`${LOG_PREFIX} rps:sync error:`, err.message);
        ack?.({ ok: false, error: err.message });
      }
    });

    // ── rps:leave ──────────────────────────────────────────────────────
    socket.on('rps:leave', async ({ roomId }, ack) => {
      try {
        const userId = socket.data?.userId || rpsSocketUsers.get(socket.id);
        if (!userId) return ack?.({ ok: false, error: 'AUTH_REQUIRED' });

        const game = getRoom(roomId);
        if (!game) return ack?.({ ok: true }); // Already cleaned up

        const events = handleDisconnect(game, userId);
        if (events.length > 0) {
          for (const event of events) {
            if (event.type === 'match_result') {
              await handleMatchEnd(io, game);
            } else if (event.type === 'match_cancelled') {
              clearRoomTimer(game.roomId);
              clearRoomTimer(`dc_${game.roomId}_${userId}`);
              // If game was active (stakes deducted), refund
              if (game.bucketP1 && game.bucketP2) {
                await refundBothPlayers(game);
              }
              await clearRpsInGameLocks(game);
              emitToRoom(io, game, 'rps:match_cancelled', { reason: event.reason });
              cleanupRoom(game.roomId);
            }
          }
        }

        ack?.({ ok: true });
      } catch (err) {
        console.error(`${LOG_PREFIX} rps:leave error:`, err.message);
        ack?.({ ok: false, error: err.message });
      }
    });

    // ── disconnect ─────────────────────────────────────────────────────
    socket.on('disconnect', async () => {
      const userId = untrackSocket(socket.id);
      if (!userId) return;

      // Remove from matchmaking
      dequeue(userId);

      // Handle active game disconnect
      const roomId = getPlayerRoomId(userId);
      if (roomId) {
        const game = getRoom(roomId);
        if (game && !game.finished) {
          // Give a brief grace period for reconnection
          const DISCONNECT_GRACE_MS = 10_000;
          setRoomTimer(`dc_${roomId}_${userId}`, 'disconnect', DISCONNECT_GRACE_MS, async () => {
            // Check if player reconnected
            const reconnectedSocket = findSocket(io, userId);
            if (reconnectedSocket) return; // They came back

            const events = handleDisconnect(game, userId);
            if (events.length > 0) {
              for (const event of events) {
                if (event.type === 'match_result') {
                  await handleMatchEnd(io, game);
                } else if (event.type === 'match_cancelled') {
                  clearRoomTimer(game.roomId);
                  clearRoomTimer(`dc_${game.roomId}_${userId}`);
                  if (game.bucketP1 && game.bucketP2) {
                    await refundBothPlayers(game);
                  }
                  await clearRpsInGameLocks(game);
                  emitToRoom(io, game, 'rps:match_cancelled', { reason: event.reason });
                  cleanupRoom(game.roomId);
                }
              }
            }
          });
        }
      }
    });
  });

  console.log(`${LOG_PREFIX} RPS socket handler initialized.`);
}

module.exports = {
  setupRPSSocket,
  rpsUserSockets,
  startDirectRPSMatch,
  processEvents,
  drivePhase,
  clearRoomTimer,
  deductBothStakes,
  payoutWinner,
  refundBothPlayers,
  handleMatchEnd,
  setRpsInGameLocks,
  clearRpsInGameLocks,
  isUserInExternalGame,
};
