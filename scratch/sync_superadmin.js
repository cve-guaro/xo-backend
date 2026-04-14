
const { Pool } = require('pg');
require('dotenv').config();

async function syncSuperAdmin() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  const SIMON_ID = '608bc5a4-8417-47b2-ad8b-56bdae2713cf';
  const SIMONA_ID = '1dd2ac0e-7633-4e4f-8300-ae129b7fb3f4';

  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    
    console.log(`Setting Simon (${SIMON_ID}) to superadmin...`);
    await client.query('UPDATE users SET role = $1 WHERE id = $2', ['superadmin', SIMON_ID]);

    console.log(`Deleting SimonA (${SIMONA_ID})...`);
    // Delete from related tables first just in case there are missing cascades (though dump.sql mentioned cascades)
    await client.query('DELETE FROM wallets WHERE user_id = $1', [SIMONA_ID]);
    await client.query('DELETE FROM users WHERE id = $1', [SIMONA_ID]);

    await client.query('COMMIT');
    console.log('SUCCESS: SuperAdmin synchronization complete.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('ERROR during sync:', err);
  } finally {
    client.release();
    await pool.end();
  }
}

syncSuperAdmin();
