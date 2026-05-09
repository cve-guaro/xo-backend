const { pool } = require('./src/db');
pool.query("SELECT pg_get_functiondef(p.oid) FROM pg_proc p WHERE p.proname = 'fn_wallet_apply_existing_tx'")
  .then(res => console.log(res.rows[0].pg_get_functiondef))
  .catch(console.error)
  .finally(() => process.exit());
