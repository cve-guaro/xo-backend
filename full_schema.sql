-- ============================================================================
-- XO ETHIOPIA — FULL SCHEMA REBUILD (from backend route code references)
-- Idempotent: safe to run multiple times. Uses IF NOT EXISTS / ADD COLUMN IF NOT EXISTS.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── ENUMS ───────────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE wallet_tx_type AS ENUM (
    'DEPOSIT', 'WITHDRAW_REQUEST', 'WITHDRAW_SETTLED', 'WITHDRAW_REJECTED',
    'STAKE', 'PRIZE', 'BONUS', 'GIFT', 'REFUND', 'ADMIN_EDIT', 'ADMIN_CREDIT',
    'ADMIN_DEBIT', 'ADJUSTMENT', 'miniapp_credit', 'miniapp_debit'
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE wallet_tx_status AS ENUM ('PENDING', 'PENDING_MANUAL', 'COMPLETED', 'FAILED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ── 1. USERS ────────────────────────────────────────────────────────────────
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
  room_1_wins INTEGER DEFAULT 0,
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
  new_user BOOLEAN DEFAULT true,
  updated_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_telegram_id ON users(telegram_id) WHERE telegram_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_number ON users(number);

-- Add missing columns to existing users table (idempotent)
ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();
ALTER TABLE users ADD COLUMN IF NOT EXISTS room_1_wins INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_id BIGINT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_username TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_bot BOOLEAN DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS raw_user_meta_data JSONB DEFAULT '{}'::jsonb;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_ip TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS sound_muted BOOLEAN DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS banned BOOLEAN DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS new_user BOOLEAN DEFAULT true;
ALTER TABLE users ADD COLUMN IF NOT EXISTS claimed_giveaway_version INTEGER DEFAULT 0;

-- ── 2. WALLETS ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wallets (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  available_balance NUMERIC DEFAULT 0,
  withdrawable_balance NUMERIC DEFAULT 0,
  bonus_balance NUMERIC DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE wallets ADD COLUMN IF NOT EXISTS available_balance NUMERIC DEFAULT 0;
ALTER TABLE wallets ADD COLUMN IF NOT EXISTS withdrawable_balance NUMERIC DEFAULT 0;
ALTER TABLE wallets ADD COLUMN IF NOT EXISTS bonus_balance NUMERIC DEFAULT 0;
ALTER TABLE wallets ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

-- ── 3. WALLET TRANSACTIONS ──────────────────────────────────────────────────
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

ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS tx_type wallet_tx_type NOT NULL DEFAULT 'DEPOSIT';
ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS status wallet_tx_status NOT NULL DEFAULT 'PENDING';
ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS amount NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS provider TEXT;
ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS provider_ref TEXT;
ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS meta JSONB DEFAULT '{}'::jsonb;
ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS applied_at TIMESTAMPTZ;
ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();
ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

-- ── 4. GAMES ────────────────────────────────────────────────────────────────
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
  created_at TIMESTAMPTZ DEFAULT now(),
  moves JSONB DEFAULT '[]'::jsonb,
  bonus_used_x NUMERIC DEFAULT 0,
  bonus_used_o NUMERIC DEFAULT 0,
  withdrawable_used_x NUMERIC DEFAULT 0,
  withdrawable_used_o NUMERIC DEFAULT 0,
  locked_used_x NUMERIC DEFAULT 0,
  locked_used_o NUMERIC DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_games_player_x ON games(player_x);
CREATE INDEX IF NOT EXISTS idx_games_player_o ON games(player_o);
CREATE INDEX IF NOT EXISTS idx_games_players ON games(player_x, player_o);
CREATE INDEX IF NOT EXISTS idx_games_winner ON games(winner);
CREATE INDEX IF NOT EXISTS idx_games_status ON games(status);
CREATE INDEX IF NOT EXISTS idx_games_created_at ON games(created_at);

ALTER TABLE games ADD COLUMN IF NOT EXISTS moves JSONB DEFAULT '[]'::jsonb;
ALTER TABLE games ADD COLUMN IF NOT EXISTS bonus_used_x NUMERIC DEFAULT 0;
ALTER TABLE games ADD COLUMN IF NOT EXISTS bonus_used_o NUMERIC DEFAULT 0;
ALTER TABLE games ADD COLUMN IF NOT EXISTS withdrawable_used_x NUMERIC DEFAULT 0;
ALTER TABLE games ADD COLUMN IF NOT EXISTS withdrawable_used_o NUMERIC DEFAULT 0;
ALTER TABLE games ADD COLUMN IF NOT EXISTS locked_used_x NUMERIC DEFAULT 0;
ALTER TABLE games ADD COLUMN IF NOT EXISTS locked_used_o NUMERIC DEFAULT 0;
ALTER TABLE games ADD COLUMN IF NOT EXISTS prize_amount NUMERIC DEFAULT 0;

-- ── 5. GLOBAL SETTINGS ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS global_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

INSERT INTO global_settings (key, value) VALUES
  ('current_giveaway_version', '1'::jsonb),
  ('welcome_bonus_amount', '10'::jsonb),
  ('welcome_bonus_active', 'true'::jsonb),
  ('leaderboard_auto_approve', 'false'::jsonb),
  ('fake_ticker_enabled', 'false'::jsonb),
  ('spin_5p_entry_amount', '100'::jsonb),
  ('referral_enabled', 'true'::jsonb),
  ('rooms_locked', 'false'::jsonb),
  ('is_manual_approval_enabled', 'false'::jsonb),
  ('auto_payout_threshold', '2000'::jsonb),
  ('min_withdraw_amount', '10'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ── 6. OTPS ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS otps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  number TEXT NOT NULL,
  code TEXT NOT NULL,
  used BOOLEAN DEFAULT false,
  tried INTEGER DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_otps_number ON otps(number);

ALTER TABLE otps ADD COLUMN IF NOT EXISTS used BOOLEAN DEFAULT false;
ALTER TABLE otps ADD COLUMN IF NOT EXISTS tried INTEGER DEFAULT 0;

-- ── 7. REFERRALS ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS referrals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id UUID REFERENCES users(id),
  referred_id UUID REFERENCES users(id),
  bonus_amount NUMERIC DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ── 8. WITHDRAW REQUESTS ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS withdraw_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount NUMERIC NOT NULL,
  status TEXT DEFAULT 'pending',
  bank_name TEXT,
  account_number TEXT,
  account_name TEXT,
  reason TEXT,
  payout_method TEXT,
  payout_destination TEXT,
  reserve_tx_id UUID,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_withdraw_requests_user ON withdraw_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_withdraw_requests_status ON withdraw_requests(status);

ALTER TABLE withdraw_requests ADD COLUMN IF NOT EXISTS payout_method TEXT;
ALTER TABLE withdraw_requests ADD COLUMN IF NOT EXISTS payout_destination TEXT;
ALTER TABLE withdraw_requests ADD COLUMN IF NOT EXISTS reserve_tx_id UUID;

-- ── 9. SYSTEM ALERTS ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS system_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL,
  details JSONB DEFAULT '{}'::jsonb,
  severity TEXT DEFAULT 'INFO',
  ip_address TEXT,
  resolved BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ── 10. BULK SMS HISTORY ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bulk_sms_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id UUID REFERENCES users(id),
  message TEXT NOT NULL,
  filters JSONB DEFAULT '{}'::jsonb,
  target_count INTEGER DEFAULT 0,
  success_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ── 11. LEADERBOARD SNAPSHOTS ───────────────────────────────────────────────
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

-- ── 12. FAKE TICKER ENTRIES ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fake_ticker_entries (
  id SERIAL PRIMARY KEY,
  username TEXT NOT NULL,
  amount INT NOT NULL,
  active BOOLEAN DEFAULT true
);

-- ── 13. USER ENTRIES ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_entries (
  id SERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_entries_created ON user_entries(created_at);

-- ── 14. PROMO POPUPS ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS promo_popups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  image_url TEXT,
  display_duration INTEGER DEFAULT 5,
  expires_at TIMESTAMPTZ,
  starts_at TIMESTAMPTZ,
  is_active BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE promo_popups ADD COLUMN IF NOT EXISTS starts_at TIMESTAMPTZ;

-- ── 15. PROMOCODES ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS promocodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT UNIQUE NOT NULL,
  reward_amount NUMERIC NOT NULL DEFAULT 0,
  amount NUMERIC NOT NULL DEFAULT 0,
  description TEXT,
  title TEXT,
  target_type TEXT DEFAULT 'ALL',
  usage_limit INT,
  usage_count INT DEFAULT 0,
  status TEXT DEFAULT 'ACTIVE',
  starts_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  max_uses INT DEFAULT 1,
  current_uses INT DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE promocodes ADD COLUMN IF NOT EXISTS amount NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE promocodes ADD COLUMN IF NOT EXISTS title TEXT;
ALTER TABLE promocodes ADD COLUMN IF NOT EXISTS usage_limit INT;
ALTER TABLE promocodes ADD COLUMN IF NOT EXISTS usage_count INT DEFAULT 0;
ALTER TABLE promocodes ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'ACTIVE';
ALTER TABLE promocodes ADD COLUMN IF NOT EXISTS starts_at TIMESTAMPTZ;
ALTER TABLE promocodes ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

-- ── 16. PROMOCODE CLAIMS ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS promocode_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  promocode_id UUID REFERENCES promocodes(id),
  promo_id UUID REFERENCES promocodes(id),
  user_id UUID REFERENCES users(id),
  claimed_at TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT uq_promocode_claim UNIQUE (promocode_id, user_id)
);

-- ── 17. PROMOTION LINKS ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS promotion_links (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  bonus_amount NUMERIC DEFAULT 0,
  code TEXT UNIQUE,
  is_active BOOLEAN DEFAULT true,
  total_claims INT DEFAULT 0,
  total_registrations INT DEFAULT 0,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── 18. PROMOTION CLAIMS ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS promotion_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  promotion_link_id UUID REFERENCES promotion_links(id),
  user_id UUID REFERENCES users(id),
  claimed_at TIMESTAMPTZ DEFAULT now()
);

-- ── 19. NOTIFICATIONS ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'system',
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  read BOOLEAN DEFAULT false,
  is_read BOOLEAN DEFAULT false,
  meta JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON notifications(user_id, read) WHERE read = false;

ALTER TABLE notifications ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'system';
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS read BOOLEAN DEFAULT false;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS meta JSONB;
UPDATE notifications SET read = is_read WHERE read IS NULL AND is_read IS NOT NULL;

-- ── 20. ADMIN AUDIT LOGS ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id UUID REFERENCES users(id),
  action TEXT NOT NULL,
  target_id TEXT,
  details JSONB DEFAULT '{}'::jsonb,
  ip_address TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE admin_audit_logs ADD COLUMN IF NOT EXISTS target_id TEXT;

-- ── 21. BONUS AUDIT LOGS ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bonus_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action TEXT NOT NULL,
  amount NUMERIC DEFAULT 0,
  admin_user TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ── 22. BONUS LOGS ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bonus_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  amount NUMERIC NOT NULL,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── 23. USER FRIENDS ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_friends (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  friend_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source VARCHAR(32) DEFAULT 'manual',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT uq_user_friend UNIQUE (user_id, friend_id),
  CONSTRAINT ck_friend_not_self CHECK (user_id != friend_id)
);

CREATE INDEX IF NOT EXISTS idx_user_friends_user ON user_friends(user_id);
CREATE INDEX IF NOT EXISTS idx_user_friends_friend ON user_friends(friend_id);

-- ── 24. SPIN ROOM CONFIGS ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS spin_room_configs (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  bet_amount NUMERIC NOT NULL,
  max_players INT DEFAULT 5,
  house_cut_percent NUMERIC DEFAULT 10,
  is_active BOOLEAN DEFAULT true
);

-- ── 25. SPIN ROUNDS ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS spin_rounds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  config_id INT REFERENCES spin_room_configs(id),
  status TEXT DEFAULT 'waiting',
  players JSONB DEFAULT '[]',
  winning_slice INT,
  winner_user_id UUID,
  pot_amount NUMERIC DEFAULT 0,
  prize_amount NUMERIC DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  locked_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_spin_rounds_config ON spin_rounds(config_id);
CREATE INDEX IF NOT EXISTS idx_spin_rounds_status ON spin_rounds(status);

-- ── 26. SPIN BETS ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS spin_bets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id UUID REFERENCES spin_rounds(id),
  user_id UUID NOT NULL,
  amount NUMERIC NOT NULL,
  is_bot BOOLEAN DEFAULT false,
  seat_index INT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_spin_bets_round ON spin_bets(round_id);
CREATE INDEX IF NOT EXISTS idx_spin_bets_user ON spin_bets(user_id);

-- ── 27. MINI APPS ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mini_apps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  api_key TEXT NOT NULL UNIQUE,
  api_secret_hash TEXT NOT NULL,
  permissions TEXT[] DEFAULT '{}',
  rate_limit INT DEFAULT 100,
  is_active BOOLEAN DEFAULT true,
  webhook_url TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE mini_apps ADD COLUMN IF NOT EXISTS icon_url TEXT;
ALTER TABLE mini_apps ADD COLUMN IF NOT EXISTS category TEXT DEFAULT 'general';
ALTER TABLE mini_apps ADD COLUMN IF NOT EXISTS ip_whitelist TEXT[] DEFAULT '{}';
ALTER TABLE mini_apps ADD COLUMN IF NOT EXISTS is_locked BOOLEAN DEFAULT false;

-- ── 28. MINI APP API LOGS ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mini_app_api_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mini_app_id UUID REFERENCES mini_apps(id),
  endpoint TEXT NOT NULL,
  method TEXT NOT NULL,
  target_user_id UUID,
  request_body JSONB,
  response_status INT,
  ip_address TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_miniapp_logs_app ON mini_app_api_logs(mini_app_id);
CREATE INDEX IF NOT EXISTS idx_miniapp_logs_time ON mini_app_api_logs(created_at);

-- ── 29. MINI APP USER DATA ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mini_app_user_data (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mini_app_id UUID REFERENCES mini_apps(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  data_key TEXT NOT NULL,
  data_value JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(mini_app_id, user_id, data_key)
);

-- ── 30. GIVEAWAYS ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS giveaways (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  promo_code TEXT UNIQUE NOT NULL,
  amount NUMERIC NOT NULL DEFAULT 0,
  title TEXT,
  type TEXT DEFAULT 'PROMOCODE',
  status TEXT DEFAULT 'ACTIVE',
  metadata JSONB DEFAULT '{}'::jsonb,
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── 31. GIVEAWAY CLAIMS ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS giveaway_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  giveaway_id UUID REFERENCES giveaways(id),
  user_id UUID REFERENCES users(id),
  amount NUMERIC NOT NULL DEFAULT 0,
  claimed_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── 32. RPS GAMES ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rps_games (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id TEXT,
  stake_amount NUMERIC DEFAULT 0,
  pot_amount NUMERIC DEFAULT 0,
  fee_amount NUMERIC DEFAULT 0,
  prize_amount NUMERIC DEFAULT 0,
  winner_id UUID REFERENCES users(id),
  score_p1 INT DEFAULT 0,
  score_p2 INT DEFAULT 0,
  rounds_data JSONB,
  status TEXT DEFAULT 'pending',
  best_of INT DEFAULT 3,
  player_1 UUID REFERENCES users(id),
  player_2 UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  finished_at TIMESTAMPTZ
);

-- ── 33. PAYMENT TRANSACTIONS (legacy) ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS payment_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'deposit',
  status TEXT NOT NULL DEFAULT 'success',
  amount NUMERIC NOT NULL DEFAULT 0,
  bank TEXT DEFAULT 'WIN',
  tx_ref TEXT UNIQUE,
  provider_ref TEXT,
  provider_payload JSONB,
  provider_response JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payment_transactions_user ON payment_transactions(user_id);

-- ── WALLET FUNCTIONS ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_wallet_ensure(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
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

  PERFORM fn_wallet_ensure(p_user_id);
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
  ELSIF p_tx_type IN ('miniapp_credit', 'miniapp_debit') THEN
    IF p_tx_type = 'miniapp_credit' THEN
      UPDATE wallets SET available_balance = available_balance + v_amount, updated_at = now() WHERE user_id = p_user_id;
    ELSE
      IF v_wallet.available_balance < v_amount THEN RAISE EXCEPTION 'Insufficient balance'; END IF;
      UPDATE wallets SET available_balance = available_balance - v_amount, updated_at = now() WHERE user_id = p_user_id;
    END IF;
  ELSE
    RAISE EXCEPTION 'Unhandled tx_type %', p_tx_type;
  END IF;

  RETURN v_tx_id;
END;
$$;

-- ── DEFAULT ADMIN SEED ──────────────────────────────────────────────────────
DO $$
DECLARE
  v_uid UUID;
BEGIN
  -- 0939484533 admin
  INSERT INTO users (number, username, display_name, role, new_user)
  VALUES ('0939484533', 'admin_9484533', 'Admin 0939484533', 'superadmin', false)
  ON CONFLICT (number) DO UPDATE
  SET role = 'superadmin', new_user = false
  RETURNING id INTO v_uid;

  IF v_uid IS NOT NULL THEN
    INSERT INTO wallets (user_id, available_balance, withdrawable_balance, bonus_balance)
    VALUES (v_uid, 10000, 10000, 0)
    ON CONFLICT (user_id) DO UPDATE
    SET available_balance = GREATEST(wallets.available_balance, 10000),
        withdrawable_balance = GREATEST(wallets.withdrawable_balance, 10000);
  END IF;

  -- 251939484533 admin
  INSERT INTO users (number, username, display_name, role, new_user)
  VALUES ('251939484533', 'admin_251939484533', 'Admin 0939484533', 'superadmin', false)
  ON CONFLICT (number) DO UPDATE
  SET role = 'superadmin', new_user = false
  RETURNING id INTO v_uid;

  IF v_uid IS NOT NULL THEN
    INSERT INTO wallets (user_id, available_balance, withdrawable_balance, bonus_balance)
    VALUES (v_uid, 10000, 10000, 0)
    ON CONFLICT (user_id) DO UPDATE
    SET available_balance = GREATEST(wallets.available_balance, 10000),
        withdrawable_balance = GREATEST(wallets.withdrawable_balance, 10000);
  END IF;
END $$;

-- ── SEED FAKE TICKER ENTRIES ────────────────────────────────────────────────
DO $$
DECLARE
  cnt INT;
BEGIN
  SELECT COUNT(*) INTO cnt FROM fake_ticker_entries;
  IF cnt = 0 THEN
    INSERT INTO fake_ticker_entries (username, amount, active) VALUES
      ('Bekele_Pro', 100, true),
      ('Aster_X', 50, true),
      ('Dawit_XO', 150, true),
      ('Almaz_ET', 200, true),
      ('Genet_Top', 80, true),
      ('Yohannes_Champ', 250, true),
      ('Tigist_Play', 36, true),
      ('Abebe_Hero', 120, true),
      ('Helen_ET', 45, true),
      ('Solomon_Winner', 180, true),
      ('Bereket_XO', 90, true),
      ('Natnael_Pro', 15, true),
      ('Genet_X', 60, true),
      ('Tariku_Champ', 300, true),
      ('Mesfin_Hero', 75, true);
  END IF;
END $$;

-- ── SEED SPIN ROOM CONFIGS ──────────────────────────────────────────────────
DO $$
BEGIN
  INSERT INTO spin_room_configs (id, name, bet_amount, max_players, house_cut_percent, is_active)
  VALUES (1, '5_PLAYER', 100, 5, 20, true),
         (2, 'RAIL', 0, 9999, 20, true)
  ON CONFLICT (id) DO UPDATE SET house_cut_percent = 20;
END $$;

SELECT 'Schema rebuild complete' AS status;
