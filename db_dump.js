const { pool } = require('./src/db/index.js');
async function run() {
  try {
    const res = await pool.query("SELECT pg_get_functiondef('fn_wallet_apply_existing_tx'::regproc) AS def;");
    console.log(res.rows[0].def);
  } catch(e) { console.error(e); }
  process.exit(0);
}
run();
