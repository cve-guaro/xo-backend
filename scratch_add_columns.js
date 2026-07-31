const { Pool } = require('pg');
const pool = new Pool({
  connectionString: 'postgresql://postgres:postgres@localhost:5432/xoet_local'
});

async function run() {
  try {
    console.log('Adding missing columns to users table...');
    await pool.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS room_2_wins INTEGER DEFAULT 0;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS room_3_wins INTEGER DEFAULT 0;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS r2_100_wins INTEGER DEFAULT 0;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS r3_1000_wins INTEGER DEFAULT 0;
    `);
    console.log('✅ Columns added successfully.');
  } catch (err) {
    console.error('❌ Error adding columns:', err.message);
  } finally {
    await pool.end();
  }
}

run();
