
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const SQL_MIGRATION = `
CREATE OR REPLACE FUNCTION fn_wallet_apply_tx(
  p_user_id uuid,
  p_tx_type wallet_tx_type,
  p_amount numeric,
  p_status wallet_tx_status,
  p_idempotency_key text DEFAULT NULL,
  p_provider text DEFAULT NULL,
  p_provider_ref text DEFAULT NULL,
  p_meta jsonb DEFAULT '{}'
)
RETURNS uuid AS $$
DECLARE
  v_tx_id uuid;
  v_wallet wallets%ROWTYPE;
  v_amount numeric := p_amount;
BEGIN
  -- 1) Idempotency check
  IF p_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_tx_id FROM wallet_transactions 
    WHERE idempotency_key = p_idempotency_key AND status != 'FAILED' LIMIT 1;
    IF FOUND THEN RETURN v_tx_id; END IF;
  END IF;

  -- 2) Create transaction record
  INSERT INTO wallet_transactions (user_id, tx_type, status, amount, meta, idempotency_key, provider, provider_ref)
  VALUES (p_user_id, p_tx_type, p_status, v_amount, p_meta, p_idempotency_key, p_provider, p_provider_ref)
  RETURNING id INTO v_tx_id;

  -- 3) Exit if not COMPLETED
  IF p_status != 'COMPLETED' THEN
    RETURN v_tx_id;
  END IF;

  -- 4) Lock and get wallet
  SELECT * INTO v_wallet FROM wallets WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO wallets (user_id, available_balance, withdrawable_balance, bonus_balance)
    VALUES (p_user_id, 0, 0, 0)
    RETURNING * INTO v_wallet;
  END IF;

  -- 5) Apply balance logic based on p_tx_type
  -- STABILIZED LOGIC: 
  --   Withdrawable = Real deposits + Real wins - Losses - Withdrawals
  --   Available    = Withdrawable + Admin Gifts + Welcome Bonus
  
  IF p_tx_type = 'DEPOSIT' OR p_tx_type = 'WON' THEN
    -- Real income: adds to both
    UPDATE wallets
    SET available_balance = available_balance + v_amount,
        withdrawable_balance = withdrawable_balance + v_amount,
        updated_at = now()
    WHERE user_id = p_user_id;

  ELSIF p_tx_type = 'GIFT' OR p_tx_type = 'BONUS' OR p_tx_type = 'ADMIN_EDIT' THEN
    -- Non-withdrawable income: adds only to available
    -- If it's explicitly a BONUS type, we also increment bonus_balance tracker
    UPDATE wallets
    SET available_balance = available_balance + v_amount,
        bonus_balance = CASE WHEN p_tx_type = 'BONUS' THEN bonus_balance + v_amount ELSE bonus_balance END,
        updated_at = now()
    WHERE user_id = p_user_id;

  ELSIF p_tx_type = 'WITHDRAW_REQUEST' OR p_tx_type = 'MATCH_STAKE' THEN
    -- Outgoing: subtract from both
    IF v_wallet.available_balance < v_amount THEN
      RAISE EXCEPTION 'Insufficient balance';
    END IF;
    
    UPDATE wallets
    SET available_balance = available_balance - v_amount,
        withdrawable_balance = GREATEST(withdrawable_balance - v_amount, 0),
        updated_at = now()
    WHERE user_id = p_user_id;

  ELSIF p_tx_type = 'WITHDRAW_REJECTED' THEN
    -- Return to both
    UPDATE wallets
    SET available_balance = available_balance + v_amount,
        withdrawable_balance = withdrawable_balance + v_amount,
        updated_at = now()
    WHERE user_id = p_user_id;

  ELSIF p_tx_type = 'WITHDRAW_SETTLED' THEN
    NULL; -- Already subtracted at REQUEST stage

  ELSE
    RAISE EXCEPTION 'Unhandled tx_type %', p_tx_type;
  END IF;

  RETURN v_tx_id;
END;
$$ LANGUAGE plpgsql;
`;

async function migrate() {
  try {
    await pool.query(SQL_MIGRATION);
    console.log('SUCCESS: fn_wallet_apply_tx updated with stabilization logic.');
  } catch (err) {
    console.error('ERROR during migration:', err);
  } finally {
    await pool.end();
  }
}

migrate();
