BEGIN;
-- The async verification worker and the old admin stats query were removed from the app.
-- Retention stops touching the job queue before the queue is dropped.
CREATE OR REPLACE FUNCTION public.maintain_retention() RETURNS void LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  DELETE FROM public.request_runs WHERE timestamp < now()-interval '30 days';
  DELETE FROM public.router_logs WHERE timestamp < now()-interval '30 days';
  DELETE FROM public.rate_limit_windows WHERE window_start < now()-interval '1 day';
  DELETE FROM public.response_cache WHERE expires_at < now();
END $$;
DROP FUNCTION public.claim_verification_job();
DROP TABLE public.verification_jobs;
DROP FUNCTION public.request_stats(timestamptz, timestamptz);
COMMIT;
