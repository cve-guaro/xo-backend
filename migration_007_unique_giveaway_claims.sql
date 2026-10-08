-- Migration: Add UNIQUE constraint to prevent duplicate promo code redemptions.
-- This prevents a race condition where two concurrent requests both pass the
-- application-level SELECT check and both insert a claim.
--
-- Apply to local: psql -d xoet_local -f migration_007_unique_giveaway_claims.sql
-- Apply to production: Run in Supabase SQL editor AFTER code deployment.
-- Safe to run multiple times (IF NOT EXISTS).

CREATE UNIQUE INDEX IF NOT EXISTS idx_giveaway_claims_unique
ON giveaway_claims (giveaway_id, user_id);
