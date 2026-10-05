BEGIN;
CREATE TABLE public.verification_jobs (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  request_id uuid NOT NULL UNIQUE REFERENCES public.request_runs(request_id),
  routed_model text NOT NULL,
  routed_tier text NOT NULL,
  verifier_model text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','completed','failed')),
  payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  started_at timestamptz,
  verified_at timestamptz,
  automated_quality_score numeric CHECK (automated_quality_score BETWEEN 0 AND 1),
  routing_failure boolean,
  quality_gap numeric,
  cost_usd numeric(14,6),
  error_category text
);
CREATE INDEX verification_pending ON public.verification_jobs(created_at) WHERE status='pending';
ALTER TABLE public.verification_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.verification_jobs FROM anon,authenticated;
GRANT ALL ON public.verification_jobs TO service_role;
CREATE FUNCTION public.claim_verification_job() RETURNS SETOF public.verification_jobs
LANGUAGE sql SET search_path = public AS $$
  UPDATE public.verification_jobs SET status='processing',started_at=now()
  WHERE id = (SELECT id FROM public.verification_jobs
    WHERE status='pending' AND expires_at > now() ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
  RETURNING *;
$$;
REVOKE ALL ON FUNCTION public.claim_verification_job() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_verification_job() TO service_role;
COMMIT;
