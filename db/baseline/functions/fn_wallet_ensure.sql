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
