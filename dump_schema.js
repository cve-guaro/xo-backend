const { pool } = require('./src/db/index.js');
async function run() {
  try {
    const u = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='users'");
    console.log('USERS:', u.rows.map(r=>r.column_name).join(','));
    const w = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='wallets'");
    console.log('WALLETS:', w.rows.map(r=>r.column_name).join(','));
    process.exit(0);
  } catch(e) {
    console.error(e);
    process.exit(1);
  }
}
run();
