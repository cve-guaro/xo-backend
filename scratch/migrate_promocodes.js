
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const SQL_MIGRATION = `
-- 1. Create promocodes table
CREATE TABLE IF NOT EXISTS promocodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT UNIQUE NOT NULL,
  amount NUMERIC NOT NULL,
  description TEXT,
  target_type TEXT NOT NULL DEFAULT 'ALL', -- 'ALL', 'NEW', 'SPECIFIC'
  usage_limit INTEGER, -- NULL means unlimited
  used_count INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 2. Create promocode_usages junction table (to prevent double redemption)
CREATE TABLE IF NOT EXISTS promocode_usages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  promocode_id UUID REFERENCES promocodes(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  used_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(promocode_id, user_id)
);

-- 3. Add any missing columns to users if needed for targeting
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login TIMESTAMPTZ;
`;

async function migrate() {
  try {
    await pool.query(SQL_MIGRATION);
    console.log('SUCCESS: promocodes and promocode_usages tables created.');
  } catch (err) {
    console.error('ERROR during migration:', err);
  } finally {
    await pool.end();
  }
}

migrate();
