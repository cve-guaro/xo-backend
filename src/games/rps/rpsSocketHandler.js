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
  PHASES, TIMINGS, BET_TIERS, FEE_PERCENT,
  startMatch, startRound, lockChoice, handleTimeout,
  handleDisconnect, cancelGame, generatePayoutIdempotencyKey,
} = require('./RPSGame');
const {
  enqueue, dequeue, getRoom, cleanupRoom, isPlayerInGame,
  getQueueSizes, listActiveRooms,
} = require('./RPSRoomManager');

const LOG_PREFIX = '[RPS_SOCKET]';
const JWT_SECRET = process.env.JWT_SECRET;

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
  return null;
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

    // Insert rps_games row
    await client.query(`
      INSERT INTO rps_games (
        id, room_id, player_1, player_2, stake_amount, pot_amount, fee_amount, fee_percent,
        status, best_of, wins_needed, started_at,
        bonus_used_p1, bonus_used_p2, withdrawable_used_p1, withdrawable_used_p2,
        locked_used_p1, locked_used_p2
      ) VALUES (
        gen_random_uuid(), $1, $2::uuid, $3::uuid, $4, $5, $6, $7,
        'active', $8, $9, NOW(),
        $10, $11, $12, $13, $14, $15
      )
    `, [
      game.roomId,
      game.player1Id, game.player2Id,
      game.stakeAmount, game.potAmount, game.feeAmount, game.feePercent,
      game.bestOf, game.winsNeeded,
      game.bucketP1.bonusUsed, game.bucketP2.bonusUsed,
      game.bucketP1.wdUsed, game.bucketP2.wdUsed,
      game.bucketP1.lockedUsed, game.bucketP2.lockedUsed,
    ]);

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
      txType: 'RPS_PRIZE',
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

    // Update rps_games row
    await client.query(`
      UPDATE rps_games
      SET status = 'completed',
          winner_id = $1::uuid,
          score_p1 = $2,
          score_p2 = $3,
          rounds_data = $4::jsonb,
          prize_amount = $5,
          payout_idempotency_key = $6,
          finished_at = NOW(),
          updated_at = NOW()
      WHERE room_id = $7
    `, [
      game.winnerId,
      game.scoreP1, game.scoreP2,
      JSON.stringify(game.rounds),
      game.prizeAmount,
      idempotencyKey,
      game.roomId,
    ]);

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
        txType: 'RPS_REFUND',
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
          bucket.wdUsed + bucket.lockedUsed,
          userId,
        ]);
      }
    }

    await client.query(`
      UPDATE rps_games SET status = 'refunded', finished_at = NOW(), updated_at = NOW()
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

  // Check if phase changed due to both players locking
  if (game.phase === PHASES.LOCKED) {
    game.phase = PHASES.REVEAL;
    drivePhase(io, game);
  }
}

async function handleMatchEnd(io, game) {
  clearRoomTimer(game.roomId);

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
        await pool.query(
          `UPDATE rps_games SET status = 'payout_failed', updated_at = NOW() WHERE room_id = $1`,
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

  // Cleanup after a delay (let clients process the result)
  setTimeout(() => cleanupRoom(game.roomId), TIMINGS.FINAL_HOLD_MS);
}

// ── Emit helpers ─────────────────────────────────────────────────────────
function emitToRoom(io, game, event, payload) {
  emitToPlayer(io, game.player1Id, event, payload);
  if (game.player2Id) emitToPlayer(io, game.player2Id, event, payload);
}

function emitToPlayer(io, userId, event, payload) {
  const socket = findSocket(io, userId);
  if (socket) {
    socket.emit(event, payload);
  }
}

// ── Main setup ───────────────────────────────────────────────────────────
function setupRPSSocket(io) {
  io.on('connection', (socket) => {
    // ── rps:find_match ─────────────────────────────────────────────────
    socket.on('rps:find_match', async ({ stakeAmount }, ack) => {
      try {
        // Authenticate
        const token = socket.handshake?.auth?.token || socket.handshake?.headers?.authorization?.replace('Bearer ', '');
        if (!token) {
          return ack?.({ ok: false, error: 'AUTH_REQUIRED' });
        }

        let decoded;
        try {
          decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
        } catch (e) {
          return ack?.({ ok: false, error: 'INVALID_TOKEN' });
        }

        const userId = String(decoded.sub || decoded.userId || decoded.id);
        if (!userId) return ack?.({ ok: false, error: 'INVALID_TOKEN' });

        // Track socket
        trackSocket(userId, socket.id);
        socket.data = { ...(socket.data || {}), userId, rpsActive: true };

        // Check ban
        const banCheck = await pool.query('SELECT banned FROM users WHERE id = $1::uuid', [userId]);
        if (banCheck.rows[0]?.banned) {
          return ack?.({ ok: false, error: 'ACCOUNT_BANNED' });
        }

        // Enqueue / match
        const result = enqueue(userId, socket.id, stakeAmount);

        if (result.matched) {
          const game = result.game;

          // Deduct stakes from both players
          try {
            await deductBothStakes(game);
          } catch (err) {
            console.error(`${LOG_PREFIX} Stake deduction failed:`, err.message);
            cancelGame(game, 'stake_deduction_failed');
            cleanupRoom(game.roomId);
            ack?.({ ok: false, error: err.message === 'INSUFFICIENT_BALANCE' ? 'INSUFFICIENT_BALANCE' : 'STAKE_FAILED' });
            // Notify opponent
            emitToPlayer(io, game.player1Id, 'rps:match_cancelled', { reason: 'stake_deduction_failed' });
            return;
          }

          // Fetch usernames
          const usersRes = await pool.query(
            'SELECT id, username, display_name FROM users WHERE id = ANY($1::uuid[])',
            [[game.player1Id, game.player2Id]]
          );
          const userMap = {};
          for (const r of usersRes.rows) userMap[r.id] = r.display_name || r.username || 'Player';

          // Notify both players
          const p1Socket = findSocket(io, game.player1Id);
          const p2Socket = findSocket(io, game.player2Id);

          const basePayload = {
            roomId: game.roomId,
            stakeAmount: game.stakeAmount,
            prizeAmount: game.prizeAmount,
            feePercent: game.feePercent,
            bestOf: game.bestOf,
          };

          if (p1Socket) {
            p1Socket.emit('rps:match_found', {
              ...basePayload,
              youAre: 'p1',
              opponentId: game.player2Id,
              opponentUsername: userMap[game.player2Id] || 'Player',
            });
          }
          if (p2Socket) {
            p2Socket.emit('rps:match_found', {
              ...basePayload,
              youAre: 'p2',
              opponentId: game.player1Id,
              opponentUsername: userMap[game.player1Id] || 'Player',
            });
          }

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
    socket.on('rps:lock_choice', ({ roomId, choice }, ack) => {
      try {
        const userId = socket.data?.userId || rpsSocketUsers.get(socket.id);
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
              // If game was active (stakes deducted), refund
              if (game.bucketP1 && game.bucketP2) {
                await refundBothPlayers(game);
              }
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
      const roomId = isPlayerInGame(userId);
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
                  if (game.bucketP1 && game.bucketP2) {
                    await refundBothPlayers(game);
                  }
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
};
