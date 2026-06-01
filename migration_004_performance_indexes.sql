-- Migration 004: Performance Indexes & Tuning

-- 1. Create missing indexes on games table for matchmaking/player lookup
CREATE INDEX IF NOT EXISTS idx_games_player_x ON games(player_x);
CREATE INDEX IF NOT EXISTS idx_games_player_o ON games(player_o);

-- 2. Create partial index on ongoing games to optimize active game queries
CREATE INDEX IF NOT EXISTS idx_games_status_ongoing ON games(status) WHERE status = 'ongoing';

-- 3. Create partial index on pending transactions to optimize payout/cron polling
CREATE INDEX IF NOT EXISTS idx_wallet_tx_pending ON wallet_transactions(tx_type, created_at) WHERE status = 'PENDING';

-- 4. Drop redundant index idx_users_userid on users (id is already users_pkey)
DROP INDEX IF EXISTS idx_users_userid;
