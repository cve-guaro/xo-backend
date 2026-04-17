const { pool } = require('../src/db/index');
pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'users'")
  .then(r => console.log(r.rows.map(row => row.column_name)))
  .catch(console.error)
  .finally(() => process.exit());
