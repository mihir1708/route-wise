-- Run AFTER migration 001 in Supabase SQL Editor or PostgreSQL.
-- Assertions use the actual deployed column type. Only temporary data is used.
-- An assertion failure raises an exception; success ends with ROLLBACK.
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'budget_tracking'
      AND column_name = 'total_cost'
      AND data_type = 'numeric' AND numeric_precision = 14 AND numeric_scale = 6
  ) THEN
    RAISE EXCEPTION 'Expected budget_tracking.total_cost NUMERIC(14,6)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'budget_tracking'
      AND column_name = 'budget_limit'
      AND numeric_precision = 10 AND numeric_scale = 2
  ) THEN
    RAISE EXCEPTION 'Expected unchanged budget_limit NUMERIC(10,2)';
  END IF;
END $$;

CREATE TEMP TABLE t02_precision_check
  (LIKE public.budget_tracking INCLUDING DEFAULTS) ON COMMIT DROP;

DO $$
DECLARE
  actual NUMERIC;
  charge NUMERIC;
  i INTEGER;
BEGIN
  INSERT INTO t02_precision_check (month, total_cost) VALUES ('repeat', 0);
  FOR i IN 1..100 LOOP
    UPDATE t02_precision_check SET total_cost = total_cost + 0.001
      WHERE month = 'repeat' RETURNING total_cost INTO actual;
    IF actual <> i * 0.001 THEN
      RAISE EXCEPTION 'Charge %: expected %, got %', i, i * 0.001, actual;
    END IF;
  END LOOP;

  INSERT INTO t02_precision_check (month, total_cost) VALUES ('mixed', 0);
  FOREACH charge IN ARRAY ARRAY[0.000001, 0.001234, 0.002985, 0.005779, 0.000002] LOOP
    UPDATE t02_precision_check SET total_cost = total_cost + charge
      WHERE month = 'mixed' RETURNING total_cost INTO actual;
  END LOOP;
  IF actual <> 0.010001 THEN
    RAISE EXCEPTION 'Mixed charges: expected 0.010001, got %', actual;
  END IF;

  INSERT INTO t02_precision_check (month, total_cost) VALUES ('cent', 0.009998);
  FOR i IN 1..3 LOOP
    UPDATE t02_precision_check SET total_cost = total_cost + 0.000001
      WHERE month = 'cent' RETURNING total_cost INTO actual;
    IF actual <> 0.009998 + i * 0.000001 THEN
      RAISE EXCEPTION 'One-cent boundary lost precision: %', actual;
    END IF;
  END LOOP;

  -- Existing two-decimal balances, including the old maximum, still fit.
  FOREACH charge IN ARRAY ARRAY[0, 12.34, 99999999.99, -99999999.99] LOOP
    INSERT INTO t02_precision_check (month, total_cost) VALUES ('legacy', charge)
      RETURNING total_cost INTO actual;
    IF actual <> charge THEN
      RAISE EXCEPTION 'Existing value % changed to %', charge, actual;
    END IF;
  END LOOP;
END $$;

ROLLBACK;
