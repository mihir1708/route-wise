BEGIN;
-- Legacy columns remain intact for historical reporting; no fabricated backfill.
CREATE TABLE public.model_usage (
  month text NOT NULL,
  model text NOT NULL,
  tier text NOT NULL CHECK (tier IN ('low','mid','high')),
  total_cost numeric(14,6) NOT NULL DEFAULT 0,
  total_requests bigint NOT NULL DEFAULT 0,
  PRIMARY KEY(month,model,tier)
);
ALTER TABLE public.model_usage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.model_usage FROM anon, authenticated;
GRANT ALL ON public.model_usage TO service_role;
DROP FUNCTION public.increment_budget_usage(text,numeric,text,numeric);
CREATE FUNCTION public.increment_budget_usage(
  p_month text, p_cost numeric, p_model text, p_limit numeric, p_tier text
) RETURNS public.budget_tracking LANGUAGE plpgsql SET search_path = public AS $$
DECLARE result public.budget_tracking;
BEGIN
  IF p_cost IS NULL OR p_cost < 0 OR p_cost::text IN ('NaN','Infinity','-Infinity')
     OR p_tier NOT IN ('low','mid','high') OR p_model IS NULL OR p_tier IS NULL THEN
    RAISE EXCEPTION 'Invalid accounting input';
  END IF;
  PERFORM public.ensure_budget_month(p_month, p_limit);
  UPDATE public.budget_tracking SET total_cost = total_cost + p_cost,
    total_requests = total_requests + 1, updated_at = now()
    WHERE month = p_month RETURNING * INTO STRICT result;
  INSERT INTO public.model_usage(month,model,tier,total_cost,total_requests)
    VALUES(p_month,p_model,p_tier,p_cost,1)
    ON CONFLICT(month,model,tier) DO UPDATE SET
      total_cost = public.model_usage.total_cost + EXCLUDED.total_cost,
      total_requests = public.model_usage.total_requests + 1;
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.increment_budget_usage(text,numeric,text,numeric,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.increment_budget_usage(text,numeric,text,numeric,text) TO service_role;
COMMIT;
