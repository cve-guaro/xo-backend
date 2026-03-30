-- =============================================================
-- Migration 001: Admin & Bonus Features
-- Safe to run multiple times (idempotent)
-- Does NOT alter existing columns or drop anything.
-- =============================================================

-- 1. Add bonus_balance to wallets (default 0 cents)
ALTER TABLE wallets ADD COLUMN IF NOT EXISTS bonus_balance BIGINT NOT NULL DEFAULT 0;

-- 2. Add room_1_wins counter to users
ALTER TABLE users ADD COLUMN IF NOT EXISTS room_1_wins INTEGER NOT NULL DEFAULT 0;

-- 3. Add role column to users (default 'user')
ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(20) NOT NULL DEFAULT 'user';

-- 4. Add banned flag to users
ALTER TABLE users ADD COLUMN IF NOT EXISTS banned BOOLEAN NOT NULL DEFAULT false;

-- 5. Create global_settings table
CREATE TABLE IF NOT EXISTS global_settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 6. Seed default global settings (idempotent)
INSERT INTO global_settings (key, value)
VALUES ('welcome_bonus_active', 'false'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- 7. Ensure the hardcoded admin phone has role='admin'
--    (no-op if the user doesn't exist yet; runs on next login)
UPDATE users
SET role = 'admin'
WHERE number = '251961111106'
  AND role <> 'admin';

-- Done
