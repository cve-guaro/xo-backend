const { Pool } = require('pg');
const pool = new Pool({ connectionString: 'postgres://postgres:S416040g@127.0.0.1:5432/xoet' });
pool.query("SELECT enum_range(NULL::game_status)").then(r => {
  console.log(r.rows);
  process.exit(0);
}).catch(e => {
  pool.query("SELECT DISTINCT status FROM games").then(r => {
    console.log(r.rows);
    process.exit(0);
  }).catch(e2 => {
    console.log(e2);
    process.exit(1);
  });
});
