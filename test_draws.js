const {pool} = require('./src/db/index');
const userId = '9e2e26aa-cadb-4070-a272-d26dc8480e11';
pool.query(`
  SELECT 
    COUNT(*) FILTER (WHERE winner = $1) as wins,
    COUNT(*) FILTER (WHERE winner != $1 AND winner IS NOT NULL) as losses,
    COUNT(*) FILTER (WHERE winner IS NULL AND status NOT IN ('ongoing', 'live')) as draws,
    COUNT(*) as total
  FROM games 
  WHERE (player_x = $1 OR player_o = $1)
`, [userId])
.then(res => { 
  console.log("360 Stats for Bini (correct ID):", res.rows[0]); 
  // Also sample raw data
  return pool.query(`SELECT id, status, winner FROM games WHERE (player_x = $1 OR player_o = $1) LIMIT 20`, [userId]);
}).then(res => {
  console.log("Sample games:", res.rows);
  pool.end(); 
}).catch(e => { console.error(e); pool.end(); });
