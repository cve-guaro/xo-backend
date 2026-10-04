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
CREATE OR REPLACE FUNCTION public.fn_wallet_apply_existing_tx(p_tx_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
            DECLARE
              v_tx RECORD;
              v_wallet RECORD;
            BEGIN
              SELECT * INTO v_tx FROM wallet_transactions WHERE id = p_tx_id FOR UPDATE;
              IF v_tx.id IS NULL THEN RAISE EXCEPTION 'tx not found'; END IF;
              IF v_tx.applied_at IS NOT NULL THEN RETURN v_tx.id; END IF;
              IF v_tx.status <> 'COMPLETED' THEN RAISE EXCEPTION 'tx not completed'; END IF;

              PERFORM fn_wallet_ensure(v_tx.user_id);
              SELECT * INTO v_wallet FROM wallets WHERE user_id = v_tx.user_id FOR UPDATE;

              IF v_tx.tx_type = 'PRIZE' THEN
                UPDATE wallets
                SET available_balance = available_balance + v_tx.amount,
                    withdrawable_balance = withdrawable_balance + v_tx.amount,
                    updated_at = now()
                WHERE user_id = v_tx.user_id;
              ELSIF v_tx.tx_type = 'DEPOSIT' THEN
                UPDATE wallets
                SET available_balance = available_balance + v_tx.amount,
                    updated_at = now()
                WHERE user_id = v_tx.user_id;
              ELSIF v_tx.tx_type IN ('REFUND','ADJUSTMENT', 'GIFT', 'BONUS', 'ADMIN_EDIT', 'ADMIN_CREDIT') THEN
                UPDATE wallets
                SET available_balance = available_balance + v_tx.amount,
                    bonus_balance = CASE WHEN v_tx.tx_type = 'BONUS' THEN COALESCE(bonus_balance, 0) + v_tx.amount ELSE bonus_balance END,
                    updated_at = now()
                WHERE user_id = v_tx.user_id;
              ELSIF v_tx.tx_type = 'WITHDRAW_REQUEST' OR v_tx.tx_type = 'ADMIN_DEBIT' THEN
                IF v_wallet.withdrawable_balance < v_tx.amount AND v_tx.tx_type = 'WITHDRAW_REQUEST' THEN
                  RAISE EXCEPTION 'Insufficient withdrawable balance';
                END IF;
                IF v_wallet.available_balance < v_tx.amount THEN
                  RAISE EXCEPTION 'Insufficient available balance';
                END IF;
                UPDATE wallets
                SET available_balance = available_balance - v_tx.amount,
                    withdrawable_balance = GREATEST(withdrawable_balance - v_tx.amount, 0),
                    updated_at = now()
                WHERE user_id = v_tx.user_id;
              ELSIF v_tx.tx_type = 'WITHDRAW_REJECTED' THEN
                UPDATE wallets
                SET available_balance = available_balance + v_tx.amount,
                    withdrawable_balance = withdrawable_balance + v_tx.amount,
                    updated_at = now()
                WHERE user_id = v_tx.user_id;
              ELSIF v_tx.tx_type = 'WITHDRAW_SETTLED' THEN
                NULL;
              ELSE
                RAISE EXCEPTION 'Unhandled tx_type %', v_tx.tx_type;
              END IF;

              UPDATE wallet_transactions SET applied_at = now(), updated_at = now() WHERE id = v_tx.id;
              RETURN v_tx.id;
            END;
            $function$
CREATE OR REPLACE FUNCTION public.fn_wallet_ensure(p_user_id uuid)
 RETURNS wallets
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v wallets;
BEGIN
  INSERT INTO wallets(user_id) VALUES (p_user_id)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT * INTO v FROM wallets WHERE user_id = p_user_id;
  RETURN v;
END;
$function$
