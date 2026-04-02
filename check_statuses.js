const {pool} = require('./src/db/index');
pool.query("SELECT DISTINCT status, (winner IS NULL) as no_winner, COUNT(*) as cnt FROM games GROUP BY status, (winner IS NULL) ORDER BY cnt DESC")
.then(res => { 
  console.log(JSON.stringify(res.rows, null, 2));
  pool.end(); 
}).catch(e => { console.error(e); pool.end(); });
