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
