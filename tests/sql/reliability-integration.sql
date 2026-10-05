BEGIN;
DO $$ BEGIN
  IF has_table_privilege('anon','public.response_cache','SELECT') OR has_table_privilege('anon','public.request_attempts','SELECT') OR
     has_function_privilege('anon','public.cache_lookup(uuid,text)','EXECUTE') OR
     has_function_privilege('anon','public.cache_store(uuid,text,text,text,text,integer)','EXECUTE') THEN
    RAISE EXCEPTION 'Anonymous access to cache or attempt data must be denied';
  END IF;
END $$;
INSERT INTO public.tenants(id,name,monthly_budget,rpm_limit,tpm_limit)
VALUES ('00000000-0000-4000-8000-0000000000c1','cache-fixture',1,10,1000),
       ('00000000-0000-4000-8000-0000000000c2','cache-other',1,10,1000);
DO $$ DECLARE k text := repeat('b',64); r jsonb; BEGIN
  PERFORM public.cache_store('00000000-0000-4000-8000-0000000000c1', k, 'cached answer', 'gpt-5.6-luna', 'low', 60);
  r := public.cache_lookup('00000000-0000-4000-8000-0000000000c1', k);
  IF r->>'answer' <> 'cached answer' OR r->>'model' <> 'gpt-5.6-luna' OR r->>'tier' <> 'low' THEN RAISE EXCEPTION 'Cache round trip failed: %', r; END IF;
  PERFORM public.cache_lookup('00000000-0000-4000-8000-0000000000c1', k);
  IF (SELECT hits FROM public.response_cache WHERE cache_key = k AND tenant_id = '00000000-0000-4000-8000-0000000000c1') <> 2 THEN
    RAISE EXCEPTION 'Cache hits not counted';
  END IF;
  IF public.cache_lookup('00000000-0000-4000-8000-0000000000c2', k) IS NOT NULL THEN RAISE EXCEPTION 'Cache leaked across tenants'; END IF;
  -- Overwrite resets the entry; expiry hides it and retention deletes it.
  PERFORM public.cache_store('00000000-0000-4000-8000-0000000000c1', k, 'newer', 'claude-haiku-4-5', 'low', 60);
  IF public.cache_lookup('00000000-0000-4000-8000-0000000000c1', k)->>'answer' <> 'newer' THEN RAISE EXCEPTION 'Cache overwrite failed'; END IF;
  UPDATE public.response_cache SET expires_at = now() - interval '1 second' WHERE cache_key = k;
  IF public.cache_lookup('00000000-0000-4000-8000-0000000000c1', k) IS NOT NULL THEN RAISE EXCEPTION 'Expired entry served'; END IF;
  PERFORM public.maintain_retention();
  IF EXISTS(SELECT FROM public.response_cache WHERE cache_key = k) THEN RAISE EXCEPTION 'Retention kept expired cache entry'; END IF;
  BEGIN
    PERFORM public.cache_store('00000000-0000-4000-8000-0000000000c1', k, 'x', 'm', 'low', 0);
    RAISE EXCEPTION 'Zero TTL accepted';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM = 'Zero TTL accepted' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.cache_store('00000000-0000-4000-8000-0000000000c1', 'not-a-hash', 'x', 'm', 'low', 60);
    RAISE EXCEPTION 'Malformed key accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;
-- Attempts hang off a run, carry no text, and go when the run is deleted.
INSERT INTO public.request_runs(request_id, latency_ms, provider_succeeded, application_succeeded, routing_policy_version, pricing_version,
  tenant_id, fallback_used, attempt_count, stage_timings)
VALUES ('00000000-0000-4000-8000-0000000000d1', 120, true, true, 'rules-v1', 'gateway-2026-10',
  '00000000-0000-4000-8000-0000000000c1', true, 2, '{"provider": 110}');
INSERT INTO public.request_attempts(request_id, attempt, model, provider, tier, outcome, error_kind, http_status, latency_ms, prompt_tokens, completion_tokens, cost_usd)
VALUES ('00000000-0000-4000-8000-0000000000d1', 1, 'gpt-5.6-sol', 'openai', 'high', 'error', 'overloaded', 529, 40, NULL, NULL, NULL),
       ('00000000-0000-4000-8000-0000000000d1', 2, 'claude-opus-5-5', 'anthropic', 'high', 'ok', NULL, NULL, 70, 100, 50, 0.0014);
DO $$ BEGIN
  IF (SELECT count(*) FROM public.request_attempts WHERE request_id = '00000000-0000-4000-8000-0000000000d1') <> 2 THEN RAISE EXCEPTION 'Attempts missing'; END IF;
  BEGIN
    INSERT INTO public.request_attempts(request_id, attempt, model, provider, tier, outcome, latency_ms)
      VALUES ('00000000-0000-4000-8000-0000000000d1', 3, 'm', 'openai', 'high', 'exploded', 1);
    RAISE EXCEPTION 'Unknown outcome accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  DELETE FROM public.request_runs WHERE request_id = '00000000-0000-4000-8000-0000000000d1';
  IF EXISTS(SELECT FROM public.request_attempts WHERE request_id = '00000000-0000-4000-8000-0000000000d1') THEN RAISE EXCEPTION 'Attempts outlived their run'; END IF;
END $$;
ROLLBACK;
