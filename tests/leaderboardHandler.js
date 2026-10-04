/**
 * Shared helper: extract the real POST /leaderboard/snapshot handler from the
 * admin router stack and expose call/state utilities for tests.
 */
const smsModule = require('../src/utils/sms');
smsModule.sendSMS = async () => true;

const adminRouter = require('../src/routes/admin');

let snapshotHandler = null;
for (const layer of adminRouter.stack) {
  if (layer.route && layer.route.path === '/leaderboard/snapshot') {
    const handles = layer.route.stack.filter(l => l.handle);
    snapshotHandler = handles[handles.length - 1].handle;
  }
}

function callHandler() {
  const res = {
    statusCode: 0, _resolve: null,
    status(c) { this.statusCode = c; return this; },
    json(o) { this._body = o; if (this._resolve) this._resolve({ status: this.statusCode || 200, body: o }); return this; }
  };
  const req = {
    body: { prizes: [500, 300, 200], autoApprove: true },
    user: { id: '00000000-0000-0000-0000-000000000001' }, params: {}, query: {}
  };
  return new Promise(resolve => {
    res._resolve = resolve;
    try { snapshotHandler(req, res, () => resolve({ status: 'next' })); }
    catch (e) { resolve({ status: 'throw', body: { error: e.message } }); }
  });
}

async function setupWeek() {
  const { USER_X, USER_O } = require('./helpers');
  const pool = require('./helpers').pool;
  await pool.query('BEGIN');
  await pool.query(`DELETE FROM leaderboard_snapshots`);
  await pool.query(`DELETE FROM wallet_transactions WHERE provider = 'LEADERBOARD_PRIZE'`);
  await pool.query(`DELETE FROM bonus_logs WHERE reason LIKE 'Weekly Leaderboard%'`);
  await pool.query(`UPDATE wallets SET available_balance = 0, withdrawable_balance = 0, bonus_balance = 0 WHERE user_id = $1`, [USER_X]);
  await pool.query(`DELETE FROM games WHERE player_x = $1 AND status = 'completed' AND winner = $1`, [USER_X]);
  for (let i = 0; i < 2; i++) {
    await pool.query(`
      INSERT INTO games (player_x, player_o, bet_amount, status, winner, prize_amount, created_at, finished_at)
      VALUES ($1, $2, 100, 'completed', $1, 180, now(), now())
    `, [USER_X, USER_O]);
  }
  await pool.query('COMMIT');
}

async function measureWeek() {
  const { USER_X } = require('./helpers');
  const pool = require('./helpers').pool;
  const w = await pool.query(`SELECT available_balance::int AS a, bonus_balance::int AS b FROM wallets WHERE user_id = $1`, [USER_X]);
  const s = await pool.query(`SELECT count(*)::int AS c FROM leaderboard_snapshots`);
  const l = await pool.query(`SELECT count(*)::int AS c FROM wallet_transactions WHERE provider = 'LEADERBOARD_PRIZE'`);
  const bl = await pool.query(`SELECT count(*)::int AS c FROM bonus_logs WHERE reason LIKE 'Weekly Leaderboard%'`);
  return { avail: w.rows[0].a, bonus: w.rows[0].b, snaps: s.rows[0].c, ledger: l.rows[0].c, blogs: bl.rows[0].c };
}

async function cleanupWeek() {
  const { USER_X } = require('./helpers');
  const pool = require('./helpers').pool;
  await pool.query(`DELETE FROM leaderboard_snapshots`);
  await pool.query(`DELETE FROM wallet_transactions WHERE provider = 'LEADERBOARD_PRIZE'`);
  await pool.query(`DELETE FROM bonus_logs WHERE reason LIKE 'Weekly Leaderboard%'`);
  await pool.query(`UPDATE wallets SET available_balance = 0, withdrawable_balance = 0, bonus_balance = 0 WHERE user_id = $1`, [USER_X]);
  await pool.query(`DELETE FROM games WHERE player_x = $1 AND status = 'completed' AND winner = $1`, [USER_X]);
}

module.exports = { callHandler, setupWeek, measureWeek, cleanupWeek, handlerAvailable: !!snapshotHandler };
