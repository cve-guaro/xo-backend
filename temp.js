const { pool } = require('./src/db');
// Check what distinct statuses exist
pool.query(`SELECT DISTINCT status FROM games ORDER BY status`).then(res => {
  console.log('Existing statuses:', res.rows.map(r => r.status));
}).catch(console.error).finally(() => process.exit());
