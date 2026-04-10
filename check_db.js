const { pool } = require('./src/db/index');
(async () => {
  try {
    const res = await pool.query("SELECT key, value FROM global_settings");
    console.log("DB Content:", res.rows);
  } catch (e) {
    console.error(e);
  } finally {
    process.exit(0);
  }
})();
