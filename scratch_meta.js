const { pool } = require('./src/db/index');

async function run() {
  try {
    const res = await pool.query(`
      SELECT table_schema, table_name, column_name 
      FROM information_schema.columns 
      WHERE column_name ILIKE '%raw_user_meta_data%'
    `);
    console.log('--- TABLES WITH raw_user_meta_data ---');
    res.rows.forEach(r => {
      console.log(`Schema: ${r.table_schema}, Table: ${r.table_name}, Column: ${r.column_name}`);
    });
  } catch (err) {
    console.error('Error:', err);
  } finally {
    await pool.end();
  }
}

run();
