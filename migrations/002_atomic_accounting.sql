BEGIN;
CREATE OR REPLACE FUNCTION public.ensure_budget_month(p_month text, p_limit numeric)
RETURNS public.budget_tracking LANGUAGE plpgsql SET search_path = public AS $$
DECLARE result public.budget_tracking;
BEGIN
  INSERT INTO public.budget_tracking(month, budget_limit) VALUES (p_month, p_limit)
    ON CONFLICT (month) DO NOTHING;
  SELECT * INTO STRICT result FROM public.budget_tracking WHERE month = p_month;
  RETURN result;
END $$;

CREATE OR REPLACE FUNCTION public.increment_budget_usage(
  p_month text, p_cost numeric, p_model text, p_limit numeric
) RETURNS public.budget_tracking LANGUAGE plpgsql SET search_path = public AS $$
DECLARE result public.budget_tracking;
BEGIN
  IF p_cost IS NULL OR p_cost < 0 OR p_cost::text IN ('NaN','Infinity','-Infinity') THEN
    RAISE EXCEPTION 'Invalid cost';
  END IF;
  PERFORM public.ensure_budget_month(p_month, p_limit);
  UPDATE public.budget_tracking SET
    total_cost = total_cost + p_cost,
    total_requests = total_requests + 1,
    cheap_model_count = cheap_model_count + CASE WHEN p_model <> 'gpt-4' THEN 1 ELSE 0 END,
    expert_model_count = expert_model_count + CASE WHEN p_model = 'gpt-4' THEN 1 ELSE 0 END,
    updated_at = now()
  WHERE month = p_month RETURNING * INTO STRICT result;
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.ensure_budget_month(text,numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.increment_budget_usage(text,numeric,text,numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_budget_month(text,numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.increment_budget_usage(text,numeric,text,numeric) TO service_role;
COMMIT;
