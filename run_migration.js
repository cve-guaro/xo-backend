const { Pool } = require('pg');
require('dotenv').config();
const ssl = process.env.DATABASE_URL?.includes('supabase') ? { rejectUnauthorized: false } : false;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl });

const stmts = [
  `ALTER TABLE wallets ADD COLUMN IF NOT EXISTS bonus_balance BIGINT NOT NULL DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS room_1_wins INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(20) NOT NULL DEFAULT 'user'`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS banned BOOLEAN NOT NULL DEFAULT false`,
  `CREATE TABLE IF NOT EXISTS global_settings (key TEXT PRIMARY KEY, value JSONB NOT NULL DEFAULT '{}'::jsonb, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `INSERT INTO global_settings (key, value) VALUES ('welcome_bonus_active', 'false') ON CONFLICT (key) DO NOTHING`,
  `CREATE TABLE IF NOT EXISTS admin_audit_logs (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), admin_id UUID REFERENCES users(id) ON DELETE SET NULL, action VARCHAR(100) NOT NULL, target_id VARCHAR(255), details JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `INSERT INTO global_settings (key, value) VALUES ('welcome_bonus_amount', '1000'::jsonb) ON CONFLICT (key) DO NOTHING`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS r1_10_wins INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS r1_25_wins INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS r1_50_wins INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS r1_99_wins INTEGER NOT NULL DEFAULT 0`,
];

(async () => {
  for (const s of stmts) {
    try {
      await pool.query(s);
      console.log('OK:', s.slice(0, 60));
    } catch (e) {
      console.error('ERR:', s.slice(0, 60), '->', e.message);
    }
  }
  await pool.end();
  console.log('Migration complete.');
})();
