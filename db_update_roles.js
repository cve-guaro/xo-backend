const { pool } = require('./src/db/index.js');
async function run() {
  try {
    // Make Simon superadmin
    await pool.query(`UPDATE users SET role = 'superadmin' WHERE username ILIKE 'Simon'`);
    // Make y12345 admin
    await pool.query(`UPDATE users SET role = 'admin' WHERE username ILIKE 'y12345'`);
    console.log("Roles updated.");
  } catch(e) { console.error(e); }
  process.exit(0);
}
run();
