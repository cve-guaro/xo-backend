-- ============================================================================
-- XO ET — Migration 007: Enable Row-Level Security (RLS) Lockdown (Zero Policies)
-- ============================================================================
-- PURPOSE:
-- Enforces a zero-trust default-deny posture on all public tables against PostgREST
-- / Supabase Data API endpoints (anon and authenticated keys).
--
-- SECURITY ARCHITECTURE NOTE:
-- 1. In PostgreSQL, when Row Level Security (RLS) is ENABLED on a table with ZERO
--    policies, the default action is COMPLETE DENY (no rows visible to non-owners).
-- 2. Any direct client attempting to query the Supabase PostgREST API using the
--    public anon key or authenticated user JWT will receive empty arrays or 401/403.
-- 3. The XOET backend connects directly via node-postgres (Pool) using the primary
--    connection string (role: `postgres` or Supabase db owner).
--    In PostgreSQL, table owners and superusers BYPASS RLS by default.
--    Because we do NOT execute `FORCE ROW LEVEL SECURITY`, all backend queries,
--    transactions, wallet mutations, and socket game logic remain 100% unaffected.
--
-- TARGET:
-- Local copy testing first. DO NOT APPLY TO PRODUCTION WITHOUT OWNER APPROVAL.
-- ============================================================================

DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN (
        SELECT tablename 
        FROM pg_tables 
        WHERE schemaname = 'public'
    ) LOOP
        -- 1. Enable RLS on each public table
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', r.tablename);
        
        -- 2. Ensure FORCE ROW LEVEL SECURITY is disabled so table owners/backend bypass RLS
        EXECUTE format('ALTER TABLE public.%I NO FORCE ROW LEVEL SECURITY;', r.tablename);
        
        RAISE NOTICE 'RLS lockdown enabled on public.%', r.tablename;
    END LOOP;
END $$;
