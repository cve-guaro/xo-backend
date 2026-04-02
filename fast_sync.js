const { pool } = require('./src/db/index');
async function run() {
  try {
    const res = await pool.query(`
      UPDATE users 
      SET 
        r1_10_wins = (SELECT COUNT(*) FROM games WHERE winner = users.id AND bet_amount IN ('1000', 1000)),
        r1_25_wins = (SELECT COUNT(*) FROM games WHERE winner = users.id AND bet_amount IN ('2500', 2500)),
        r1_50_wins = (SELECT COUNT(*) FROM games WHERE winner = users.id AND bet_amount IN ('5000', 5000)),
        r1_99_wins = (SELECT COUNT(*) FROM games WHERE winner = users.id AND bet_amount IN ('9900', 9900))
    `);
    console.log('Batch updated successfully:', res.rowCount, 'users');
  } catch(e) { console.error(e); }
  pool.end();
}
run();
