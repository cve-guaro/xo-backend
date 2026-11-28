-- migration_009_rps_schema.sql
-- Rock Paper Scissors game schema (DRAFT — DO NOT APPLY without owner approval)
--
-- This migration creates the rps_games table and associated indexes.
-- It is a standalone table that does NOT modify the existing games, wallets,
-- or wallet_transactions tables.
--
-- Rollback: DROP TABLE IF EXISTS public.rps_games CASCADE;

BEGIN;

CREATE TABLE IF NOT EXISTS public.rps_games (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id VARCHAR(64) UNIQUE NOT NULL,

    -- Players
    player_1 UUID NOT NULL REFERENCES public.users(id),
    player_2 UUID REFERENCES public.users(id),

    -- Financial (all INTEGER — no floats, per platform rules)
    stake_amount INTEGER NOT NULL CHECK (stake_amount >= 10),
    pot_amount INTEGER NOT NULL DEFAULT 0,
    fee_amount INTEGER NOT NULL DEFAULT 0,
    fee_percent INTEGER NOT NULL DEFAULT 20,

    -- Outcome
    winner_id UUID REFERENCES public.users(id),
    score_p1 INTEGER DEFAULT 0,
    score_p2 INTEGER DEFAULT 0,

    -- Round-by-round data: [{ round: 1, choice_p1: 'rock', choice_p2: 'scissors', winner: 'p1' }, ...]
    rounds_data JSONB DEFAULT '[]'::jsonb,

    -- Match format
    best_of INTEGER NOT NULL DEFAULT 3 CHECK (best_of IN (3, 5)),
    wins_needed INTEGER NOT NULL DEFAULT 2,

    -- Status lifecycle: waiting → active → completed | cancelled | refunded
    status VARCHAR(32) NOT NULL DEFAULT 'waiting'
        CHECK (status IN ('waiting', 'active', 'completed', 'cancelled', 'refunded', 'payout_failed')),

    -- Bucket tracking for precise refunds (same pattern as games table)
    bonus_used_p1 INTEGER DEFAULT 0,
    bonus_used_p2 INTEGER DEFAULT 0,
    withdrawable_used_p1 INTEGER DEFAULT 0,
    withdrawable_used_p2 INTEGER DEFAULT 0,
    locked_used_p1 INTEGER DEFAULT 0,
    locked_used_p2 INTEGER DEFAULT 0,

    -- Prize tracking
    prize_amount INTEGER DEFAULT 0,

    -- Idempotency key for the payout transaction (one payout per match)
    payout_idempotency_key VARCHAR(128) UNIQUE,

    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Idempotent column & unique index upgrades for DBs seeded from full_schema.sql
ALTER TABLE public.rps_games ADD COLUMN IF NOT EXISTS fee_percent INTEGER NOT NULL DEFAULT 20;
ALTER TABLE public.rps_games ADD COLUMN IF NOT EXISTS wins_needed INTEGER NOT NULL DEFAULT 2;
ALTER TABLE public.rps_games ADD COLUMN IF NOT EXISTS bonus_used_p1 INTEGER DEFAULT 0;
ALTER TABLE public.rps_games ADD COLUMN IF NOT EXISTS bonus_used_p2 INTEGER DEFAULT 0;
ALTER TABLE public.rps_games ADD COLUMN IF NOT EXISTS withdrawable_used_p1 INTEGER DEFAULT 0;
ALTER TABLE public.rps_games ADD COLUMN IF NOT EXISTS withdrawable_used_p2 INTEGER DEFAULT 0;
ALTER TABLE public.rps_games ADD COLUMN IF NOT EXISTS locked_used_p1 INTEGER DEFAULT 0;
ALTER TABLE public.rps_games ADD COLUMN IF NOT EXISTS locked_used_p2 INTEGER DEFAULT 0;
ALTER TABLE public.rps_games ADD COLUMN IF NOT EXISTS prize_amount INTEGER DEFAULT 0;
ALTER TABLE public.rps_games ADD COLUMN IF NOT EXISTS payout_idempotency_key VARCHAR(128);
ALTER TABLE public.rps_games ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
ALTER TABLE public.rps_games ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

CREATE UNIQUE INDEX IF NOT EXISTS uq_rps_games_room_id ON public.rps_games(room_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_rps_games_payout_idem ON public.rps_games(payout_idempotency_key) WHERE payout_idempotency_key IS NOT NULL;

-- Hot-path indexes
CREATE INDEX IF NOT EXISTS idx_rps_games_status ON public.rps_games(status);
CREATE INDEX IF NOT EXISTS idx_rps_games_player_1 ON public.rps_games(player_1);
CREATE INDEX IF NOT EXISTS idx_rps_games_player_2 ON public.rps_games(player_2);
CREATE INDEX IF NOT EXISTS idx_rps_games_created_at ON public.rps_games(created_at);
CREATE INDEX IF NOT EXISTS idx_rps_games_winner ON public.rps_games(winner_id);

COMMENT ON TABLE public.rps_games IS 'Rock Paper Scissors matches — isolated from the TicTacToe games table.';
COMMENT ON COLUMN public.rps_games.stake_amount IS 'Per-player stake in ETB (integer). Valid tiers: 10, 25, 50, 100.';
COMMENT ON COLUMN public.rps_games.rounds_data IS 'JSONB array of per-round choices and outcomes for audit trail.';
COMMENT ON COLUMN public.rps_games.payout_idempotency_key IS 'Ensures exactly one payout per match via uq_wallet_tx_idem.';

COMMIT;
