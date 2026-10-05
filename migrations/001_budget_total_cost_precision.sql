-- T02: preserve six decimal places and the existing eight integer digits.
-- Widen the stored type without recalculating or resetting any existing totals.
BEGIN;

ALTER TABLE public.budget_tracking
  ALTER COLUMN total_cost TYPE DECIMAL(14,6)
  USING total_cost::DECIMAL(14,6);

COMMIT;
