-- ============================================================================
-- XO ET — Migration 007 Rollback: Disable Row-Level Security (RLS)
-- ============================================================================
-- PURPOSE:
-- Safely reverts Migration 007 by disabling Row Level Security on all public tables.
-- Use ONLY if emergency rollback is required during local/staging validation.
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
        EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY;', r.tablename);
        RAISE NOTICE 'RLS disabled on public.%', r.tablename;
    END LOOP;
END $$;
