BEGIN;
-- Settling a request used to update one global row per month and one row per model, so concurrent
-- requests from every tenant queued on those row locks (npm run load-test). Each settle now adds to
-- one of 16 shard rows. ensure_budget_month adds the month's shards to its row, so
-- every reader still sees exact totals.
CREATE TABLE public.budget_usage_shards (
  month text NOT NULL,
  shard smallint NOT NULL CHECK (shard BETWEEN 0 AND 15),
  total_cost numeric(14,6) NOT NULL DEFAULT 0,
  total_requests bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (month, shard)
);
ALTER TABLE public.budget_usage_shards ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.budget_usage_shards FROM anon, authenticated;
GRANT ALL ON public.budget_usage_shards TO service_role;

-- Existing model rows become shard 0. Read per-model totals from model_usage_totals.
ALTER TABLE public.model_usage ADD COLUMN shard smallint NOT NULL DEFAULT 0 CHECK (shard BETWEEN 0 AND 15);
ALTER TABLE public.model_usage DROP CONSTRAINT model_usage_pkey, ADD PRIMARY KEY (month, model, tier, shard);
CREATE VIEW public.model_usage_totals WITH (security_invoker = true) AS
  SELECT month, model, tier, sum(total_cost) AS total_cost, sum(total_requests) AS total_requests
  FROM public.model_usage GROUP BY month, model, tier;
REVOKE ALL ON public.model_usage_totals FROM anon, authenticated;
GRANT SELECT ON public.model_usage_totals TO service_role;

-- The month row keeps spend recorded before sharding; everything settled since is in the shards.
CREATE OR REPLACE FUNCTION public.ensure_budget_month(p_month text, p_limit numeric)
RETURNS public.budget_tracking LANGUAGE plpgsql SET search_path = public AS $$
DECLARE result public.budget_tracking; shard_cost numeric; shard_requests bigint;
BEGIN
  INSERT INTO public.budget_tracking(month, budget_limit) VALUES (p_month, p_limit)
    ON CONFLICT (month) DO NOTHING;
  SELECT * INTO STRICT result FROM public.budget_tracking WHERE month = p_month;
  SELECT coalesce(sum(total_cost), 0), coalesce(sum(total_requests), 0) INTO shard_cost, shard_requests
    FROM public.budget_usage_shards WHERE month = p_month;
  result.total_cost := coalesce(result.total_cost, 0) + shard_cost;
  result.total_requests := coalesce(result.total_requests, 0) + shard_requests;
  RETURN result;
END $$;

CREATE OR REPLACE FUNCTION public.increment_budget_usage(
  p_month text, p_cost numeric, p_model text, p_limit numeric, p_tier text
) RETURNS public.budget_tracking LANGUAGE plpgsql SET search_path = public AS $$
-- The shard comes from the transaction id: increments in one transaction share a row, so they never
-- wait on each other's shards and cannot deadlock, while concurrent transactions spread out.
DECLARE s smallint := (pg_current_xact_id()::text::bigint % 16)::smallint;
BEGIN
  IF p_cost IS NULL OR p_cost < 0 OR p_cost::text IN ('NaN','Infinity','-Infinity')
     OR p_tier NOT IN ('low','mid','high') OR p_model IS NULL OR p_tier IS NULL THEN
    RAISE EXCEPTION 'Invalid accounting input';
  END IF;
  INSERT INTO public.budget_tracking(month, budget_limit) VALUES (p_month, p_limit)
    ON CONFLICT (month) DO NOTHING;
  INSERT INTO public.budget_usage_shards(month, shard, total_cost, total_requests)
    VALUES (p_month, s, p_cost, 1)
    ON CONFLICT (month, shard) DO UPDATE SET
      total_cost = public.budget_usage_shards.total_cost + EXCLUDED.total_cost,
      total_requests = public.budget_usage_shards.total_requests + 1;
  INSERT INTO public.model_usage(month, model, tier, shard, total_cost, total_requests)
    VALUES (p_month, p_model, p_tier, s, p_cost, 1)
    ON CONFLICT (month, model, tier, shard) DO UPDATE SET
      total_cost = public.model_usage.total_cost + EXCLUDED.total_cost,
      total_requests = public.model_usage.total_requests + 1;
  -- Includes this request; one settling at the same moment in another transaction may not be visible yet.
  RETURN public.ensure_budget_month(p_month, p_limit);
END $$;

-- Zeroes a month in one transaction, shards included, and sets its limit.
CREATE FUNCTION public.reset_budget_month(p_month text, p_limit numeric)
RETURNS public.budget_tracking LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  DELETE FROM public.budget_usage_shards WHERE month = p_month;
  INSERT INTO public.budget_tracking(month, budget_limit) VALUES (p_month, p_limit)
    ON CONFLICT (month) DO UPDATE SET total_cost = 0, total_requests = 0, cheap_model_count = 0,
      mid_model_count = 0, expert_model_count = 0, budget_limit = EXCLUDED.budget_limit;
  RETURN public.ensure_budget_month(p_month, p_limit);
END $$;
REVOKE ALL ON FUNCTION public.reset_budget_month(text,numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reset_budget_month(text,numeric) TO service_role;
COMMIT;
