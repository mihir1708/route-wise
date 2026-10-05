BEGIN;
CREATE TABLE public.request_runs (
  request_id uuid PRIMARY KEY,
  timestamp timestamptz NOT NULL DEFAULT now(),
  query_hash text,
  selected_model text,
  estimated_difficulty numeric,
  prompt_tokens integer,
  completion_tokens integer,
  total_tokens integer,
  cost_usd numeric(14,6),
  latency_ms integer NOT NULL,
  provider_succeeded boolean NOT NULL,
  application_succeeded boolean NOT NULL,
  failure_stage text,
  error_category text
);
CREATE INDEX request_runs_timestamp ON public.request_runs(timestamp DESC);
ALTER TABLE public.request_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.request_runs FROM anon, authenticated;
GRANT ALL ON public.request_runs TO service_role;
COMMIT;
