BEGIN;
-- Everything the admin dashboard charts, for a time window and optionally one tenant. Counts,
-- costs and latency percentiles are computed here, so the dashboard never reads raw rows.
CREATE FUNCTION public.gateway_dashboard(p_start timestamptz, p_end timestamptz, p_tenant uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = public AS $$
WITH runs AS (
  SELECT r.*, t.name AS tenant_name FROM public.request_runs r LEFT JOIN public.tenants t ON t.id = r.tenant_id
  WHERE r.timestamp >= p_start AND r.timestamp < p_end AND (p_tenant IS NULL OR r.tenant_id = p_tenant)
),
-- Requests a model answered or tried to answer, by the tier that answered last. Cache hits are left out.
tiers AS (
  SELECT selected_tier AS tier, count(*) AS requests, count(*) FILTER (WHERE application_succeeded) AS succeeded,
    coalesce(sum(cost_usd), 0) AS cost_usd,
    percentile_disc(0.5) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE application_succeeded) AS p50_ms,
    percentile_disc(0.95) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE application_succeeded) AS p95_ms
  FROM runs WHERE selected_tier IS NOT NULL AND NOT cache_hit GROUP BY selected_tier
),
models AS (SELECT selected_model, count(*) AS n FROM runs WHERE selected_model IS NOT NULL GROUP BY selected_model),
days AS (
  SELECT d::date AS day FROM generate_series(date_trunc('day', p_start AT TIME ZONE 'UTC'),
    (p_end AT TIME ZONE 'UTC') - interval '1 microsecond', interval '1 day') AS d
),
daily AS (
  SELECT to_char(days.day, 'YYYY-MM-DD') AS date, count(r.request_id) AS requests,
    count(*) FILTER (WHERE r.application_succeeded) AS succeeded, coalesce(sum(r.cost_usd), 0) AS cost_usd,
    count(*) FILTER (WHERE r.cache_hit) AS cache,
    count(*) FILTER (WHERE NOT r.cache_hit AND r.selected_tier = 'low') AS low,
    count(*) FILTER (WHERE NOT r.cache_hit AND r.selected_tier = 'mid') AS mid,
    count(*) FILTER (WHERE NOT r.cache_hit AND r.selected_tier = 'high') AS high
  FROM days LEFT JOIN runs r ON (r.timestamp AT TIME ZONE 'UTC')::date = days.day
  GROUP BY days.day
),
recent AS (
  SELECT request_id, timestamp, tenant_name, task_type, selected_model, selected_tier, routing_policy_version,
    cache_hit, fallback_used, escalated, application_succeeded, failure_stage, error_category, cost_usd, latency_ms
  FROM runs ORDER BY timestamp DESC LIMIT 25
)
SELECT jsonb_build_object(
  'tenants', coalesce((SELECT jsonb_agg(jsonb_build_object('id', id, 'name', name) ORDER BY name) FROM public.tenants), '[]'),
  'summary', (SELECT jsonb_build_object(
    'requests', count(*),
    'succeeded', count(*) FILTER (WHERE application_succeeded),
    'cost_usd', coalesce(sum(cost_usd), 0),
    'provider_requests', count(*) FILTER (WHERE attempt_count > 0),
    'cache_hits', count(*) FILTER (WHERE cache_hit),
    'fallbacks', count(*) FILTER (WHERE fallback_used),
    'escalations', count(*) FILTER (WHERE escalated),
    'rate_limited', count(*) FILTER (WHERE failure_stage = 'rate_limit' AND error_category IN ('rpm_exceeded', 'tpm_exceeded', 'rate_limited')),
    'budget_rejected', count(*) FILTER (WHERE error_category IN ('budget_exhausted', 'tenant_budget_exhausted', 'max_cost_exceeded')),
    'unsettled', count(*) FILTER (WHERE failure_stage = 'accounting'),
    'unknown_usage', count(*) FILTER (WHERE provider_succeeded AND cost_usd IS NULL),
    'p50_ms', percentile_disc(0.5) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE application_succeeded AND NOT cache_hit),
    'p95_ms', percentile_disc(0.95) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE application_succeeded AND NOT cache_hit)
  ) FROM runs),
  'tiers', coalesce((SELECT jsonb_agg(to_jsonb(tiers) ORDER BY array_position(ARRAY['low','mid','high'], tier)) FROM tiers), '[]'),
  'models', coalesce((SELECT jsonb_object_agg(selected_model, n) FROM models), '{}'),
  'daily', coalesce((SELECT jsonb_agg(to_jsonb(daily) ORDER BY date) FROM daily), '[]'),
  'recent', coalesce((SELECT jsonb_agg(to_jsonb(recent) ORDER BY timestamp DESC) FROM recent), '[]')
);
$$;
REVOKE ALL ON FUNCTION public.gateway_dashboard(timestamptz,timestamptz,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gateway_dashboard(timestamptz,timestamptz,uuid) TO service_role;
COMMIT;
