-- =============================================================
-- Migration 002: Admin Enhancements
-- Safe to run multiple times (idempotent)
-- =============================================================

-- 1. Create admin_audit_logs table to record operational actions
CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  action      VARCHAR(100) NOT NULL,
  target_id   VARCHAR(255),
  details     JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. Seed default global settings for the giveaway promotion amount (idempotent)
INSERT INTO global_settings (key, value)
VALUES ('welcome_bonus_amount', '1000'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- Done
