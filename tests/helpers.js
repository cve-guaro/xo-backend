/**
 * Shared test helpers for the Fix #1 / Fix #2 suite.
 * Runs ONLY against xoet_local with test users ...0099 / ...0098.
 */
const net = require('net');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: 'postgresql://postgres:postgres@localhost:5432/xoet_local' });

const USER_X = '00000000-0000-0000-0000-000000000099';
const USER_O = '00000000-0000-0000-0000-000000000098';

// ── Preflight: dev server MUST be stopped before DB tests ──
function assertServerStopped() {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ port: 2000, host: '127.0.0.1' });
    sock.setTimeout(700);
    sock.on('connect', () => { sock.destroy(); reject(new Error('Dev server is RUNNING on port 2000 — stop it before running the suite (zombie node processes count too).')); });
    sock.on('timeout', () => { sock.destroy(); resolve(); });
    sock.on('error', () => resolve());
  });
}

async function assertNoForeignDbClients() {
  const { rows } = await pool.query(`
    SELECT pid, state, left(query, 60) AS q FROM pg_stat_activity
    WHERE datname = 'xoet_local' AND pid <> pg_backend_pid()
      AND state <> 'idle'
  `);
  if (rows.length > 0) {
    console.log('  [preflight] active foreign DB sessions (informational):', JSON.stringify(rows));
  }
}

// ── reset test users ──
async function resetUsers() {
  await pool.query('BEGIN');
  await pool.query(`DELETE FROM wallet_transactions WHERE user_id IN ($1, $2)`, [USER_X, USER_O]);
  await pool.query(`UPDATE wallets SET available_balance = 0, withdrawable_balance = 0, bonus_balance = 0 WHERE user_id IN ($1, $2)`, [USER_X, USER_O]);
  await pool.query(`DELETE FROM withdraw_requests WHERE user_id IN ($1, $2)`, [USER_X, USER_O]);
  await pool.query('COMMIT');
}

// ── invariant: available >= withdrawable + bonus, nothing negative ──
async function checkInvariant(label) {
  const { rows } = await pool.query(`
    SELECT user_id::text, available_balance::int AS avail, withdrawable_balance::int AS wd, bonus_balance::int AS bonus
    FROM wallets WHERE user_id IN ($1, $2)
  `, [USER_X, USER_O]);
  const bad = rows.filter(r => r.avail < 0 || r.wd < 0 || r.bonus < 0 || r.avail < r.wd + r.bonus);
  if (bad.length > 0) {
    throw new Error(`INVARIANT VIOLATION (${label}): ${JSON.stringify(bad)}`);
  }
  return true;
}

async function walletOf(userId) {
  const { rows } = await pool.query(
    `SELECT available_balance::int, withdrawable_balance::int, bonus_balance::int FROM wallets WHERE user_id = $1`, [userId]);
  return rows[0];
}

async function txsOf(userId) {
  const { rows } = await pool.query(
    `SELECT id::text, tx_type, status, amount::int, idempotency_key FROM wallet_transactions WHERE user_id = $1 ORDER BY created_at, id`, [userId]);
  return rows;
}

async function insertPendingWithdraw(key, amount = 100, userId = USER_X) {
  const { rows } = await pool.query(`
    INSERT INTO wallet_transactions (user_id, tx_type, amount, status, idempotency_key, provider, meta, created_at)
    VALUES ($1, 'WITHDRAW_REQUEST', $2, 'PENDING', $3, 'CHAPA', '{}', now() - interval '60 seconds')
    RETURNING id::text AS id
  `, [userId, amount, key]);
  return rows[0].id;
}

let passCount = 0, failCount = 0;
async function report(name, ok, detail) {
  if (ok) { passCount++; console.log(`  PASS | ${name}${detail ? ' — ' + detail : ''}`); }
  else { failCount++; console.log(`  FAIL | ${name}${detail ? ' — ' + detail : ''}`); }
}
function summary() {
  console.log(`\n==== SUITE SUMMARY: ${passCount} passed, ${failCount} failed ====`);
  return failCount === 0;
}

module.exports = {
  pool, USER_X, USER_O,
  assertServerStopped, assertNoForeignDbClients, resetUsers, checkInvariant,
  walletOf, txsOf, insertPendingWithdraw, report, summary
};
