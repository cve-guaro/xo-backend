const { pool } = require('./src/db/index');
const fs = require('fs');
pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'users'")
  .then(res => {
     fs.writeFileSync('cols.json', JSON.stringify(res.rows.map(r => r.column_name), null, 2));
     pool.end();
  });
