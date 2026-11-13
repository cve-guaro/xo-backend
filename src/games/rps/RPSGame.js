/**
 * RPSGame.js — Pure state machine for a single Rock Paper Scissors match.
 *
 * Phases: waiting → countdown → choose → locked → reveal → roundResult → final
 * Format: Best of 3 (first to 2 round wins).
 *
 * This module has ZERO side effects: no database, no sockets, no timers.
 * All I/O is done by the caller (rpsSocketHandler.js).
 *
 * SECURITY: choices are held server-side and NEVER leaked to opponents
 * until both are locked (commit-reveal). The judge function is authoritative.
 */

const CHOICES = ['rock', 'paper', 'scissors'];
const VALID_CHOICES = new Set(CHOICES);

const PHASES = {
  WAITING:      'waiting',
  COUNTDOWN:    'countdown',   // both connected, 3s pre-match countdown
  CHOOSE:       'choose',      // 10s to pick
  LOCKED:       'locked',      // both locked or timer expired
  REVEAL:       'reveal',      // 3s shake animation
  ROUND_RESULT: 'roundResult', // 2.5s result banner
  FINAL:        'final',       // match over
};

const STATUSES = {
  WAITING:   'waiting',
  ACTIVE:    'active',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
  REFUNDED:  'refunded',
};

// Allowed bet tiers (ETB, integers only)
const BET_TIERS = [10, 25, 50, 100];
const VALID_BETS = new Set(BET_TIERS);

// Fee configuration — 20% rake, matching Spin room
const FEE_PERCENT = 20;

// Timings (milliseconds)
const TIMINGS = {
  COUNTDOWN_MS:    3000,   // pre-match countdown
  CHOOSE_MS:       10000,  // time to choose
  LOW_TIME_MS:     3000,   // low-time alert threshold
  SHAKE_MS:        3000,   // shake animation (3-2-1)
  ROUND_RESULT_MS: 2500,   // result banner hold
  FINAL_HOLD_MS:   5000,   // final result hold
};

/**
 * judge(a, b) → 'win' | 'lose' | 'draw'
 * Returns result FROM a's perspective.
 */
function judge(a, b) {
  if (a === b) return 'draw';
  if (
    (a === 'rock'     && b === 'scissors') ||
    (a === 'scissors' && b === 'paper') ||
    (a === 'paper'    && b === 'rock')
  ) return 'win';
  return 'lose';
}

/**
 * calculatePrize(stakeAmount) → { pot, fee, prize }
 * Both players put in stakeAmount. Pot = 2 × stake. Fee = pot × 20%.
 * Prize = pot − fee. All integers.
 */
function calculatePrize(stakeAmount) {
  const stake = Math.round(Number(stakeAmount));
  const pot = stake * 2;
  const fee = Math.floor(pot * FEE_PERCENT / 100);
  const prize = pot - fee;
  return { pot, fee, prize, feePercent: FEE_PERCENT };
}

/**
 * createGame(opts) → game state object
 */
function createGame({ roomId, player1Id, player2Id, stakeAmount, bestOf = 3 }) {
  const stake = Math.round(Number(stakeAmount));
  if (!VALID_BETS.has(stake)) {
    throw new Error(`INVALID_BET: ${stake} is not in [${BET_TIERS.join(', ')}]`);
  }

  const { pot, fee, prize } = calculatePrize(stake);
  const winsNeeded = Math.ceil(bestOf / 2); // 2 for best-of-3

  return {
    roomId,
    player1Id,
    player2Id,
    stakeAmount: stake,
    potAmount: pot,
    feeAmount: fee,
    feePercent: FEE_PERCENT,
    prizeAmount: prize,
    bestOf,
    winsNeeded,

    phase: PHASES.WAITING,
    status: STATUSES.WAITING,

    scoreP1: 0,
    scoreP2: 0,
    currentRound: 0,
    rounds: [],        // [{ round, choiceP1, choiceP2, result, winner }]

    // Current round choices (server-held, NEVER sent to opponent)
    choiceP1: null,
    choiceP2: null,
    p1Locked: false,
    p2Locked: false,

    // Bucket tracking for refunds
    bucketP1: null, // set after deductStake: { bonusUsed, wdUsed, lockedUsed }
    bucketP2: null,

    winnerId: null,
    loserId: null,
    finished: false,

    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
  };
}

/**
 * startMatch(game) → mutates game, returns events to emit
 */
function startMatch(game) {
  if (game.phase !== PHASES.WAITING) return [];
  game.phase = PHASES.COUNTDOWN;
  game.status = STATUSES.ACTIVE;
  game.startedAt = Date.now();
  return [{ type: 'phase_change', phase: PHASES.COUNTDOWN, duration: TIMINGS.COUNTDOWN_MS }];
}

/**
 * startRound(game) → advance to choose phase
 */
function startRound(game) {
  game.currentRound++;
  game.choiceP1 = null;
  game.choiceP2 = null;
  game.p1Locked = false;
  game.p2Locked = false;
  game.phase = PHASES.CHOOSE;
  return [{ type: 'phase_change', phase: PHASES.CHOOSE, round: game.currentRound, duration: TIMINGS.CHOOSE_MS }];
}

/**
 * lockChoice(game, playerId, choice) → events
 * Returns events to emit. NEVER includes the choice in opponent events.
 */
function lockChoice(game, playerId, choice) {
  if (game.phase !== PHASES.CHOOSE) {
    return [{ type: 'error', playerId, code: 'WRONG_PHASE', message: `Cannot lock in phase ${game.phase}` }];
  }

  if (!VALID_CHOICES.has(choice)) {
    return [{ type: 'error', playerId, code: 'INVALID_CHOICE', message: `Invalid choice: ${choice}` }];
  }

  const isP1 = String(playerId) === String(game.player1Id);
  const isP2 = String(playerId) === String(game.player2Id);
  if (!isP1 && !isP2) {
    return [{ type: 'error', playerId, code: 'NOT_IN_GAME', message: 'You are not in this game' }];
  }

  // Prevent double-lock
  if (isP1 && game.p1Locked) return [{ type: 'error', playerId, code: 'ALREADY_LOCKED' }];
  if (isP2 && game.p2Locked) return [{ type: 'error', playerId, code: 'ALREADY_LOCKED' }];

  if (isP1) {
    game.choiceP1 = choice;
    game.p1Locked = true;
  } else {
    game.choiceP2 = choice;
    game.p2Locked = true;
  }

  const events = [
    { type: 'choice_locked', playerId },
    // Tell the OPPONENT that this player locked (no choice revealed!)
    { type: 'opponent_locked', targetPlayerId: isP1 ? game.player2Id : game.player1Id },
  ];

  // Both locked → resolve
  if (game.p1Locked && game.p2Locked) {
    events.push(...resolveRound(game));
  }

  return events;
}

/**
 * handleTimeout(game) → events
 * Called when the choose timer expires. Any player who hasn't locked
 * gets a random choice (penalty for not choosing).
 */
function handleTimeout(game) {
  if (game.phase !== PHASES.CHOOSE) return [];

  if (!game.p1Locked) {
    game.choiceP1 = CHOICES[Math.floor(Math.random() * 3)];
    game.p1Locked = true;
  }
  if (!game.p2Locked) {
    game.choiceP2 = CHOICES[Math.floor(Math.random() * 3)];
    game.p2Locked = true;
  }

  return resolveRound(game);
}

/**
 * resolveRound(game) → events
 * Both players have locked. Enter shake → reveal → roundResult.
 */
function resolveRound(game) {
  game.phase = PHASES.LOCKED;
  const result = judge(game.choiceP1, game.choiceP2);

  let roundWinner = null;
  if (result === 'win') {
    game.scoreP1++;
    roundWinner = game.player1Id;
  } else if (result === 'lose') {
    game.scoreP2++;
    roundWinner = game.player2Id;
  }
  // draw: no score change

  const roundData = {
    round: game.currentRound,
    choiceP1: game.choiceP1,
    choiceP2: game.choiceP2,
    result,
    winner: roundWinner,
  };
  game.rounds.push(roundData);

  const events = [
    { type: 'phase_change', phase: PHASES.REVEAL, duration: TIMINGS.SHAKE_MS },
    {
      type: 'round_reveal',
      round: game.currentRound,
      choiceP1: game.choiceP1,
      choiceP2: game.choiceP2,
      result,
      roundWinner,
      scoreP1: game.scoreP1,
      scoreP2: game.scoreP2,
    },
  ];

  // Check for match winner
  if (game.scoreP1 >= game.winsNeeded || game.scoreP2 >= game.winsNeeded) {
    const winnerId = game.scoreP1 >= game.winsNeeded ? game.player1Id : game.player2Id;
    const loserId = winnerId === game.player1Id ? game.player2Id : game.player1Id;
    game.winnerId = winnerId;
    game.loserId = loserId;
    game.finished = true;
    game.finishedAt = Date.now();
    game.status = STATUSES.COMPLETED;
    game.phase = PHASES.FINAL;

    events.push({
      type: 'match_result',
      winnerId,
      loserId,
      scoreP1: game.scoreP1,
      scoreP2: game.scoreP2,
      prizeAmount: game.prizeAmount,
      feeAmount: game.feeAmount,
      rounds: game.rounds,
    });
  } else {
    events.push({
      type: 'phase_change',
      phase: PHASES.ROUND_RESULT,
      duration: TIMINGS.ROUND_RESULT_MS,
      nextRound: game.currentRound + 1,
    });
  }

  return events;
}

/**
 * handleDisconnect(game, playerId) → events
 * If a player disconnects mid-game, the other player wins by forfeit.
 */
function handleDisconnect(game, playerId) {
  if (game.finished) return [];
  if (game.status !== STATUSES.ACTIVE) {
    // If still waiting, just cancel
    game.status = STATUSES.CANCELLED;
    game.phase = PHASES.FINAL;
    game.finished = true;
    game.finishedAt = Date.now();
    return [{ type: 'match_cancelled', reason: 'player_left_before_start' }];
  }

  const isP1 = String(playerId) === String(game.player1Id);
  const winnerId = isP1 ? game.player2Id : game.player1Id;
  const loserId = playerId;

  game.winnerId = winnerId;
  game.loserId = loserId;
  game.finished = true;
  game.finishedAt = Date.now();
  game.status = STATUSES.COMPLETED;
  game.phase = PHASES.FINAL;

  return [{
    type: 'match_result',
    winnerId,
    loserId,
    scoreP1: game.scoreP1,
    scoreP2: game.scoreP2,
    prizeAmount: game.prizeAmount,
    feeAmount: game.feeAmount,
    rounds: game.rounds,
    reason: 'opponent_disconnected',
  }];
}

/**
 * cancelGame(game, reason) → events
 * Cancel before stakes are deducted (e.g. waiting room timeout).
 */
function cancelGame(game, reason = 'timeout') {
  if (game.finished) return [];
  game.status = STATUSES.CANCELLED;
  game.phase = PHASES.FINAL;
  game.finished = true;
  game.finishedAt = Date.now();
  return [{ type: 'match_cancelled', reason }];
}

/**
 * generatePayoutIdempotencyKey(game) → string
 * Deterministic key for the single payout per match.
 */
function generatePayoutIdempotencyKey(game) {
  return `rps_payout:${game.roomId}`;
}

module.exports = {
  CHOICES,
  VALID_CHOICES,
  PHASES,
  STATUSES,
  BET_TIERS,
  VALID_BETS,
  FEE_PERCENT,
  TIMINGS,
  judge,
  calculatePrize,
  createGame,
  startMatch,
  startRound,
  lockChoice,
  handleTimeout,
  handleDisconnect,
  cancelGame,
  generatePayoutIdempotencyKey,
};
