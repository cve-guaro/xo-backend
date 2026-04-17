const { pool } = require('../src/db/index');
pool.query("SELECT pg_get_functiondef(oid) FROM pg_proc WHERE proname LIKE 'trig_wallet%' OR proname LIKE 'fn_wallet%'").then(r => { 
  r.rows.forEach(row => console.log(row.pg_get_functiondef));
  process.exit(); 
}).catch(e => { console.log(e.message); process.exit(); });
