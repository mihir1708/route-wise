BEGIN;
DO $$ BEGIN
  IF has_table_privilege('anon','public.request_runs','SELECT') OR
     has_function_privilege('anon','public.increment_budget_usage(text,numeric,text,numeric,text)','EXECUTE') THEN
    RAISE EXCEPTION 'Anonymous database access must be denied';
  END IF;
  IF to_regclass('public.verification_jobs') IS NOT NULL OR to_regprocedure('public.request_stats(timestamptz,timestamptz)') IS NOT NULL THEN
    RAISE EXCEPTION 'Removed verification queue or old stats query still present';
  END IF;
END $$;
INSERT INTO public.request_runs(request_id,timestamp,selected_model,selected_tier,latency_ms,provider_succeeded,application_succeeded,cost_usd,routing_policy_version)
VALUES ('00000000-0000-4000-8000-000000000001','2090-01-15','fixture-model','low',10,true,true,0.001,'heuristic-v1'),
       ('00000000-0000-4000-8000-000000000002',now()-interval '31 days','fixture-model','low',10,true,false,0.001,'heuristic-v1');
DO $$ BEGIN
  PERFORM public.maintain_retention();
  IF EXISTS(SELECT FROM public.request_runs WHERE request_id='00000000-0000-4000-8000-000000000002') THEN RAISE EXCEPTION 'Retention failed'; END IF;
  IF NOT EXISTS(SELECT FROM public.request_runs WHERE request_id='00000000-0000-4000-8000-000000000001') THEN RAISE EXCEPTION 'Retention removed a current row'; END IF;
END $$;
ROLLBACK;
