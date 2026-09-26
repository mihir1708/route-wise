-- Database schema for RouteWise
-- Run this in your Supabase SQL Editor

-- Logs every query with metrics
CREATE TABLE IF NOT EXISTS router_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  timestamp TIMESTAMPTZ DEFAULT NOW(),
  query_text TEXT,
  query_hash TEXT,
  chosen_model VARCHAR(50),
  estimated_difficulty DECIMAL(3,2),
  prompt_tokens INT,
  completion_tokens INT,
  cost_usd DECIMAL(10,6),
  response_time_ms INT,
  was_successful BOOLEAN DEFAULT true
);

CREATE INDEX IF NOT EXISTS idx_router_logs_timestamp ON router_logs(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_router_logs_model ON router_logs(chosen_model);

-- Monthly budget tracking
CREATE TABLE IF NOT EXISTS budget_tracking (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  month VARCHAR(7),
  total_cost DECIMAL(14,6) DEFAULT 0,
  total_requests INT DEFAULT 0,
  cheap_model_count INT DEFAULT 0,
  mid_model_count INT DEFAULT 0,
  expert_model_count INT DEFAULT 0,
  budget_limit DECIMAL(10,2) DEFAULT 100.00,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(month)
);

CREATE INDEX IF NOT EXISTS idx_budget_tracking_month ON budget_tracking(month);

-- Auto-update timestamp on changes
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_budget_tracking_updated_at
    BEFORE UPDATE ON budget_tracking
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Initialize current month
INSERT INTO budget_tracking (month, total_cost, total_requests, cheap_model_count, mid_model_count, expert_model_count, budget_limit)
VALUES (
  TO_CHAR(NOW(), 'YYYY-MM'),
  0,
  0,
  0,
  0,
  0,
  100.00
)
ON CONFLICT (month) DO NOTHING;

-- Useful views for analytics
CREATE OR REPLACE VIEW daily_costs AS
SELECT
  DATE(timestamp) as date,
  SUM(cost_usd) as total_cost,
  COUNT(*) as request_count,
  chosen_model
FROM router_logs
GROUP BY DATE(timestamp), chosen_model
ORDER BY date DESC;

CREATE OR REPLACE VIEW model_distribution AS
SELECT
  chosen_model,
  COUNT(*) as request_count,
  SUM(cost_usd) as total_cost,
  AVG(response_time_ms) as avg_response_time
FROM router_logs
WHERE timestamp > NOW() - INTERVAL '30 days'
GROUP BY chosen_model;
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
BEGIN;
CREATE TABLE public.request_runs (
  request_id uuid PRIMARY KEY,
  timestamp timestamptz NOT NULL DEFAULT now(),
  query_hash text,
  selected_model text,
  estimated_difficulty numeric,
  prompt_tokens integer,
  completion_tokens integer,
  total_tokens integer,
  cost_usd numeric(14,6),
  latency_ms integer NOT NULL,
  provider_succeeded boolean NOT NULL,
  application_succeeded boolean NOT NULL,
  failure_stage text,
  error_category text
);
CREATE INDEX request_runs_timestamp ON public.request_runs(timestamp DESC);
ALTER TABLE public.request_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.request_runs FROM anon, authenticated;
GRANT ALL ON public.request_runs TO service_role;
COMMIT;
BEGIN;
ALTER TABLE public.request_runs
  ADD COLUMN selected_tier text CHECK (selected_tier IN ('low','mid','high')),
  ADD COLUMN routing_policy_version text NOT NULL DEFAULT 'heuristic-v1',
  ADD COLUMN pricing_version text NOT NULL DEFAULT 'legacy-2026-01',
  ADD COLUMN budget_percentage numeric,
  ADD COLUMN escalated boolean NOT NULL DEFAULT false;
ALTER TABLE public.router_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.budget_tracking ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.router_logs, public.budget_tracking, public.daily_costs, public.model_distribution FROM anon, authenticated;
GRANT ALL ON public.router_logs, public.budget_tracking TO service_role;
GRANT SELECT ON public.daily_costs, public.model_distribution TO service_role;
COMMIT;
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
BEGIN;
ALTER TABLE public.request_runs ADD COLUMN route_reasons jsonb NOT NULL DEFAULT '[]';
COMMIT;
BEGIN;
CREATE TABLE public.verification_jobs (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  request_id uuid NOT NULL UNIQUE REFERENCES public.request_runs(request_id),
  routed_model text NOT NULL,
  routed_tier text NOT NULL,
  verifier_model text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','completed','failed')),
  payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  started_at timestamptz,
  verified_at timestamptz,
  automated_quality_score numeric CHECK (automated_quality_score BETWEEN 0 AND 1),
  routing_failure boolean,
  quality_gap numeric,
  cost_usd numeric(14,6),
  error_category text
);
CREATE INDEX verification_pending ON public.verification_jobs(created_at) WHERE status='pending';
ALTER TABLE public.verification_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.verification_jobs FROM anon,authenticated;
GRANT ALL ON public.verification_jobs TO service_role;
CREATE FUNCTION public.claim_verification_job() RETURNS SETOF public.verification_jobs
LANGUAGE sql SET search_path = public AS $$
  UPDATE public.verification_jobs SET status='processing',started_at=now()
  WHERE id = (SELECT id FROM public.verification_jobs
    WHERE status='pending' AND expires_at > now() ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
  RETURNING *;
$$;
REVOKE ALL ON FUNCTION public.claim_verification_job() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_verification_job() TO service_role;
COMMIT;
BEGIN;
CREATE FUNCTION public.request_stats(p_start timestamptz, p_end timestamptz)
RETURNS jsonb LANGUAGE sql STABLE SET search_path=public AS $$
WITH runs AS (SELECT * FROM public.request_runs WHERE timestamp >= p_start AND timestamp < p_end),
models AS (SELECT selected_model, count(*) AS n FROM runs WHERE selected_model IS NOT NULL GROUP BY selected_model),
tiers AS (SELECT selected_tier, count(*) AS n FROM runs WHERE selected_tier IS NOT NULL GROUP BY selected_tier),
policies AS (SELECT routing_policy_version, count(*) AS n FROM runs GROUP BY routing_policy_version),
daily AS (SELECT to_char(timestamp AT TIME ZONE 'UTC','YYYY-MM-DD') AS date,sum(cost_usd) AS cost FROM runs GROUP BY 1),
recent AS (SELECT * FROM runs ORDER BY timestamp DESC LIMIT 20)
SELECT jsonb_build_object(
 'total_requests',(SELECT count(*) FROM runs),
 'total_cost',(SELECT coalesce(sum(cost_usd),0) FROM runs),
 'unknown_usage_requests',(SELECT count(*) FROM runs WHERE provider_succeeded AND cost_usd IS NULL),
 'failed_requests',(SELECT count(*) FROM runs WHERE NOT application_succeeded OR failure_stage IS NOT NULL),
 'unsettled_requests',(SELECT count(*) FROM runs WHERE failure_stage='accounting'),
 'model_distribution',coalesce((SELECT jsonb_object_agg(selected_model,n) FROM models),'{}'),
 'tier_distribution',coalesce((SELECT jsonb_object_agg(selected_tier,n) FROM tiers),'{}'),
 'policy_distribution',coalesce((SELECT jsonb_object_agg(routing_policy_version,n) FROM policies),'{}'),
 'daily_costs',coalesce((SELECT jsonb_agg(to_jsonb(daily) ORDER BY date) FROM daily),'[]'),
 'recent_logs',coalesce((SELECT jsonb_agg(to_jsonb(recent) ORDER BY timestamp DESC) FROM recent),'[]')
);
$$;
REVOKE ALL ON FUNCTION public.request_stats(timestamptz,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.request_stats(timestamptz,timestamptz) TO service_role;
CREATE FUNCTION public.maintain_retention() RETURNS void LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  UPDATE public.verification_jobs SET payload=NULL,status='failed',error_category='expired_or_interrupted'
    WHERE status IN ('pending','processing') AND (expires_at < now() OR (status='processing' AND started_at < now()-interval '15 minutes'));
  DELETE FROM public.verification_jobs WHERE created_at < now()-interval '30 days'
    OR request_id IN (SELECT request_id FROM public.request_runs WHERE timestamp < now()-interval '30 days');
  DELETE FROM public.request_runs WHERE timestamp < now()-interval '30 days';
  DELETE FROM public.router_logs WHERE timestamp < now()-interval '30 days';
END $$;
REVOKE ALL ON FUNCTION public.maintain_retention() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.maintain_retention() TO service_role;
COMMIT;
