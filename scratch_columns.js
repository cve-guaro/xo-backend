const { pool } = require('./src/db/index');

async function run() {
  try {
    const res = await pool.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'users'
    `);
    console.log('--- USER TABLE COLUMNS ---');
    res.rows.forEach(r => {
      console.log(`Column: ${r.column_name}, Type: ${r.data_type}`);
    });
  } catch (err) {
    console.error('Error fetching columns:', err);
  } finally {
    await pool.end();
  }
}

run();
