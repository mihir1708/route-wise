BEGIN;
DO $$ BEGIN
  IF has_function_privilege('anon','public.gateway_dashboard(timestamptz,timestamptz,uuid)','EXECUTE') OR
     has_function_privilege('authenticated','public.gateway_dashboard(timestamptz,timestamptz,uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'Dashboard aggregates must be admin-only';
  END IF;
END $$;
INSERT INTO public.tenants(id,name,monthly_budget,rpm_limit,tpm_limit) VALUES
  ('00000000-0000-4000-8000-0000000000e1','dash-a',5,10,100000),
  ('00000000-0000-4000-8000-0000000000e2','dash-b',5,10,100000);
-- Tenant a, 2091-01-02: 20 low-tier answers (latency 100..2000 ms, one failed), 10 high-tier answers,
-- one with a fallback and one escalated; then a cache hit and a rate-limit rejection on 2091-01-03.
INSERT INTO public.request_runs(request_id,timestamp,tenant_id,selected_model,selected_tier,cost_usd,latency_ms,
  provider_succeeded,application_succeeded,failure_stage,fallback_used,escalated,attempt_count)
SELECT uuid_generate_v4(), '2091-01-02T08:00Z'::timestamptz + g * interval '1 minute', '00000000-0000-4000-8000-0000000000e1',
  CASE WHEN g <= 20 THEN 'm-low' ELSE 'm-high' END, CASE WHEN g <= 20 THEN 'low' ELSE 'high' END,
  CASE WHEN g <= 20 THEN 0.0001 ELSE 0.01 END, g * 100, true, g <> 7, CASE WHEN g = 7 THEN 'output_validation' END,
  g = 21, g = 22, CASE WHEN g = 21 THEN 2 ELSE 1 END
FROM generate_series(1, 30) g;
INSERT INTO public.request_runs(request_id,timestamp,tenant_id,selected_model,selected_tier,cost_usd,latency_ms,
  provider_succeeded,application_succeeded,failure_stage,error_category,cache_hit,routing_policy_version) VALUES
  (uuid_generate_v4(),'2091-01-03T09:00Z','00000000-0000-4000-8000-0000000000e1','m-low','low',0,5,false,true,NULL,NULL,true,'cache'),
  (uuid_generate_v4(),'2091-01-03T09:01Z','00000000-0000-4000-8000-0000000000e1',NULL,NULL,NULL,3,false,false,'rate_limit','rpm_exceeded',false,'unrouted'),
  (uuid_generate_v4(),'2091-01-03T09:02Z','00000000-0000-4000-8000-0000000000e2','m-mid','mid',0.5,900,true,true,NULL,NULL,false,'rules-v1'),
  (uuid_generate_v4(),'2091-01-09T09:00Z','00000000-0000-4000-8000-0000000000e1','m-low','low',0.7,900,true,true,NULL,NULL,false,'rules-v1');
DO $$ DECLARE d jsonb; s jsonb; low jsonb; high jsonb; BEGIN
  d := public.gateway_dashboard('2091-01-01','2091-01-08','00000000-0000-4000-8000-0000000000e1');
  s := d->'summary';
  IF (s->>'requests')::int <> 32 OR (s->>'succeeded')::int <> 30 OR (s->>'cost_usd')::numeric <> 0.102
     OR (s->>'provider_requests')::int <> 30 OR (s->>'cache_hits')::int <> 1 OR (s->>'fallbacks')::int <> 1
     OR (s->>'escalations')::int <> 1 OR (s->>'rate_limited')::int <> 1 THEN
    RAISE EXCEPTION 'Dashboard summary wrong: %', s;
  END IF;
  low := d->'tiers'->0; high := d->'tiers'->1;
  -- The low tier's successful latencies are 100..2000 ms without 700; the cache hit is excluded.
  IF low->>'tier' <> 'low' OR (low->>'requests')::int <> 20 OR (low->>'succeeded')::int <> 19
     OR (low->>'p50_ms')::int <> 1100 OR (low->>'p95_ms')::int <> 2000 THEN
    RAISE EXCEPTION 'Low tier wrong: %', low;
  END IF;
  IF high->>'tier' <> 'high' OR (high->>'requests')::int <> 10 OR (high->>'p95_ms')::int <> 3000 OR jsonb_array_length(d->'tiers') <> 2 THEN
    RAISE EXCEPTION 'High tier wrong: %', d->'tiers';
  END IF;
  IF jsonb_array_length(d->'daily') <> 7 OR d->'daily'->0->>'date' <> '2091-01-01'
     OR (d->'daily'->1->>'low')::int <> 20 OR (d->'daily'->1->>'high')::int <> 10 OR (d->'daily'->2->>'cache')::int <> 1
     OR (d->'daily'->0->>'requests')::int <> 0 THEN
    RAISE EXCEPTION 'Daily series wrong: %', d->'daily';
  END IF;
  IF jsonb_array_length(d->'recent') <> 25 OR d->'recent'->0->>'tenant_name' <> 'dash-a' OR d->'recent'->0 ? 'query_hash' THEN
    RAISE EXCEPTION 'Recent requests wrong: %', d->'recent'->0;
  END IF;
  d := public.gateway_dashboard('2091-01-01','2091-01-08');
  IF (d->'summary'->>'requests')::int <> 33 OR NOT d->'tenants' @> '[{"name":"dash-b"}]' THEN
    RAISE EXCEPTION 'Unfiltered dashboard wrong: %', d->'summary';
  END IF;
END $$;
ROLLBACK;
