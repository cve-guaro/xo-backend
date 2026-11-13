/**
 * test_rps_game.js — Unit tests for RPSGame.js
 *
 * Tests:
 * 1. judge() — all 9 combinations
 * 2. calculatePrize() — pot, fee, prize for each tier
 * 3. createGame() — valid and invalid bets
 * 4. Full match simulation — best-of-3 with commit-reveal
 * 5. Timeout handling
 * 6. Disconnect/forfeit
 * 7. Idempotency key generation
 * 8. Phase progression
 */

const {
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
  CHOICES,
  PHASES,
  STATUSES,
  BET_TIERS,
  FEE_PERCENT,
} = require('../src/games/rps/RPSGame');

let passed = 0;
let failed = 0;

function assert(condition, name) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.error(`  ❌ ${name}`);
  }
}

function assertEqual(actual, expected, name) {
  if (actual === expected) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.error(`  ❌ ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ── Test 1: judge() — all 9 combinations ─────────────────────────────────
console.log('\n=== Test 1: judge() — all 9 combinations ===');
assertEqual(judge('rock', 'rock'), 'draw', 'rock vs rock = draw');
assertEqual(judge('rock', 'paper'), 'lose', 'rock vs paper = lose');
assertEqual(judge('rock', 'scissors'), 'win', 'rock vs scissors = win');
assertEqual(judge('paper', 'rock'), 'win', 'paper vs rock = win');
assertEqual(judge('paper', 'paper'), 'draw', 'paper vs paper = draw');
assertEqual(judge('paper', 'scissors'), 'lose', 'paper vs scissors = lose');
assertEqual(judge('scissors', 'rock'), 'lose', 'scissors vs rock = lose');
assertEqual(judge('scissors', 'paper'), 'win', 'scissors vs paper = win');
assertEqual(judge('scissors', 'scissors'), 'draw', 'scissors vs scissors = draw');

// ── Test 2: calculatePrize() ────────────────────────────────────────────
console.log('\n=== Test 2: calculatePrize() ===');
for (const tier of BET_TIERS) {
  const { pot, fee, prize, feePercent } = calculatePrize(tier);
  assertEqual(pot, tier * 2, `tier ${tier}: pot = ${tier * 2}`);
  assertEqual(feePercent, FEE_PERCENT, `tier ${tier}: feePercent = ${FEE_PERCENT}`);
  assertEqual(fee, Math.floor(pot * FEE_PERCENT / 100), `tier ${tier}: fee correct`);
  assertEqual(prize, pot - fee, `tier ${tier}: prize = pot - fee`);
  assert(Number.isInteger(pot), `tier ${tier}: pot is integer`);
  assert(Number.isInteger(fee), `tier ${tier}: fee is integer`);
  assert(Number.isInteger(prize), `tier ${tier}: prize is integer`);
}

// Specific checks:
// 10 ETB: pot=20, fee=4, prize=16
assertEqual(calculatePrize(10).prize, 16, '10 ETB → 16 ETB prize');
// 25 ETB: pot=50, fee=10, prize=40
assertEqual(calculatePrize(25).prize, 40, '25 ETB → 40 ETB prize');
// 50 ETB: pot=100, fee=20, prize=80
assertEqual(calculatePrize(50).prize, 80, '50 ETB → 80 ETB prize');
// 100 ETB: pot=200, fee=40, prize=160
assertEqual(calculatePrize(100).prize, 160, '100 ETB → 160 ETB prize');

// ── Test 3: createGame() ────────────────────────────────────────────────
console.log('\n=== Test 3: createGame() ===');
const game1 = createGame({
  roomId: 'test_room_1',
  player1Id: 'p1',
  player2Id: 'p2',
  stakeAmount: 50,
});
assertEqual(game1.stakeAmount, 50, 'stake = 50');
assertEqual(game1.potAmount, 100, 'pot = 100');
assertEqual(game1.feeAmount, 20, 'fee = 20');
assertEqual(game1.prizeAmount, 80, 'prize = 80');
assertEqual(game1.bestOf, 3, 'bestOf = 3');
assertEqual(game1.winsNeeded, 2, 'winsNeeded = 2');
assertEqual(game1.phase, PHASES.WAITING, 'starts in waiting phase');
assertEqual(game1.status, STATUSES.WAITING, 'starts with waiting status');
assertEqual(game1.scoreP1, 0, 'P1 score = 0');
assertEqual(game1.scoreP2, 0, 'P2 score = 0');
assertEqual(game1.finished, false, 'not finished');

// Invalid bet
try {
  createGame({ roomId: 'bad', player1Id: 'p1', player2Id: 'p2', stakeAmount: 7 });
  assert(false, 'should throw for invalid bet');
} catch (e) {
  assert(e.message.includes('INVALID_BET'), 'throws INVALID_BET for 7 ETB');
}

// ── Test 4: Full match simulation — P1 wins 2-0 ─────────────────────────
console.log('\n=== Test 4: Full match — P1 wins 2-0 ===');
const game2 = createGame({ roomId: 'match_1', player1Id: 'alice', player2Id: 'bob', stakeAmount: 25 });

// Start match
const startEvents = startMatch(game2);
assertEqual(game2.phase, PHASES.COUNTDOWN, 'after start: countdown phase');
assertEqual(game2.status, STATUSES.ACTIVE, 'after start: active status');
assert(startEvents.length > 0, 'start emits phase_change');

// Round 1: start
const r1Start = startRound(game2);
assertEqual(game2.phase, PHASES.CHOOSE, 'round 1: choose phase');
assertEqual(game2.currentRound, 1, 'round 1: currentRound = 1');

// P1 locks rock
const r1Lock1 = lockChoice(game2, 'alice', 'rock');
assert(game2.p1Locked, 'P1 locked');
assert(!game2.p2Locked, 'P2 not locked yet');
// Check opponent_locked event was generated
assert(r1Lock1.some(e => e.type === 'opponent_locked' && e.targetPlayerId === 'bob'), 'opponent_locked sent to bob');
// No choice leaked
assert(!r1Lock1.some(e => e.choiceP1 || e.choiceP2), 'no choice leaked in lock events');

// P2 locks scissors → P1 wins round
const r1Lock2 = lockChoice(game2, 'bob', 'scissors');
assert(game2.p1Locked && game2.p2Locked, 'both locked');
assert(r1Lock2.some(e => e.type === 'round_reveal'), 'round_reveal emitted');
const reveal1 = r1Lock2.find(e => e.type === 'round_reveal');
assertEqual(reveal1.result, 'win', 'round 1: P1 wins (rock > scissors)');
assertEqual(reveal1.scoreP1, 1, 'P1 score = 1');
assertEqual(reveal1.scoreP2, 0, 'P2 score = 0');
assert(!game2.finished, 'not finished yet (need 2 wins)');

// Round 2: P1 wins again with paper > rock
const r2Start = startRound(game2);
assertEqual(game2.currentRound, 2, 'round 2');
lockChoice(game2, 'alice', 'paper');
const r2Events = lockChoice(game2, 'bob', 'rock');
const reveal2 = r2Events.find(e => e.type === 'round_reveal');
assertEqual(reveal2.result, 'win', 'round 2: P1 wins (paper > rock)');
assertEqual(reveal2.scoreP1, 2, 'P1 score = 2');
assert(game2.finished, 'match finished after 2 wins');
assertEqual(game2.winnerId, 'alice', 'alice wins');
assertEqual(game2.loserId, 'bob', 'bob loses');
assertEqual(game2.status, STATUSES.COMPLETED, 'status = completed');
assert(r2Events.some(e => e.type === 'match_result'), 'match_result emitted');

// ── Test 5: Match with draw rounds — goes to 3 rounds ───────────────────
console.log('\n=== Test 5: Match with draw — P2 wins 2-1 ===');
const game3 = createGame({ roomId: 'match_2', player1Id: 'charlie', player2Id: 'diana', stakeAmount: 100 });
startMatch(game3);

// Round 1: draw
startRound(game3);
lockChoice(game3, 'charlie', 'rock');
const d1 = lockChoice(game3, 'diana', 'rock');
const dReveal1 = d1.find(e => e.type === 'round_reveal');
assertEqual(dReveal1.result, 'draw', 'round 1: draw');
assertEqual(dReveal1.scoreP1, 0, 'draw: no score change P1');
assertEqual(dReveal1.scoreP2, 0, 'draw: no score change P2');
assert(!game3.finished, 'not finished after draw');

// Round 2: P1 wins
startRound(game3);
lockChoice(game3, 'charlie', 'scissors');
lockChoice(game3, 'diana', 'paper');
assertEqual(game3.scoreP1, 1, 'P1 score = 1 after round 2');

// Round 3: P2 wins
startRound(game3);
lockChoice(game3, 'charlie', 'rock');
lockChoice(game3, 'diana', 'paper');
assertEqual(game3.scoreP2, 1, 'P2 score = 1 after round 3');
assert(!game3.finished, 'not finished at 1-1');

// Round 4: P2 wins again
startRound(game3);
lockChoice(game3, 'charlie', 'scissors');
const r4Events = lockChoice(game3, 'diana', 'rock');
assertEqual(game3.scoreP2, 2, 'P2 score = 2');
assert(game3.finished, 'match finished');
assertEqual(game3.winnerId, 'diana', 'diana wins');

// ── Test 6: Timeout handling ────────────────────────────────────────────
console.log('\n=== Test 6: Timeout handling ===');
const game4 = createGame({ roomId: 'timeout_1', player1Id: 'eve', player2Id: 'frank', stakeAmount: 10 });
startMatch(game4);
startRound(game4);

// Only P1 locks
lockChoice(game4, 'eve', 'paper');
assert(game4.p1Locked, 'P1 locked before timeout');
assert(!game4.p2Locked, 'P2 not locked before timeout');

// Simulate timeout
const timeoutEvents = handleTimeout(game4);
assert(game4.p2Locked, 'P2 auto-locked after timeout');
assert(CHOICES.includes(game4.choiceP2), 'P2 got a random choice');
assert(timeoutEvents.some(e => e.type === 'round_reveal'), 'round resolved after timeout');

// ── Test 7: Disconnect/forfeit ──────────────────────────────────────────
console.log('\n=== Test 7: Disconnect/forfeit ===');
const game5 = createGame({ roomId: 'dc_1', player1Id: 'grace', player2Id: 'heidi', stakeAmount: 25 });
startMatch(game5);
startRound(game5);

const dcEvents = handleDisconnect(game5, 'grace');
assert(game5.finished, 'game finished after disconnect');
assertEqual(game5.winnerId, 'heidi', 'heidi wins by forfeit');
assert(dcEvents.some(e => e.type === 'match_result' && e.reason === 'opponent_disconnected'), 'match_result with disconnect reason');

// ── Test 8: Cancel before start ─────────────────────────────────────────
console.log('\n=== Test 8: Cancel before start ===');
const game6 = createGame({ roomId: 'cancel_1', player1Id: 'ivan', player2Id: null, stakeAmount: 50 });
const cancelEvents = cancelGame(game6, 'timeout');
assert(game6.finished, 'game finished after cancel');
assertEqual(game6.status, STATUSES.CANCELLED, 'status = cancelled');
assert(cancelEvents.some(e => e.type === 'match_cancelled'), 'match_cancelled emitted');

// ── Test 9: Idempotency key ─────────────────────────────────────────────
console.log('\n=== Test 9: Idempotency key ===');
const key1 = generatePayoutIdempotencyKey(game1);
const key2 = generatePayoutIdempotencyKey(game1);
assertEqual(key1, key2, 'same game → same key (deterministic)');
assert(key1.includes(game1.roomId), 'key contains roomId');

const game7 = createGame({ roomId: 'other_room', player1Id: 'a', player2Id: 'b', stakeAmount: 10 });
const key3 = generatePayoutIdempotencyKey(game7);
assert(key1 !== key3, 'different rooms → different keys');

// ── Test 10: Double-lock prevention ─────────────────────────────────────
console.log('\n=== Test 10: Double-lock prevention ===');
const game8 = createGame({ roomId: 'dbl_1', player1Id: 'jack', player2Id: 'kate', stakeAmount: 10 });
startMatch(game8);
startRound(game8);

lockChoice(game8, 'jack', 'rock');
const doubleLock = lockChoice(game8, 'jack', 'paper');
assert(doubleLock.some(e => e.type === 'error' && e.code === 'ALREADY_LOCKED'), 'double-lock returns ALREADY_LOCKED');
assertEqual(game8.choiceP1, 'rock', 'original choice preserved');

// ── Test 11: Invalid choice ────────────────────────────────────────────
console.log('\n=== Test 11: Invalid choice ===');
const game9 = createGame({ roomId: 'inv_1', player1Id: 'liam', player2Id: 'mia', stakeAmount: 10 });
startMatch(game9);
startRound(game9);

const invalidEvents = lockChoice(game9, 'liam', 'dynamite');
assert(invalidEvents.some(e => e.type === 'error' && e.code === 'INVALID_CHOICE'), 'invalid choice rejected');

// ── Test 12: Wrong phase ───────────────────────────────────────────────
console.log('\n=== Test 12: Wrong phase ===');
const game10 = createGame({ roomId: 'phase_1', player1Id: 'noah', player2Id: 'olivia', stakeAmount: 10 });
// Still in WAITING phase, try to lock
const wrongPhaseEvents = lockChoice(game10, 'noah', 'rock');
assert(wrongPhaseEvents.some(e => e.type === 'error' && e.code === 'WRONG_PHASE'), 'wrong phase rejected');

// ── Test 13: Not in game ───────────────────────────────────────────────
console.log('\n=== Test 13: Not in game ===');
const game11 = createGame({ roomId: 'nig_1', player1Id: 'pete', player2Id: 'quinn', stakeAmount: 10 });
startMatch(game11);
startRound(game11);

const notInGame = lockChoice(game11, 'stranger', 'rock');
assert(notInGame.some(e => e.type === 'error' && e.code === 'NOT_IN_GAME'), 'stranger rejected');

// ── Summary ─────────────────────────────────────────────────────────────
console.log(`\n${'='.repeat(50)}`);
console.log(`Tests: ${passed + failed} total, ${passed} passed, ${failed} failed`);
console.log('='.repeat(50));

if (failed > 0) {
  process.exit(1);
} else {
  console.log('\n🎉 All RPS game engine tests passed!\n');
  process.exit(0);
}
