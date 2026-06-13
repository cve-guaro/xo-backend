-- Migration 005: Add r1_15_wins tier column for the new Room 1 "15 Birr" tier
-- Mirrors r1_10_wins / r1_25_wins / r1_50_wins / r1_99_wins (tracks wins for the 15-win lock cap)

ALTER TABLE users ADD COLUMN IF NOT EXISTS r1_15_wins INTEGER NOT NULL DEFAULT 0;
