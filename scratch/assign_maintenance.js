/**
 * Assign maintenance role to +251939484533
 */
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function assign() {
  const phone = '+251939484533';
  // Try multiple phone formats
  const phones = [phone, '251939484533', '0939484533'];
  
  for (const p of phones) {
    const { rows } = await pool.query(
      `UPDATE users SET role = 'maintenance' WHERE number = $1 RETURNING id, username, number, role`,
      [p]
    );
    if (rows.length) {
      console.log(`✅ Assigned maintenance role to:`, rows[0]);
      await pool.end();
      return;
    }
  }
  
  console.log(`❌ No user found with phone ${phone}. Available users:`);
  const { rows } = await pool.query(`SELECT id, username, number, role FROM users ORDER BY created_at DESC LIMIT 10`);
  console.table(rows);
  await pool.end();
}

assign().catch(e => { console.error(e); process.exit(1); });
