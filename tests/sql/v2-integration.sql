BEGIN;
DO $$ BEGIN
  IF has_table_privilege('anon','public.request_runs','SELECT') OR
     has_function_privilege('anon','public.increment_budget_usage(text,numeric,text,numeric,text)','EXECUTE') THEN
    RAISE EXCEPTION 'Anonymous database access must be denied';
  END IF;
END $$;
INSERT INTO public.request_runs(request_id,timestamp,selected_model,selected_tier,latency_ms,provider_succeeded,application_succeeded,cost_usd,routing_policy_version)
VALUES ('00000000-0000-4000-8000-000000000001','2090-01-15','fixture-model','low',10,true,true,0.001,'heuristic-v1'),
       ('00000000-0000-4000-8000-000000000002',now()-interval '31 days','fixture-model','low',10,true,false,0.001,'heuristic-v1');
INSERT INTO public.verification_jobs(request_id,routed_model,routed_tier,payload,created_at)
VALUES ('00000000-0000-4000-8000-000000000001','fixture-model','low','{"query":"test","answer":"test"}',now()),
       ('00000000-0000-4000-8000-000000000002','fixture-model','low','{"query":"old","answer":"old"}',now());
DO $$ DECLARE summary jsonb; first_count integer; second_count integer; BEGIN
  summary=public.request_stats('2090-01-01','2090-02-01');
  IF (summary->>'total_requests')::integer <> 1 OR (summary->>'total_cost')::numeric <> 0.001 THEN RAISE EXCEPTION 'Analytics aggregate mismatch'; END IF;
  SELECT count(*) INTO first_count FROM public.claim_verification_job();
  SELECT count(*) INTO second_count FROM public.claim_verification_job();
  IF first_count <> 1 OR second_count <> 1 OR EXISTS(SELECT FROM public.claim_verification_job()) THEN RAISE EXCEPTION 'Claim must process each pending job once'; END IF;
  PERFORM public.maintain_retention();
  IF EXISTS(SELECT FROM public.request_runs WHERE request_id='00000000-0000-4000-8000-000000000002') THEN RAISE EXCEPTION 'Retention failed'; END IF;
  IF EXISTS(SELECT FROM public.verification_jobs WHERE request_id='00000000-0000-4000-8000-000000000002') THEN RAISE EXCEPTION 'Dependent retention failed'; END IF;
END $$;
ROLLBACK;
