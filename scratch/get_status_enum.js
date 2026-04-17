const { pool } = require('../src/db/index');
pool.query("SELECT enum_range(NULL::wallet_tx_status)")
  .then(r => console.log(r.rows))
  .catch(console.error)
  .finally(() => process.exit());
