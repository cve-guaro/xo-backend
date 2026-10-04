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
