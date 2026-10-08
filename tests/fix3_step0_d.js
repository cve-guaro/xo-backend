/**
 * FIX #3 STEP 0d — /account/redeem-code parallel redemption, through the REAL
 * route handler extracted from the router stack.
 *
 * FINDING BEFORE THE RACE: promocode_claims DOES NOT EXIST in xoet_local (and
 * likely not in production — setup_local_db.js mirrors production tables), so
 * the route 500s on every call. This script creates the table as a TEST FIXTURE
 * (labelled; the real fix is Step 1.3's migration + rewrite) so the race can be
 * characterized: (1) 10 parallel calls, same code, same user; (2) 10 users on a
 * usage_limit=1 code.
 */
process.env.LOCAL_CORS = 'http://localhost:9999';
const { assertServerStopped, pool, USER_X } = require('./helpers');
const accountRouter = require('../src/routes/account');

let redeemHandler = null;
for (const layer of accountRouter.stack) {
  if (layer.route && layer.route.path === '/redeem-code') {
    const h = layer.route.stack.filter(l => l.handle);
    redeemHandler = h[h.length - 1].handle;
  }
}
if (!redeemHandler) { console.error('redeem handler not found'); process.exit(1); }

function callRedeem(userId, code) {
  const res = {
    statusCode: 0, _resolve: null,
    status(c) { this.statusCode = c; return this; },
    json(o) { this._body = o; if (this._resolve) this._resolve({ status: this.statusCode || 200, body: o }); return this; }
  };
  const req = { user: { id: userId }, body: { code }, params: {}, query: {} };
  return new Promise(resolve => {
    res._resolve = resolve;
    try { redeemHandler(req, res, () => resolve({ status: 'next' })); }
    catch (e) { resolve({ status: 'throw', body: { error: e.message } }); }
  });
}

async function walletOf(userId) {
  const w = await pool.query(`SELECT available_balance::int AS avail, bonus_balance::int AS bonus FROM wallets WHERE user_id = $1`, [userId]);
  return w.rows[0];
}

async function main() {
  await assertServerStopped();
  console.log('preflight: dev server stopped — OK');

  // Test fixture table (production schema unknown — minimal shape the route uses)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS promocode_claims (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      promocode_id uuid NOT NULL,
      user_id uuid NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  console.log('fixture: promocode_claims table present (was MISSING locally)\n');

  // ── TEST 1: 10 parallel calls, same code, same user ──
  console.log('═══ (d)-1: 10 parallel redemptions, SAME code + SAME user ══');
  await pool.query(`DELETE FROM promocode_claims`);
  await pool.query(`DELETE FROM promocodes WHERE code LIKE 'XORACE%'`);
  await pool.query(`DELETE FROM wallet_transactions WHERE user_id = $1 AND provider = 'PROMOCODE'`, [USER_X]);
  await pool.query(`DELETE FROM bonus_logs WHERE user_id = $1 AND reason LIKE 'Promocode%'`, [USER_X]);
  await pool.query(`UPDATE wallets SET available_balance = 0, withdrawable_balance = 0, bonus_balance = 0 WHERE user_id = $1`, [USER_X]);
  const codeA = (await pool.query(`
    INSERT INTO promocodes (code, amount, target_type, is_active, usage_limit, status)
    VALUES ('XORACE10', 50, 'ALL', true, NULL, 'ACTIVE') RETURNING id::text AS id
  `)).rows[0].id;

  const results1 = await Promise.all(Array.from({ length: 10 }, () => callRedeem(USER_X, 'XORACE10')));
  const okCount1 = results1.filter(r => r.status === 200).length;
  const w1 = await walletOf(USER_X);
  const ledger1 = await pool.query(`SELECT count(*)::int AS c FROM wallet_transactions WHERE user_id = $1 AND provider = 'PROMOCODE'`, [USER_X]);
  const claims1 = await pool.query(`SELECT count(*)::int AS c FROM promocode_claims WHERE promocode_id = $1`, [codeA]);
  console.log(`  responses 200: ${okCount1}/10 (others: ${results1.filter(r => r.status !== 200).map(r => r.status).join(',') || 'none'})`);
  console.log(`  wallet: ${JSON.stringify(w1)} (a single 50-credit would be avail=50 bonus=50)`);
  console.log(`  ledger rows: ${ledger1.rows[0].c}, promocode_claims rows: ${claims1.rows[0].c}`);
  console.log(`  >>> ${w1.avail > 50 ? 'DOUBLE CREDIT: ' + w1.avail + ' from 10 parallel calls' : 'credited once'}`);

  // ── TEST 2: 10 users on a usage_limit=1 code ──
  console.log('\n═══ (d)-2: 10 users in parallel on a usage_limit=1 code ══');
  await pool.query(`DELETE FROM promocode_claims`);
  await pool.query(`DELETE FROM promocodes WHERE code LIKE 'XORACE%'`);
  const codeB = (await pool.query(`
    INSERT INTO promocodes (code, amount, target_type, is_active, usage_limit, status)
    VALUES ('XORACE1LIMIT', 50, 'ALL', true, 1, 'ACTIVE') RETURNING id::text AS id
  `)).rows[0].id;

  // 10 scratch users
  const userIds = [];
  for (let i = 1; i <= 10; i++) {
    const u = await pool.query(`
      INSERT INTO users (number, username) VALUES ($1, $2) RETURNING id::text AS id
    `, [`09111100${String(i).padStart(2, '0')}`, `race_user_${i}`]);
    userIds.push(u.rows[0].id);
    await pool.query(`INSERT INTO wallets (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [u.rows[0].id]);
  }

  const results2 = await Promise.all(userIds.map(id => callRedeem(id, 'XORACE1LIMIT')));
  const okCount2 = results2.filter(r => r.status === 200).length;
  const claims2 = await pool.query(`SELECT count(*)::int AS c FROM promocode_claims WHERE promocode_id = $1`, [codeB]);
  const credited = await pool.query(`
    SELECT count(*)::int AS c FROM wallet_transactions WHERE provider = 'PROMOCODE'
      AND idempotency_key LIKE 'PROMOCODE_${codeB}%'
  `);
  console.log(`  responses 200: ${okCount2}/10 (usage_limit was 1)`);
  console.log(`  promocode_claims rows: ${claims2.rows[0].c}, ledger rows: ${credited.rows[0].c}`);
  const totals = [];
  for (const id of userIds) { const w = await walletOf(id); totals.push(w.avail); }
  console.log(`  per-user available: ${totals.join(',')}`);
  console.log(`  >>> ${okCount2 > 1 ? 'USAGE LIMIT BYPASSED: ' + okCount2 + ' of 10 users credited on a one-use code' : 'limit held'}`);

  // cleanup
  await pool.query(`DELETE FROM promocode_claims`);
  await pool.query(`DELETE FROM promocodes WHERE code LIKE 'XORACE%'`);
  await pool.query(`DELETE FROM wallet_transactions WHERE provider = 'PROMOCODE'`);
  await pool.query(`DELETE FROM bonus_logs WHERE reason LIKE 'Promocode%' OR reason LIKE '%XORACE%'`);
  for (const id of userIds) {
    await pool.query(`DELETE FROM wallets WHERE user_id = $1`, [id]);
    await pool.query(`DELETE FROM users WHERE id = $1`, [id]);
  }
  await pool.query(`UPDATE wallets SET available_balance = 0, withdrawable_balance = 0, bonus_balance = 0 WHERE user_id = $1`, [USER_X]);
  console.log('\ncleanup done (fixture table promocode_claims left in place — Step 1.3 owns the real migration)');
  await pool.end();
  process.exit(0);
}
main().catch(e => { console.error('FATAL:', e.message, e.stack); process.exit(1); });
