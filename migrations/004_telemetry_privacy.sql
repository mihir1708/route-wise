BEGIN;
ALTER TABLE public.request_runs
  ADD COLUMN selected_tier text CHECK (selected_tier IN ('low','mid','high')),
  ADD COLUMN routing_policy_version text NOT NULL DEFAULT 'heuristic-v1',
  ADD COLUMN pricing_version text NOT NULL DEFAULT 'legacy-2026-01',
  ADD COLUMN budget_percentage numeric,
  ADD COLUMN escalated boolean NOT NULL DEFAULT false;
ALTER TABLE public.router_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.budget_tracking ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.router_logs, public.budget_tracking, public.daily_costs, public.model_distribution FROM anon, authenticated;
GRANT ALL ON public.router_logs, public.budget_tracking TO service_role;
GRANT SELECT ON public.daily_costs, public.model_distribution TO service_role;
COMMIT;
