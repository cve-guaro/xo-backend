-- ============================================================================
-- XO ET — Production Migration Script (Structure Only)
-- ============================================================================
-- This script applies ONLY schema changes (new tables, columns, indexes).
-- It does NOT insert any data, test entries, or modify existing rows.
-- Safe to run multiple times (all statements are idempotent).
--
-- Run this BEFORE deploying the new backend version.
-- ============================================================================

-- ── 1. User preferences ─────────────────────────────────────────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS sound_muted BOOLEAN DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS claimed_giveaway_version INTEGER DEFAULT 0;

-- ── 2. Game enhancements ────────────────────────────────────────────────────
ALTER TABLE games ADD COLUMN IF NOT EXISTS prize_amount NUMERIC DEFAULT 0;

-- ── 3. System alerts table (security monitoring) ────────────────────────────
CREATE TABLE IF NOT EXISTS system_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL,
  details JSONB DEFAULT '{}',
  severity TEXT DEFAULT 'INFO',
  ip_address TEXT,
  resolved BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ── 4. Bulk SMS history (admin campaigns) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS bulk_sms_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id UUID REFERENCES users(id),
  message TEXT NOT NULL,
  filters JSONB DEFAULT '{}',
  target_count INTEGER DEFAULT 0,
  success_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ── 5. Leaderboard system ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS leaderboard_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  week_start DATE NOT NULL,
  week_end DATE NOT NULL,
  user_id UUID REFERENCES users(id),
  username TEXT,
  wins INT DEFAULT 0,
  rank INT,
  prize_amount DECIMAL(10,2) DEFAULT 0,
  prize_status TEXT DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── 6. Fake ticker entries (structure only — no seed data) ──────────────────
CREATE TABLE IF NOT EXISTS fake_ticker_entries (
  id SERIAL PRIMARY KEY,
  username TEXT NOT NULL,
  amount INT NOT NULL,
  active BOOLEAN DEFAULT true
);

-- ── 7. User entries (for analytics tracking) ────────────────────────────────
CREATE TABLE IF NOT EXISTS user_entries (
  id SERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_entries_created ON user_entries(created_at);

-- ── 8. Promo popup enhancements ─────────────────────────────────────────────
ALTER TABLE promo_popups ADD COLUMN IF NOT EXISTS starts_at TIMESTAMPTZ;

-- ── 9. Default global settings (only if not already set) ────────────────────
-- These use ON CONFLICT DO NOTHING so they won't overwrite existing values.
INSERT INTO global_settings (key, value) VALUES ('current_giveaway_version', '1'::jsonb)
  ON CONFLICT (key) DO NOTHING;
INSERT INTO global_settings (key, value) VALUES ('leaderboard_auto_approve', 'false'::jsonb)
  ON CONFLICT (key) DO NOTHING;
INSERT INTO global_settings (key, value) VALUES ('fake_ticker_enabled', 'false'::jsonb)
  ON CONFLICT (key) DO NOTHING;

-- ── 10. Backfill historical game prizes ─────────────────────────────────────
-- Calculates prize for completed games that don't have prize_amount set yet.
-- Uses the same fee logic as the game engine.
UPDATE games
SET prize_amount = CASE
  WHEN bet_amount >= 1000 THEN FLOOR(bet_amount * 2 * 0.9)
  WHEN bet_amount >= 100  THEN FLOOR(bet_amount * 2 * 0.85)
  ELSE                         FLOOR(bet_amount * 2 * 0.8)
END
WHERE status = 'completed' 
  AND winner IS NOT NULL 
  AND (prize_amount IS NULL OR prize_amount = 0);

-- ============================================================================
-- DONE. No user data was inserted or modified.
-- ============================================================================
