BEGIN;
ALTER TABLE public.request_runs ADD COLUMN route_reasons jsonb NOT NULL DEFAULT '[]';
COMMIT;
