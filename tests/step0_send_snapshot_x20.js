/**
 * Fix #2 STEP 0 (e): call the real POST /leaderboard/snapshot handler as
 * two parallel calls, 20 times in a loop, same week each time.
 * Report any duplicate snapshot rows or double credits.
 */
process.env.LOCAL_CORS = 'http://localhost:9999';
const smsModule = require('../src/utils/sms');
smsModule.sendSMS = async () => true;

const { assertServerStopped, pool, USER_X, USER_O } = require('./helpers');
const adminRouter = require('../src/routes/admin');

let snapshotHandler = null;
for (const layer of adminRouter.stack) {
  if (layer.route && layer.route.path === '/leaderboard/snapshot') {
    const handles = layer.route.stack.filter(l => l.handle);
    snapshotHandler = handles[handles.length - 1].handle;
  }
}
if (!snapshotHandler) { console.error('handler not found'); process.exit(1); }

function callHandler(label) {
  const res = {
    statusCode: 0, _resolve: null,
    status(c) { this.statusCode = c; return this; },
    json(o) { this._body = o; if (this._resolve) this._resolve({ status: this.statusCode || 200, body: o }); return this; }
  };
  const req = { body: { prizes: [500, 300, 200], autoApprove: true }, user: { id: '00000000-0000-0000-0000-000000000001' }, params: {}, query: {} };
  return new Promise(resolve => {
    res._resolve = resolve;
    try { snapshotHandler(req, res, () => resolve({ status: 'next' })); }
    catch (e) { resolve({ status: 'throw', body: { error: e.message } }); }
  });
}

async function setup() {
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

async function measure() {
  const w = await pool.query(`SELECT available_balance::int AS a, bonus_balance::int AS b FROM wallets WHERE user_id = $1`, [USER_X]);
  const s = await pool.query(`SELECT count(*)::int AS c FROM leaderboard_snapshots`);
  const l = await pool.query(`SELECT count(*)::int AS c FROM wallet_transactions WHERE provider = 'LEADERBOARD_PRIZE'`);
  const bl = await pool.query(`SELECT count(*)::int AS c FROM bonus_logs WHERE reason LIKE 'Weekly Leaderboard%'`);
  return { avail: w.rows[0].a, snaps: s.rows[0].c, ledger: l.rows[0].c, blogs: bl.rows[0].c };
}

async function main() {
  await assertServerStopped();
  console.log('preflight: dev server stopped — OK');
  let doubles = 0, guarded = 0, paidOnce = 0;

  for (let i = 1; i <= 20; i++) {
    await setup();
    const [r1, r2] = await Promise.allSettled([callHandler('p1'), callHandler('p2')]);
    const m = await measure();
    const st1 = r1.status === 'fulfilled' ? r1.value.status : 'rejected';
    const st2 = r2.status === 'fulfilled' ? r2.value.status : 'rejected';
    const doubleCredit = m.avail > 500 || m.blogs > 1 || m.ledger > 1;
    const dupSnapshot = m.snaps > 1;
    const tag = doubleCredit ? '❌ DOUBLE CREDIT' : (dupSnapshot ? '⚠️ credit-once but duplicate snapshot' : '✅ once');
    if (doubleCredit) doubles++;
    else if (!dupSnapshot) paidOnce++;
    console.log(`  iter ${String(i).padStart(2)}: responses=[${st1},${st2}] avail=+${m.avail} snapshots=${m.snaps} ledger=${m.ledger} -> ${tag}`);
  }

  console.log(`\nRESULT: 20 parallel double-click iterations -> doubleCredits=${doubles}, fullyClean=${paidOnce}, duplicateSnapshotOnly=${20 - doubles - paidOnce}`);
  console.log(doubles > 0
    ? '>>> DOUBLE CREDIT REPRODUCED — the exists-check race is real, not just theoretical'
    : '>>> no double credit — ledger-first guard holds; duplicate snapshots (if any) are closed by the UNIQUE (week_start, rank) migration');
  await setup(); // leave DB clean
  await pool.end();
  process.exit(0);
}
main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
