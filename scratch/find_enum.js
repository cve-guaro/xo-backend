const { pool } = require('../src/db/index');
pool.query("SELECT enum_range(NULL::wallet_tx_type)").then(r => { console.log(r.rows); process.exit(); }).catch(e => { console.log('Error:', e.message); process.exit(); });
