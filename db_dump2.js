const { pool } = require('./src/db/index.js');
async function run() {
  try {
    const res = await pool.query(`
      SELECT column_name, column_default, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'wallets';
    `);
    console.table(res.rows);
  } catch(e) { console.error(e); }
  process.exit(0);
}
run();
