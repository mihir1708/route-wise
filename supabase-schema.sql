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

BEGIN;
-- Tenants call /api/generate with a bearer key; only its SHA-256 hash is stored.
CREATE TABLE public.tenants (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  name text NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 64),
  api_key_hash text UNIQUE CHECK (api_key_hash ~ '^[0-9a-f]{64}$'),
  key_prefix text,
  monthly_budget numeric(10,2) NOT NULL CHECK (monthly_budget >= 0),
  rpm_limit integer NOT NULL CHECK (rpm_limit > 0),
  tpm_limit integer NOT NULL CHECK (tpm_limit > 0),
  allowed_tiers text[] NOT NULL DEFAULT '{low,mid,high}'
    CHECK (allowed_tiers <@ '{low,mid,high}'::text[] AND cardinality(allowed_tiers) > 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.tenant_usage (
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  month text NOT NULL,
  total_cost numeric(14,6) NOT NULL DEFAULT 0,
  total_requests bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, month)
);
-- Fixed one-minute windows. Tokens are reserved before the call and corrected after it.
CREATE TABLE public.rate_limit_windows (
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  window_start timestamptz NOT NULL,
  requests integer NOT NULL DEFAULT 0,
  tokens bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, window_start)
);
ALTER TABLE public.request_runs
  ADD COLUMN tenant_id uuid REFERENCES public.tenants(id),
  ADD COLUMN task_type text,
  ADD COLUMN priority text CHECK (priority IN ('low','normal','high')),
  ADD COLUMN prompt_version text,
  ADD COLUMN latency_target_ms integer;
CREATE INDEX request_runs_tenant_timestamp ON public.request_runs(tenant_id, timestamp DESC);
ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rate_limit_windows ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tenants, public.tenant_usage, public.rate_limit_windows FROM anon, authenticated;
GRANT ALL ON public.tenants, public.tenant_usage, public.rate_limit_windows TO service_role;
-- The chat UI's tenant. It has no key; /api/route-query reaches it through the demo password.
INSERT INTO public.tenants(name, monthly_budget, rpm_limit, tpm_limit, allowed_tiers)
  VALUES ('demo', 1.00, 10, 20000, '{low,mid,high}') ON CONFLICT (name) DO NOTHING;

CREATE FUNCTION public.take_rate_limit(p_tenant uuid, p_tokens integer)
RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE t public.tenants; w timestamptz := date_trunc('minute', now()); win public.rate_limit_windows;
BEGIN
  IF p_tokens IS NULL OR p_tokens < 0 THEN RAISE EXCEPTION 'Invalid token reservation'; END IF;
  SELECT * INTO STRICT t FROM public.tenants WHERE id = p_tenant;
  INSERT INTO public.rate_limit_windows(tenant_id, window_start) VALUES (p_tenant, w)
    ON CONFLICT DO NOTHING;
  -- The row lock serializes concurrent requests, so limits hold across server instances.
  UPDATE public.rate_limit_windows SET requests = requests + 1, tokens = tokens + p_tokens
    WHERE tenant_id = p_tenant AND window_start = w
      AND requests < t.rpm_limit AND tokens + p_tokens <= t.tpm_limit
    RETURNING * INTO win;
  IF FOUND THEN
    RETURN jsonb_build_object('allowed', true, 'window_start', w);
  END IF;
  SELECT * INTO STRICT win FROM public.rate_limit_windows WHERE tenant_id = p_tenant AND window_start = w;
  RETURN jsonb_build_object('allowed', false, 'window_start', w,
    'reason', CASE WHEN win.requests >= t.rpm_limit THEN 'rpm_exceeded' ELSE 'tpm_exceeded' END,
    'retry_after_s', greatest(1, ceil(extract(epoch FROM (w + interval '1 minute' - now()))))::integer);
END $$;

CREATE FUNCTION public.adjust_rate_tokens(p_tenant uuid, p_window timestamptz, p_delta integer)
RETURNS void LANGUAGE sql SET search_path = public AS $$
  UPDATE public.rate_limit_windows SET tokens = greatest(0, tokens + p_delta)
    WHERE tenant_id = p_tenant AND window_start = p_window;
$$;

CREATE FUNCTION public.tenant_admission(p_tenant uuid, p_month text, p_global_limit numeric)
RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE t public.tenants; g public.budget_tracking; spent numeric;
BEGIN
  SELECT * INTO STRICT t FROM public.tenants WHERE id = p_tenant;
  g := public.ensure_budget_month(p_month, p_global_limit);
  SELECT coalesce((SELECT total_cost FROM public.tenant_usage WHERE tenant_id = p_tenant AND month = p_month), 0)
    INTO spent;
  RETURN jsonb_build_object('tenant_spent', spent, 'tenant_budget', t.monthly_budget,
    'global_spent', g.total_cost, 'global_limit', g.budget_limit);
END $$;

-- Charges the tenant's month and the global month in one transaction.
CREATE FUNCTION public.settle_request(
  p_tenant uuid, p_month text, p_cost numeric, p_model text, p_limit numeric, p_tier text
) RETURNS public.tenant_usage LANGUAGE plpgsql SET search_path = public AS $$
DECLARE result public.tenant_usage;
BEGIN
  PERFORM public.increment_budget_usage(p_month, p_cost, p_model, p_limit, p_tier);
  INSERT INTO public.tenant_usage(tenant_id, month, total_cost, total_requests)
    VALUES (p_tenant, p_month, p_cost, 1)
    ON CONFLICT (tenant_id, month) DO UPDATE SET
      total_cost = public.tenant_usage.total_cost + EXCLUDED.total_cost,
      total_requests = public.tenant_usage.total_requests + 1
    RETURNING * INTO STRICT result;
  RETURN result;
END $$;

CREATE OR REPLACE FUNCTION public.maintain_retention() RETURNS void LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  UPDATE public.verification_jobs SET payload=NULL,status='failed',error_category='expired_or_interrupted'
    WHERE status IN ('pending','processing') AND (expires_at < now() OR (status='processing' AND started_at < now()-interval '15 minutes'));
  DELETE FROM public.verification_jobs WHERE created_at < now()-interval '30 days'
    OR request_id IN (SELECT request_id FROM public.request_runs WHERE timestamp < now()-interval '30 days');
  DELETE FROM public.request_runs WHERE timestamp < now()-interval '30 days';
  DELETE FROM public.router_logs WHERE timestamp < now()-interval '30 days';
  DELETE FROM public.rate_limit_windows WHERE window_start < now()-interval '1 day';
END $$;
REVOKE ALL ON FUNCTION public.take_rate_limit(uuid,integer), public.adjust_rate_tokens(uuid,timestamptz,integer),
  public.tenant_admission(uuid,text,numeric), public.settle_request(uuid,text,numeric,text,numeric,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.take_rate_limit(uuid,integer), public.adjust_rate_tokens(uuid,timestamptz,integer),
  public.tenant_admission(uuid,text,numeric), public.settle_request(uuid,text,numeric,text,numeric,text)
  TO service_role;
COMMIT;

BEGIN;
-- Phase 2: per-attempt provider telemetry, request flags and stage timings, and a response cache.
ALTER TABLE public.request_runs
  ADD COLUMN cache_hit boolean NOT NULL DEFAULT false,
  ADD COLUMN fallback_used boolean NOT NULL DEFAULT false,
  ADD COLUMN attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  ADD COLUMN stage_timings jsonb NOT NULL DEFAULT '{}'::jsonb;

-- One row per provider call, or per call skipped by an open circuit. No prompt or answer text.
CREATE TABLE public.request_attempts (
  request_id uuid NOT NULL REFERENCES public.request_runs(request_id) ON DELETE CASCADE,
  attempt integer NOT NULL CHECK (attempt > 0),
  model text NOT NULL,
  provider text NOT NULL CHECK (provider IN ('openai','anthropic')),
  tier text NOT NULL CHECK (tier IN ('low','mid','high')),
  outcome text NOT NULL CHECK (outcome IN ('ok','error','circuit_open','invalid_output')),
  error_kind text,
  http_status integer,
  latency_ms integer NOT NULL CHECK (latency_ms >= 0),
  prompt_tokens integer CHECK (prompt_tokens >= 0),
  completion_tokens integer CHECK (completion_tokens >= 0),
  cost_usd numeric(14,6) CHECK (cost_usd >= 0),
  PRIMARY KEY (request_id, attempt)
);

-- Answers keyed by a hash of the prompt version and input, per tenant. The input itself is not stored.
CREATE TABLE public.response_cache (
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  cache_key text NOT NULL CHECK (cache_key ~ '^[0-9a-f]{64}$'),
  answer text NOT NULL,
  model text NOT NULL,
  tier text NOT NULL CHECK (tier IN ('low','mid','high')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  hits integer NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, cache_key)
);
CREATE INDEX response_cache_expires ON public.response_cache(expires_at);
ALTER TABLE public.request_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.response_cache ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.request_attempts, public.response_cache FROM anon, authenticated;
GRANT ALL ON public.request_attempts, public.response_cache TO service_role;

CREATE FUNCTION public.cache_lookup(p_tenant uuid, p_key text)
RETURNS jsonb LANGUAGE sql SET search_path = public AS $$
  UPDATE public.response_cache SET hits = hits + 1
    WHERE tenant_id = p_tenant AND cache_key = p_key AND expires_at > now()
    RETURNING jsonb_build_object('answer', answer, 'model', model, 'tier', tier);
$$;

CREATE FUNCTION public.cache_store(p_tenant uuid, p_key text, p_answer text, p_model text, p_tier text, p_ttl_s integer)
RETURNS void LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF p_ttl_s IS NULL OR p_ttl_s <= 0 THEN RAISE EXCEPTION 'Invalid cache TTL'; END IF;
  INSERT INTO public.response_cache(tenant_id, cache_key, answer, model, tier, expires_at)
    VALUES (p_tenant, p_key, p_answer, p_model, p_tier, now() + make_interval(secs => p_ttl_s))
    ON CONFLICT (tenant_id, cache_key) DO UPDATE SET answer = EXCLUDED.answer, model = EXCLUDED.model,
      tier = EXCLUDED.tier, created_at = now(), expires_at = EXCLUDED.expires_at, hits = 0;
END $$;

CREATE OR REPLACE FUNCTION public.maintain_retention() RETURNS void LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  UPDATE public.verification_jobs SET payload=NULL,status='failed',error_category='expired_or_interrupted'
    WHERE status IN ('pending','processing') AND (expires_at < now() OR (status='processing' AND started_at < now()-interval '15 minutes'));
  DELETE FROM public.verification_jobs WHERE created_at < now()-interval '30 days'
    OR request_id IN (SELECT request_id FROM public.request_runs WHERE timestamp < now()-interval '30 days');
  DELETE FROM public.request_runs WHERE timestamp < now()-interval '30 days';
  DELETE FROM public.router_logs WHERE timestamp < now()-interval '30 days';
  DELETE FROM public.rate_limit_windows WHERE window_start < now()-interval '1 day';
  DELETE FROM public.response_cache WHERE expires_at < now();
END $$;
REVOKE ALL ON FUNCTION public.cache_lookup(uuid,text), public.cache_store(uuid,text,text,text,text,integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cache_lookup(uuid,text), public.cache_store(uuid,text,text,text,text,integer)
  TO service_role;
COMMIT;

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
