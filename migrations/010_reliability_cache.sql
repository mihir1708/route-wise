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
