BEGIN;
DO $$ BEGIN
  IF has_table_privilege('anon','public.tenants','SELECT') OR
     has_function_privilege('anon','public.take_rate_limit(uuid,integer)','EXECUTE') OR
     has_function_privilege('anon','public.settle_request(uuid,text,numeric,text,numeric,text)','EXECUTE') THEN
    RAISE EXCEPTION 'Anonymous access to tenant data must be denied';
  END IF;
  IF NOT EXISTS(SELECT FROM public.tenants WHERE name='demo' AND api_key_hash IS NULL) THEN
    RAISE EXCEPTION 'Demo tenant missing';
  END IF;
END $$;
INSERT INTO public.tenants(id,name,api_key_hash,monthly_budget,rpm_limit,tpm_limit,allowed_tiers)
VALUES ('00000000-0000-4000-8000-0000000000a1','sql-fixture',repeat('a',64),2.50,2,1000,'{low}');
DO $$ DECLARE r jsonb; a jsonb; u public.tenant_usage; BEGIN
  r := public.take_rate_limit('00000000-0000-4000-8000-0000000000a1', 600);
  IF NOT (r->>'allowed')::boolean THEN RAISE EXCEPTION 'First request must pass'; END IF;
  r := public.take_rate_limit('00000000-0000-4000-8000-0000000000a1', 600);
  IF (r->>'allowed')::boolean OR r->>'reason' <> 'tpm_exceeded' THEN RAISE EXCEPTION 'Token limit not enforced: %', r; END IF;
  PERFORM public.adjust_rate_tokens('00000000-0000-4000-8000-0000000000a1', (r->>'window_start')::timestamptz, -500);
  r := public.take_rate_limit('00000000-0000-4000-8000-0000000000a1', 600);
  IF NOT (r->>'allowed')::boolean THEN RAISE EXCEPTION 'Token correction not applied: %', r; END IF;
  r := public.take_rate_limit('00000000-0000-4000-8000-0000000000a1', 1);
  IF (r->>'allowed')::boolean OR r->>'reason' <> 'rpm_exceeded' OR (r->>'retry_after_s')::int NOT BETWEEN 1 AND 60 THEN
    RAISE EXCEPTION 'Request limit not enforced: %', r;
  END IF;
  u := public.settle_request('00000000-0000-4000-8000-0000000000a1','2090-03',0.000123,'fixture-model',50,'low');
  u := public.settle_request('00000000-0000-4000-8000-0000000000a1','2090-03',0.000877,'fixture-model',50,'low');
  IF u.total_cost <> 0.001 OR u.total_requests <> 2 THEN RAISE EXCEPTION 'Tenant usage mismatch'; END IF;
  IF NOT EXISTS(SELECT FROM public.budget_tracking WHERE month='2090-03' AND total_cost=0.001 AND total_requests=2) THEN
    RAISE EXCEPTION 'Global usage not charged with tenant usage';
  END IF;
  a := public.tenant_admission('00000000-0000-4000-8000-0000000000a1','2090-03',50);
  IF (a->>'tenant_spent')::numeric <> 0.001 OR (a->>'tenant_budget')::numeric <> 2.50 OR (a->>'global_spent')::numeric <> 0.001 THEN
    RAISE EXCEPTION 'Admission snapshot mismatch: %', a;
  END IF;
  a := public.tenant_admission('00000000-0000-4000-8000-0000000000a1','2090-04',50);
  IF (a->>'tenant_spent')::numeric <> 0 THEN RAISE EXCEPTION 'New month must start at zero'; END IF;
  BEGIN
    PERFORM public.settle_request('00000000-0000-4000-8000-0000000000a1','2090-03',-1,'fixture-model',50,'low');
    RAISE EXCEPTION 'Negative cost accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'Negative cost accepted' THEN RAISE; END IF;
  END;
  IF NOT EXISTS(SELECT FROM public.tenant_usage WHERE month='2090-03' AND total_cost=0.001) THEN
    RAISE EXCEPTION 'Rejected charge changed tenant usage';
  END IF;
END $$;
ROLLBACK;
