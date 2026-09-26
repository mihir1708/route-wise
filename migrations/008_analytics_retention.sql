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
