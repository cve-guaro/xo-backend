/**
 * Fix #2 STEP 0 (b) + (c) — reproduction against the REAL code:
 *  (b) ghost cron on a game stuck >30 min: does the cleanup tx roll back?
 *  (c) forced DB error inside finishAndPayout's tx, then the ghost cron.
 *
 * The ghost-cleanup callback is the REAL inline function registered in cron.js —
 * captured by wrapping cron.schedule() before initCron() runs (same technique as
 * the router-stack handler extraction). finishAndPayout is the real game.js export.
 * Dev server must be STOPPED.
 */
process.env.LOCAL_CORS = 'http://localhost:9999';

const { assertServerStopped, pool, USER_X, USER_O } = require('./helpers');

// ── capture the real ghost-cleanup callback from cron.js ──
const nodeCron = require('node-cron');
const origSchedule = nodeCron.schedule.bind(nodeCron);
let ghostCallback = null;
nodeCron.schedule = (pattern, fn, opts) => {
  if (!ghostCallback && pattern === '*/10 * * * *') { ghostCallback = fn; console.log('[capture] ghost-cleanup callback captured'); }
  return origSchedule(pattern, fn, opts);
};
require('../src/cron').initCron();
if (!ghostCallback) { console.error('FATAL: ghost callback not captured'); process.exit(1); }

const { finishAndPayout } = require('../src/socket/game');

async function setupStuckGame(ageMinutes) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`DELETE FROM wallet_transactions WHERE user_id IN ($1,$2)`, [USER_X, USER_O]);
    await c.query(`UPDATE wallets SET available_balance = 0, withdrawable_balance = 0, bonus_balance = 0 WHERE user_id IN ($1,$2)`, [USER_X, USER_O]);
    await c.query(`DELETE FROM games WHERE (player_x = $1 OR player_o = $1) AND status IN ('ongoing','live','countdown','completed')`, [USER_X]);
    // stakes are treated as already deducted: wallets start at 0
    const { rows } = await c.query(`
      INSERT INTO games (player_x, player_o, bet_amount, status, winner, prize_amount, created_at, finished_at, moves)
      VALUES ($1, $2, 100, 'ongoing', NULL, 0, now() - ($3 || ' minutes')::interval, NULL, '[]'::jsonb)
      RETURNING id::text AS id
    `, [USER_X, USER_O, String(ageMinutes)]);
    await c.query('COMMIT');
    return rows[0].id;
  } finally { c.release(); }
}

async function state(label) {
  const g = await pool.query(`SELECT id::text, status, winner::text, prize_amount::int, created_at FROM games WHERE (player_x=$1 OR player_o=$1) ORDER BY created_at DESC LIMIT 2`, [USER_X]);
  const wx = await pool.query(`SELECT available_balance::int, withdrawable_balance::int, bonus_balance::int FROM wallets WHERE user_id=$1`, [USER_X]);
  const wo = await pool.query(`SELECT available_balance::int, withdrawable_balance::int, bonus_balance::int FROM wallets WHERE user_id=$1`, [USER_O]);
  const ledger = await pool.query(`SELECT count(*)::int AS c FROM wallet_transactions WHERE user_id IN ($1,$2)`, [USER_X, USER_O]);
  console.log(`  --- ${label} ---`);
  g.rows.forEach(r => console.log(`    game ${r.id.slice(0,8)}: status=${r.status} winner=${r.winner} prize=${r.prize_amount} age_min=${Math.round((Date.now()-new Date(r.created_at))/60000)}`));
  console.log(`    wallet X (...0099):`, JSON.stringify(wx.rows[0]), ` wallet O (...0098):`, JSON.stringify(wo.rows[0]));
  console.log(`    ledger rows for both users: ${ledger.rows[0].c}`);
  return { g: g.rows, wx: wx.rows[0], wo: wo.rows[0], ledger: ledger.rows[0].c };
}

async function main() {
  await assertServerStopped();
  console.log('preflight: dev server stopped — OK');

  // ══ (b) ghost cron on a game stuck >30 min ══
  console.log('\n═══ (b) GHOST CRON on game stuck >30 min (real cron.js callback) ══');
  await setupStuckGame(31);
  await state('before cron run 1');
  console.log('  > ghostCallback() run 1:');
  await ghostCallback();
  const b1 = await state('after cron run 1');
  console.log('  > ghostCallback() run 2:');
  await ghostCallback();
  const b2 = await state('after cron run 2');
  console.log(`  VERDICT (b): game status after 2 cron runs = "${b2.g[0]?.status}" | wallets X=${JSON.stringify(b2.wx)} O=${JSON.stringify(b2.wo)} | ledger=${b2.ledger}`);
  console.log(b2.g[0]?.status === 'ongoing' ? '  >>> ROLLBACK CONFIRMED: cleanup failed, game still ongoing, stakes not refunded' : '  >>> cleanup succeeded');

  // ══ (c) forced DB error inside finishAndPayout's tx, then ghost cron ══
  console.log('\n═══ (c) finishAndPayout with forced DB error (wallets table unavailable mid-tx) ══');
  const gameId = await setupStuckGame(0); // fresh game, winner path will run
  // set an in-memory activeGames entry like the real flow would have
  const { activeGames } = require('../src/socket/game');
  activeGames.set(gameId, { players: { X: USER_X, O: USER_O }, finished: false, moves: [] });

  console.log('  > renaming wallets -> wallets_payout_test_bak (forces 42P01 inside the payout tx)');
  await pool.query('ALTER TABLE wallets RENAME TO wallets_payout_test_bak');
  finishAndPayout(gameId, 'X', USER_X, 180); // fire-and-forget, exactly like production call sites
  await new Promise(r => setTimeout(r, 1500));
  await pool.query('ALTER TABLE wallets_payout_test_bak RENAME TO wallets');
  console.log('  > wallets table restored');

  const c1 = await state('after failed payout');
  const ag = activeGames.get(gameId);
  console.log(`  in-memory gameObj.finished = ${ag ? ag.finished : 'entry gone'}`);
  console.log(c1.g[0]?.status === 'ongoing' && c1.g[0]?.winner === null
    ? '  >>> PAYOUT LOSS CONFIRMED: tx rolled back, game row still ongoing, winner never credited, no retry'
    : '  >>> payout behaved differently — see state above');

  // simulate 30 minutes passing, then run the real ghost cron
  await pool.query(`UPDATE games SET created_at = now() - interval '31 minutes' WHERE id = $1`, [gameId]);
  console.log('  > game aged 31 min; running real ghost cron:');
  await ghostCallback();
  const c2 = await state('after ghost cron (31 min later)');
  const locked = c2.g[0]?.status === 'ongoing' && c2.wx.available_balance === 0 && c2.wo.available_balance === 0;
  console.log(locked
    ? '  >>> STAKES LOCKED FOREVER CONFIRMED: payout failed AND ghost cleanup rolled back — both wallets still 0'
    : '  >>> ghost cleanup did NOT stay rolled back — see state above');

  // cleanup: remove test game + in-memory entry
  await pool.query(`DELETE FROM games WHERE id = $1`, [gameId]);
  activeGames.delete(gameId);
  console.log('\ncleanup done.');
  await pool.end();
  process.exit(0);
}

main().catch(async e => { console.error('FATAL:', e.message, e.stack); process.exit(1); });
