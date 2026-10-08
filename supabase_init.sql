-- ============================================================================
-- XO ETHIOPIA (XOET) — COMPLETE SUPABASE DATABASE INITIALIZATION SCRIPT
-- ============================================================================
-- Run this in the Supabase SQL Editor for your new test/staging project.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── 1. ENUMS ────────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE wallet_tx_type AS ENUM (
    'DEPOSIT', 'WITHDRAW_REQUEST', 'WITHDRAW_SETTLED', 'WITHDRAW_REJECTED',
    'STAKE', 'PRIZE', 'BONUS', 'GIFT', 'REFUND', 'ADMIN_EDIT', 'ADMIN_CREDIT',
    'ADMIN_DEBIT', 'ADJUSTMENT'
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE wallet_tx_status AS ENUM ('PENDING', 'PENDING_MANUAL', 'COMPLETED', 'FAILED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ── 2. CORE TABLES ──────────────────────────────────────────────────────────

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  number TEXT UNIQUE,
  username TEXT UNIQUE,
  display_name TEXT,
  avatar TEXT,
  email TEXT,
  role TEXT DEFAULT 'user',
  banned BOOLEAN DEFAULT false,
  verified BOOLEAN DEFAULT false,
  sound_muted BOOLEAN DEFAULT false,
  claimed_giveaway_version INTEGER DEFAULT 0,
  referral_code TEXT,
  referred_by TEXT,
  telegram_id BIGINT,
  telegram_username TEXT,
  is_bot BOOLEAN DEFAULT false,
  room_2_wins INTEGER DEFAULT 0,
  room_3_wins INTEGER DEFAULT 0,
  r1_10_wins INTEGER DEFAULT 0,
  r1_15_wins INTEGER DEFAULT 0,
  r1_25_wins INTEGER DEFAULT 0,
  r1_50_wins INTEGER DEFAULT 0,
  r1_99_wins INTEGER DEFAULT 0,
  r2_100_wins INTEGER DEFAULT 0,
  r3_1000_wins INTEGER DEFAULT 0,
  last_login_ip TEXT,
  last_login_at TIMESTAMPTZ,
  raw_user_meta_data JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_telegram_id ON users(telegram_id) WHERE telegram_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

-- Wallets table
CREATE TABLE IF NOT EXISTS wallets (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  available_balance NUMERIC DEFAULT 0,
  withdrawable_balance NUMERIC DEFAULT 0,
  bonus_balance NUMERIC DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Wallet transactions ledger
CREATE TABLE IF NOT EXISTS wallet_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tx_type wallet_tx_type NOT NULL,
  status wallet_tx_status NOT NULL DEFAULT 'PENDING',
  amount NUMERIC NOT NULL,
  provider TEXT,
  provider_ref TEXT,
  idempotency_key TEXT,
  meta JSONB DEFAULT '{}'::jsonb,
  applied_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_wallet_tx_idem ON wallet_transactions(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_wallet_transactions_user ON wallet_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_wallet_transactions_created_at ON wallet_transactions(created_at);
CREATE INDEX IF NOT EXISTS idx_wallet_tx_status_type ON wallet_transactions(status, tx_type);

-- Games table
CREATE TABLE IF NOT EXISTS games (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_x UUID REFERENCES users(id),
  player_o UUID REFERENCES users(id),
  bet_amount NUMERIC NOT NULL,
  prize_amount NUMERIC DEFAULT 0,
  status TEXT DEFAULT 'countdown',
  winner UUID REFERENCES users(id),
  stake_available_x NUMERIC DEFAULT 0,
  stake_withdrawable_x NUMERIC DEFAULT 0,
  stake_bonus_x NUMERIC DEFAULT 0,
  stake_available_o NUMERIC DEFAULT 0,
  stake_withdrawable_o NUMERIC DEFAULT 0,
  stake_bonus_o NUMERIC DEFAULT 0,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_games_player_x ON games(player_x);
CREATE INDEX IF NOT EXISTS idx_games_player_o ON games(player_o);
CREATE INDEX IF NOT EXISTS idx_games_players ON games(player_x, player_o);
CREATE INDEX IF NOT EXISTS idx_games_winner ON games(winner);
CREATE INDEX IF NOT EXISTS idx_games_status ON games(status);
CREATE INDEX IF NOT EXISTS idx_games_created_at ON games(created_at);

-- Global Settings
CREATE TABLE IF NOT EXISTS global_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- OTPs
CREATE TABLE IF NOT EXISTS otps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  number TEXT NOT NULL,
  otp TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_otps_number ON otps(number);

-- Referrals
CREATE TABLE IF NOT EXISTS referrals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id UUID REFERENCES users(id),
  referred_id UUID REFERENCES users(id),
  bonus_amount NUMERIC DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Withdraw Requests
CREATE TABLE IF NOT EXISTS withdraw_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount NUMERIC NOT NULL,
  status TEXT DEFAULT 'pending',
  bank_name TEXT,
  account_number TEXT,
  account_name TEXT,
  reason TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_withdraw_requests_user ON withdraw_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_withdraw_requests_status ON withdraw_requests(status);

-- System Alerts (Security)
CREATE TABLE IF NOT EXISTS system_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL,
  details JSONB DEFAULT '{}'::jsonb,
  severity TEXT DEFAULT 'INFO',
  ip_address TEXT,
  resolved BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Bulk SMS History
CREATE TABLE IF NOT EXISTS bulk_sms_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id UUID REFERENCES users(id),
  message TEXT NOT NULL,
  filters JSONB DEFAULT '{}'::jsonb,
  target_count INTEGER DEFAULT 0,
  success_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Leaderboard Snapshots
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
  created_at TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT uq_leaderboard_week_rank UNIQUE (week_start, rank)
);

-- Fake Ticker Entries
CREATE TABLE IF NOT EXISTS fake_ticker_entries (
  id SERIAL PRIMARY KEY,
  username TEXT NOT NULL,
  amount INT NOT NULL,
  active BOOLEAN DEFAULT true
);

-- User Entries (Analytics)
CREATE TABLE IF NOT EXISTS user_entries (
  id SERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_entries_created ON user_entries(created_at);

-- Promo Popups
CREATE TABLE IF NOT EXISTS promo_popups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  image_url TEXT,
  display_duration INTEGER DEFAULT 5,
  expires_at TIMESTAMPTZ,
  starts_at TIMESTAMPTZ,
  is_active BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Promocodes & Claims
CREATE TABLE IF NOT EXISTS promocodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT UNIQUE NOT NULL,
  reward_amount NUMERIC NOT NULL,
  max_uses INT DEFAULT 1,
  current_uses INT DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS promocode_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  promo_id UUID REFERENCES promocodes(id),
  user_id UUID REFERENCES users(id),
  claimed_at TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT uq_promocode_claim UNIQUE (promo_id, user_id)
);

-- Notifications
CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  is_read BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);

-- Admin Audit Logs
CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id UUID REFERENCES users(id),
  action TEXT NOT NULL,
  details JSONB DEFAULT '{}'::jsonb,
  ip_address TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ── 3. STORED FUNCTIONS ─────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_wallet_ensure(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  INSERT INTO wallets (user_id, available_balance, withdrawable_balance, bonus_balance)
  VALUES (p_user_id, 0, 0, 0)
  ON CONFLICT (user_id) DO NOTHING;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_wallet_apply_tx(
  p_user_id uuid,
  p_tx_type wallet_tx_type,
  p_amount numeric,
  p_status wallet_tx_status,
  p_idempotency_key text DEFAULT NULL::text,
  p_provider text DEFAULT NULL::text,
  p_provider_ref text DEFAULT NULL::text,
  p_meta jsonb DEFAULT '{}'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_tx_id uuid;
  v_wallet wallets%ROWTYPE;
  v_amount numeric := p_amount;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_tx_id FROM wallet_transactions 
    WHERE idempotency_key = p_idempotency_key AND status != 'FAILED' LIMIT 1;
    IF FOUND THEN RETURN v_tx_id; END IF;
  END IF;

  INSERT INTO wallet_transactions (user_id, tx_type, status, amount, meta, idempotency_key, provider, provider_ref)
  VALUES (p_user_id, p_tx_type, p_status, v_amount, p_meta, p_idempotency_key, p_provider, p_provider_ref)
  RETURNING id INTO v_tx_id;

  IF p_status != 'COMPLETED' THEN RETURN v_tx_id; END IF;

  SELECT * INTO v_wallet FROM wallets WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO wallets (user_id, available_balance, withdrawable_balance, bonus_balance)
    VALUES (p_user_id, 0, 0, 0)
    RETURNING * INTO v_wallet;
  END IF;

  IF p_tx_type = 'PRIZE' THEN
    UPDATE wallets
    SET available_balance = available_balance + v_amount,
        withdrawable_balance = withdrawable_balance + v_amount,
        updated_at = now()
    WHERE user_id = p_user_id;
  ELSIF p_tx_type = 'DEPOSIT' THEN
    UPDATE wallets
    SET available_balance = available_balance + v_amount,
        updated_at = now()
    WHERE user_id = p_user_id;
  ELSIF p_tx_type IN ('GIFT', 'BONUS', 'ADMIN_EDIT', 'ADMIN_CREDIT') THEN
    UPDATE wallets
    SET available_balance = available_balance + v_amount,
        bonus_balance = CASE WHEN p_tx_type = 'BONUS' THEN bonus_balance + v_amount ELSE bonus_balance END,
        updated_at = now()
    WHERE user_id = p_user_id;
  ELSIF p_tx_type = 'WITHDRAW_REQUEST' OR p_tx_type = 'ADMIN_DEBIT' THEN
    IF v_wallet.available_balance < v_amount THEN RAISE EXCEPTION 'Insufficient balance'; END IF;
    UPDATE wallets
    SET available_balance = available_balance - v_amount,
        withdrawable_balance = GREATEST(withdrawable_balance - v_amount, 0),
        updated_at = now()
    WHERE user_id = p_user_id;
  ELSIF p_tx_type = 'WITHDRAW_REJECTED' OR p_tx_type = 'REFUND' THEN
    UPDATE wallets
    SET available_balance = available_balance + v_amount,
        withdrawable_balance = withdrawable_balance + v_amount,
        updated_at = now()
    WHERE user_id = p_user_id;
  ELSIF p_tx_type = 'WITHDRAW_SETTLED' THEN
    NULL; 
  ELSE
    RAISE EXCEPTION 'Unhandled tx_type %', p_tx_type;
  END IF;

  RETURN v_tx_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_wallet_apply_existing_tx(p_tx_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_tx RECORD;
  v_wallet RECORD;
BEGIN
  SELECT * INTO v_tx FROM wallet_transactions WHERE id = p_tx_id FOR UPDATE;
  IF v_tx.id IS NULL THEN RAISE EXCEPTION 'tx not found'; END IF;
  IF v_tx.applied_at IS NOT NULL THEN RETURN v_tx.id; END IF;
  IF v_tx.status <> 'COMPLETED' THEN RAISE EXCEPTION 'tx not completed'; END IF;

  PERFORM fn_wallet_ensure(v_tx.user_id);
  SELECT * INTO v_wallet FROM wallets WHERE user_id = v_tx.user_id FOR UPDATE;

  IF v_tx.tx_type = 'PRIZE' THEN
    UPDATE wallets
    SET available_balance = available_balance + v_tx.amount,
        withdrawable_balance = withdrawable_balance + v_tx.amount,
        updated_at = now()
    WHERE user_id = v_tx.user_id;
  ELSIF v_tx.tx_type = 'DEPOSIT' THEN
    UPDATE wallets
    SET available_balance = available_balance + v_tx.amount,
        updated_at = now()
    WHERE user_id = v_tx.user_id;
  ELSIF v_tx.tx_type IN ('REFUND','ADJUSTMENT', 'GIFT', 'BONUS', 'ADMIN_EDIT', 'ADMIN_CREDIT') THEN
    UPDATE wallets
    SET available_balance = available_balance + v_tx.amount,
        bonus_balance = CASE WHEN v_tx.tx_type = 'BONUS' THEN COALESCE(bonus_balance, 0) + v_tx.amount ELSE bonus_balance END,
        withdrawable_balance = CASE WHEN v_tx.tx_type = 'REFUND' THEN withdrawable_balance + v_tx.amount ELSE withdrawable_balance END,
        updated_at = now()
    WHERE user_id = v_tx.user_id;
  ELSIF v_tx.tx_type = 'WITHDRAW_REJECTED' THEN
    UPDATE wallets
    SET available_balance = available_balance + v_tx.amount,
        withdrawable_balance = withdrawable_balance + v_tx.amount,
        updated_at = now()
    WHERE user_id = v_tx.user_id;
  ELSIF v_tx.tx_type IN ('WITHDRAW_SETTLED', 'WITHDRAW_REQUEST', 'ADMIN_DEBIT') THEN
    NULL;
  ELSE
    RAISE EXCEPTION 'Unhandled tx_type %', v_tx.tx_type;
  END IF;

  UPDATE wallet_transactions SET applied_at = now() WHERE id = v_tx.id;
  RETURN v_tx.id;
END;
$$;

-- ── 4. DEFAULT SYSTEM CONFIG ────────────────────────────────────────────────
INSERT INTO global_settings (key, value) VALUES 
  ('current_giveaway_version', '1'::jsonb),
  ('welcome_bonus_amount', '10'::jsonb),
  ('welcome_bonus_active', 'true'::jsonb),
  ('leaderboard_auto_approve', 'false'::jsonb),
  ('fake_ticker_enabled', 'false'::jsonb),
  ('spin_5p_entry_amount', '100'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- Done!
