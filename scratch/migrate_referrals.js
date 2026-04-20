/**
 * Create referrals table and initialize settings
 */
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function migrate() {
  // Create referrals table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS referrals (
      id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
      referrer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      referred_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      bonus_amount NUMERIC(12,2) DEFAULT 2,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(referred_id)
    )
  `);
  console.log('✅ referrals table created');

  // Add referral_code column to users if not exists
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code VARCHAR(20) UNIQUE
  `).catch(() => {});
  console.log('✅ referral_code column ensured');

  // Generate referral codes for existing users that don't have one
  const { rows } = await pool.query(`SELECT id FROM users WHERE referral_code IS NULL`);
  for (const u of rows) {
    const code = u.id.slice(0, 8).toUpperCase();
    await pool.query(`UPDATE users SET referral_code = $1 WHERE id = $2`, [code, u.id]).catch(() => {});
  }
  console.log(`✅ Generated referral codes for ${rows.length} users`);

  // Initialize referral settings
  const settings = [
    ['referral_enabled', JSON.stringify(true)],
    ['referral_bonus_amount', JSON.stringify(2)]
  ];
  for (const [key, val] of settings) {
    await pool.query(`
      INSERT INTO global_settings (key, value) VALUES ($1, $2::jsonb)
      ON CONFLICT (key) DO NOTHING
    `, [key, val]);
  }
  console.log('✅ Referral settings initialized');
  
  await pool.end();
  console.log('Done!');
}

migrate().catch(e => { console.error(e); process.exit(1); });
