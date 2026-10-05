/**
 * FIX #3 STEP 0b — END-TO-END SOCKET TEST.
 * Boots the real backend on a spare port (2100), logs in two real local test
 * accounts through the OTP flow (SMS may fail to actually send — the OTP is read
 * from the DB), connects two socket.io clients, plays a full XO game to a win,
 * then asserts the games row (incl. migration-011 bucket columns), both wallets
 * and the payout ledger.
 *
 * Gate: this is part of `npm test` (serverStopped preflight does not apply —
 * this test starts its OWN server on port 2100).
 */
process.env.E2E_PORT = '2100';
const { execFile } = require('child_process');
const http = require('http');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CLIENT_PATH = 'C:/Users/ThinkPad 14/OneDrive/Desktop/new vertion/Xoet/xoet-3/node_modules/socket.io-client';
const { io } = require(CLIENT_PATH);
const { Pool } = require('pg');
const pool = new Pool({ connectionString: 'postgresql://postgres:postgres@localhost:5432/xoet_local' });

const PORT = 2100;
const BASE = `http://localhost:${PORT}`;
const NUMBERS = ['0939484533', '0933037952'];
const BET = 10;

function health() {
  return new Promise(resolve => {
    http.get(`${BASE}/health`, r => resolve(r.statusCode === 200)).on('error', () => resolve(false));
  });
}
async function waitServer(tries = 40) {
  for (let i = 0; i < tries; i++) { if (await health()) return true; await new Promise(r => setTimeout(r, 500)); }
  return false;
}
async function post(body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(`${BASE}/auth/verify-otp`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'x-platform': 'web' } }, res => {
      let buf = ''; res.on('data', c => buf += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(buf) }); } catch (e) { resolve({ status: res.statusCode, json: { raw: buf } }); } });
    });
    req.on('error', reject); req.write(data); req.end();
  });
}
async function getToken(number) {
  // Insert an OTP directly (request-otp would attempt a real SMS send).
  // verify-otp normalizes to international format, store the row that way.
  const normalized = '251' + number.replace(/\D/g, '').slice(-9);
  const code = String(Math.floor(100000 + Math.random() * 900000));
  await pool.query(`INSERT INTO otps (number, code, expires_at) VALUES ($1, $2, now() + interval '10 minutes')`, [normalized, code]);
  const res = await post({ number, code });
  if (res.status !== 200 || !res.json.token) throw new Error(`verify-otp failed for ${number}: ${JSON.stringify(res.json)}`);
  return res.json.token;
}

function connectSocket(token) {
  return new Promise((resolve, reject) => {
    const sock = io(BASE, { transports: ['websocket'], reconnection: false, timeout: 10000 });
    sock.on('connect', () => resolve(sock));
    sock.on('connect_error', reject);
    setTimeout(() => reject(new Error('socket connect timeout')), 12000);
  });
}

function waitFor(sock, event, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs);
    sock.once(event, (p) => { clearTimeout(t); resolve(p); });
  });
}

async function main() {
  console.log('STEP 1: starting backend child on port', PORT);
  const child = execFile('node', ['src/server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), LOCAL_CORS: 'http://localhost:9999' } });
  child.stdout.on('data', () => {}); child.stderr.on('data', d => process.stderr.write(d));
  if (!(await waitServer())) throw new Error('backend did not start');
  console.log('  backend healthy on', PORT);

  console.log('STEP 2: authenticating two test accounts via OTP flow');
  const tokens = {};
  for (const n of NUMBERS) tokens[n] = await getToken(n);
  const ids = await pool.query(`SELECT id::text, number FROM users WHERE number IN ('0939484533','251939484533','0933037952','251933037952')`);
  const idByNumber = {};
  ids.rows.forEach(r => { const last9 = r.number.replace(/\D/g, '').slice(-9); idByNumber[last9] = r.id; });
  const userA = idByNumber[NUMBERS[0].slice(-9)];
  const userB = idByNumber[NUMBERS[1].slice(-9)];
  console.log('  users:', userA, userB);

  console.log('STEP 3: snapshot wallets before the game');
  for (const u of [userA, userB]) {
    // Test setup: stake-able balance, no stale tier locks, no stale in-game flags
    await pool.query(`UPDATE wallets SET available_balance = GREATEST(available_balance, 100), withdrawable_balance = GREATEST(withdrawable_balance, 100) WHERE user_id = $1`, [u]);
    await pool.query(`UPDATE users SET r1_10_wins = 0, r1_15_wins = 0 WHERE id = $1`, [u]);
  }
  const snap = {};
  for (const u of [userA, userB]) {
    const w = await pool.query(`SELECT available_balance, withdrawable_balance, bonus_balance FROM wallets WHERE user_id = $1`, [u]);
    snap[u] = w.rows[0];
    console.log(`  ${u.slice(0, 8)}…`, JSON.stringify(w.rows[0]));
  }

  console.log('STEP 4: connect sockets and find a match');
  const sockA = await connectSocket(tokens[NUMBERS[0]]);
  const sockB = await connectSocket(tokens[NUMBERS[1]]);

  const mfA = waitFor(sockA, 'match_found');
  const mfB = waitFor(sockB, 'match_found');
  const errA = waitFor(sockA, 'error', 8000).catch(e => e.message);
  sockA.emit('find_match', { token: tokens[NUMBERS[0]], betAmount: BET, betMin: BET, betMax: BET }, r => console.log('  find_match ack A:', JSON.stringify(r)));
  sockB.emit('find_match', { token: tokens[NUMBERS[1]], betAmount: BET, betMin: BET, betMax: BET }, r => console.log('  find_match ack B:', JSON.stringify(r)));
  const [pa, pb] = await Promise.all([mfA, mfB]);
  if (pa.matchId !== pb.matchId) throw new Error('matchId mismatch');
  const matchId = pa.matchId;
  console.log(`  match_found: matchId=${matchId.slice(0, 8)}… A=${pa.youAre} B=${pb.youAre}`);

  console.log('STEP 5: play to a win (X: 0,1,2 — O: 3,4)');
  await new Promise(r => setTimeout(r, 4000)); // 3s pre-match delay
  const gwA = waitFor(sockA, 'game_won', 30000);
  const gwB = waitFor(sockB, 'game_won', 30000);
  const xSock = pa.youAre === 'X' ? sockA : sockB;
  const oSock = pa.youAre === 'X' ? sockB : sockA;
  const moves = [[xSock, 0], [oSock, 3], [xSock, 1], [oSock, 4], [xSock, 2]];
  for (const [sock, index] of moves) {
    await new Promise(r => setTimeout(r, 400));
    sock.emit('make_move', { matchId, index });
  }
  const win = await gwA;
  console.log(`  game_won: winner=${win.winnerId?.slice(0, 8)}… symbol=${win.winnerSymbol} prize=${win.prizeAmount}`);
  const winnerId = win.winnerId;

  console.log('STEP 6: assert DB state');
  const g = (await pool.query(`SELECT status, winner::text AS winner, prize_amount::int AS prize, bonus_used_x, withdrawable_used_x, locked_used_x, moves FROM games WHERE id = $1`, [matchId])).rows[0];
  console.log('  games row:', JSON.stringify(g));
  // Room 1 house cut is 20% per ROOMS_CONFIG (NOT the flat 10% in ARCHITECTURE.md,
  // and NOT the 0.9 pay-winner hardcode) — expected prize = floor(10*2*0.8) = 16
  const expectedPrize = Math.floor(BET * 2 * 0.8);
  if (g.status !== 'completed' || g.winner !== winnerId || g.prize !== expectedPrize) {
    throw new Error(`GAME ROW ASSERTION FAILED: status=${g.status} winner=${g.winner} prize=${g.prize} (expected ${expectedPrize})`);
  }
  const movesArr = Array.isArray(g.moves) ? g.moves : JSON.parse(g.moves || '[]');
  if (movesArr.length !== 5) throw new Error('MOVES NOT SAVED');
  const splitSum = Number(g.bonus_used_x) + Number(g.withdrawable_used_x) + Number(g.locked_used_x);
  if (splitSum !== BET) throw new Error(`BUCKET SPLIT NOT RECORDED: bonus=${g.bonus_used_x} + wd=${g.withdrawable_used_x} + locked=${g.locked_used_x} != ${BET}`);
  const loserId = winnerId === userA ? userB : userA;
  const wWin = (await pool.query(`SELECT available_balance, withdrawable_balance, bonus_balance FROM wallets WHERE user_id = $1`, [winnerId])).rows[0];
  const wLose = (await pool.query(`SELECT available_balance, withdrawable_balance, bonus_balance FROM wallets WHERE user_id = $1`, [loserId])).rows[0];
  console.log('  winner wallet:', JSON.stringify(wWin), '(before:', JSON.stringify(snap[winnerId]), ')');
  console.log('  loser  wallet:', JSON.stringify(wLose), '(before:', JSON.stringify(snap[loserId]), ')');
  const winDelta = Number(wWin.available_balance) - Number(snap[winnerId].available_balance);
  const loseDelta = Number(wLose.available_balance) - Number(snap[loserId].available_balance);
  // Net winner delta = prize − own stake (the stake was deducted after the snapshot)
  if (winDelta !== expectedPrize - BET) throw new Error(`WINNER NET DELTA ${winDelta} != ${expectedPrize - BET}`);
  if (loseDelta !== -BET) throw new Error(`LOSER WALLET DELTA ${loseDelta} != -${BET}`);
  const ledger = await pool.query(`SELECT count(*)::int AS c FROM payment_transactions WHERE user_id = $1 AND bank = 'PRIZE' AND tx_ref LIKE 'game-${matchId}%'`, [winnerId]);
  console.log('  winner prize ledger rows:', ledger.rows[0].c);
  if (ledger.rows[0].c !== 1) throw new Error('PRIZE LEDGER ROW MISSING');
  console.log('\n✅ E2E PASS: game row, wallets and ledger all consistent');

  sockA.disconnect(); sockB.disconnect();
  child.kill();
  await pool.end();
  process.exit(0);
}

main().catch(e => {
  console.error('\n❌ E2E FAIL:', e.message);
  try { child.kill(); } catch (_) {}
  process.exit(1);
});
