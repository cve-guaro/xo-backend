-- ============================================================================
-- XO ET — Migration 006: Enable RLS & Add Service Role Policies for 34 Tables
-- ============================================================================
-- Resolves Supabase Database Linter rls_enabled_no_policy (lint 0008) warnings.
--
-- For each table:
-- 1. Enables Row Level Security (RLS) if not already enabled.
-- 2. Creates an explicit "service_role_full_access" policy for service_role.
-- 3. Restricts direct anonymous/authenticated PostgREST access by default.
-- ============================================================================

DO $$ 
DECLARE 
    tbl_name text;
    has_service_role boolean;
    tables text[] := ARRAY[
      'admin_balance_edits',
      'app_users',
      'bonus_audit_logs',
      'bonus_logs',
      'bulk_sms_history',
      'fake_ticker_entries',
      'games',
      'giveaway_claims',
      'giveaways',
      'global_settings',
      'leaderboard_snapshots',
      'notifications',
      'otps',
      'payment_providers',
      'payment_transactions',
      'promo_popups',
      'promocode_usages',
      'promocodes',
      'promotion_claims',
      'promotion_links',
      'referrals',
      'room_wins',
      'spin_bets',
      'spin_room_configs',
      'spin_rounds',
      'system_alerts',
      'transactions',
      'user_entries',
      'users',
      'wallet_transactions',
      'wallets',
      'webhook_endpoints',
      'webhook_events',
      'withdraw_requests'
    ];
BEGIN 
    SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') INTO has_service_role;

    FOREACH tbl_name IN ARRAY tables LOOP
        -- Only attempt if table exists in public schema
        IF EXISTS (
            SELECT 1 
            FROM information_schema.tables 
            WHERE table_schema = 'public' 
              AND table_name = tbl_name
        ) THEN
            -- 1. Enable RLS
            EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', tbl_name);
            
            -- 2. Drop existing policy variants if present for idempotency
            EXECUTE format('DROP POLICY IF EXISTS "service_role_full_access" ON public.%I;', tbl_name);
            EXECUTE format('DROP POLICY IF EXISTS "deny_public_access" ON public.%I;', tbl_name);
            
            -- 3. Create policy based on environment role availability
            IF has_service_role THEN
                EXECUTE format('CREATE POLICY "service_role_full_access" ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true);', tbl_name);
            ELSE
                EXECUTE format('CREATE POLICY "deny_public_access" ON public.%I FOR ALL USING (false);', tbl_name);
            END IF;
            
            RAISE NOTICE 'Updated RLS policy for public.%', tbl_name;
        END IF;
    END LOOP;
END $$;
