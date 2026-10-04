CREATE OR REPLACE FUNCTION public.fn_wallet_apply_tx(p_user_id uuid, p_tx_type wallet_tx_type, p_amount numeric, p_status wallet_tx_status, p_idempotency_key text DEFAULT NULL::text, p_provider text DEFAULT NULL::text, p_provider_ref text DEFAULT NULL::text, p_meta jsonb DEFAULT '{}'::jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
        ELSE
          RAISE EXCEPTION 'Unhandled tx_type %', p_tx_type;
        END IF;

        RETURN v_tx_id;
      END;
      $function$
