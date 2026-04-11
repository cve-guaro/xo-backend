-- Migration to add onboarding features
-- 003_onboarding.sql

ALTER TABLE users 
ADD COLUMN IF NOT EXISTS has_seen_welcome_bonus BOOLEAN DEFAULT FALSE;

-- Ensure existing users (who presumably already got the bonus in balance) 
-- are marked as seen if they have transactions or games
UPDATE users 
SET has_seen_welcome_bonus = TRUE 
WHERE id IN (SELECT user_id FROM wallets WHERE available_balance > 10)
   OR id IN (SELECT player_x FROM games UNION SELECT player_o FROM games);
