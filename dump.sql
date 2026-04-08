CREATE OR REPLACE FUNCTION public.fn_wallet_apply_tx(p_user_id uuid, p_tx_type wallet_tx_type, p_amount numeric, p_status wallet_tx_status, p_idempotency_key text, p_provider text DEFAULT NULL::text, p_provider_ref text DEFAULT NULL::text, p_meta jsonb DEFAULT '{}'::jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_wallet wallets%ROWTYPE;
  v_tx_id uuid;
  v_existing uuid;
  v_amount numeric(14,2);
  v_forced_id uuid; -- NEW: use providerRef as tx id (if valid uuid)
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'amount must be > 0';
  END IF;

  v_amount := ROUND(p_amount::numeric, 2);

  -- NEW: if provider_ref is a UUID, force tx id to be provider_ref
  BEGIN
    IF p_provider_ref IS NOT NULL AND length(p_provider_ref) > 0 THEN
      v_forced_id := p_provider_ref::uuid;
    END IF;
  EXCEPTION WHEN others THEN
    v_forced_id := NULL; -- if provider_ref isn't uuid, ignore
  END;

  -- NEW: If forced id exists already, return it (idempotent)
  IF v_forced_id IS NOT NULL THEN
    SELECT id INTO v_existing
    FROM wallet_transactions
    WHERE id = v_forced_id
    LIMIT 1;

    IF v_existing IS NOT NULL THEN
      RETURN v_existing;
    END IF;
  END IF;

  -- Existing idempotency: user_id + idempotency_key
  SELECT id INTO v_existing
  FROM wallet_transactions
  WHERE user_id = p_user_id
    AND idempotency_key = p_idempotency_key
  LIMIT 1;

  IF v_existing IS NOT NULL THEN
    RETURN v_existing;
  END IF;

  -- ensure wallet exists then lock it for update
  PERFORM fn_wallet_ensure(p_user_id);

  SELECT * INTO v_wallet
  FROM wallets
  WHERE user_id = p_user_id
  FOR UPDATE;

  -- create tx row first (PENDING/COMPLETED)
  INSERT INTO wallet_transactions(
    id, user_id, tx_type, status, amount,
    idempotency_key, provider, provider_ref, meta
  )
  VALUES (
    COALESCE(v_forced_id, gen_random_uuid()),
    p_user_id, p_tx_type, p_status, v_amount,
    p_idempotency_key, p_provider, p_provider_ref, COALESCE(p_meta,'{}'::jsonb)
  )
  RETURNING id INTO v_tx_id;

  -- Apply wallet changes only if COMPLETED (or if it's a WITHDRAW_REQUEST being initialized)
  IF p_status <> 'COMPLETED' AND p_tx_type <> 'WITHDRAW_REQUEST' THEN
    RETURN v_tx_id;
  END IF;

  -- Apply balance logic
  IF p_tx_type IN ('DEPOSIT','REFUND','ADJUSTMENT') THEN
    UPDATE wallets
    SET available_balance = available_balance + v_amount
    WHERE user_id = p_user_id;

  ELSIF p_tx_type = 'PRIZE' THEN
    UPDATE wallets
    SET available_balance = available_balance + v_amount,
        withdrawable_balance = withdrawable_balance + v_amount
    WHERE user_id = p_user_id;

  ELSIF p_tx_type = 'WITHDRAW_REQUEST' THEN
    IF v_wallet.withdrawable_balance < v_amount THEN
      RAISE EXCEPTION 'Insufficient withdrawable balance';
    END IF;
    IF v_wallet.available_balance < v_amount THEN
      RAISE EXCEPTION 'Insufficient available balance';
    END IF;

    UPDATE wallets
    SET available_balance = available_balance - v_amount,
        withdrawable_balance = withdrawable_balance - v_amount
    WHERE user_id = p_user_id;

  ELSIF p_tx_type = 'WITHDRAW_REJECTED' THEN
    UPDATE wallets
    SET available_balance = available_balance + v_amount,
        withdrawable_balance = withdrawable_balance + v_amount
    WHERE user_id = p_user_id;

  ELSIF p_tx_type = 'WITHDRAW_SETTLED' THEN
    NULL;

  ELSE
    RAISE EXCEPTION 'Unhandled tx_type %', p_tx_type;
  END IF;

  RETURN v_tx_id;
END;
$function$
