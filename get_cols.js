const { pool } = require('./src/db/index');
pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'wallet_transactions';")
  .then(res => { console.log(res.rows.map(r=>r.column_name)); process.exit(0); })
  .catch(console.error);
