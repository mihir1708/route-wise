# Database migrations

Apply numbered migration files in order to an existing RouteWise database using
the Supabase SQL Editor (or `psql -v ON_ERROR_STOP=1 -f <file>`). Files beginning
with `verify_` are optional verification scripts, not migrations. No migration
runner or new dependency is required.

For a fresh installation, use the root `supabase-schema.sql`; it includes the
latest precision. `CREATE TABLE IF NOT EXISTS` does not upgrade existing tables,
so existing installations must run the migration instead of rerunning bootstrap.

## 001: monthly spend precision (T02)

Run `001_budget_total_cost_precision.sql` in the Supabase SQL Editor for the
correct project. It changes only `public.budget_tracking.total_cost` from
`DECIMAL(10,2)` to `DECIMAL(14,6)` in a transaction. PostgreSQL treats DECIMAL and
NUMERIC as equivalent. The new type retains eight integer digits and adds four
fractional digits, matching the six-decimal scale of `router_logs.cost_usd`.
Using `DECIMAL(10,6)` instead would reduce the existing integer range.

All existing values fit exactly, including 99999999.99. The migration casts
existing values without resetting totals, recalculating spending, or updating
other columns. Defaults, nullability, and `budget_limit DECIMAL(10,2)` remain
unchanged. Reapplying this widening migration to the target type is safe, though
unnecessary. No automatic downgrade is provided because returning to two decimal
places would discard precision.

The ALTER requires a table lock and may rewrite the table; apply it during a
quiet period. Take the usual database backup and inspect current balances before
applying. After it commits, run `verify_001_budget_total_cost_precision.sql`.
That script asserts the deployed types and checks repeated charges, six-decimal
mixed charges, one-cent boundaries, and the old numeric range on a temporary
table copied from the actual deployed schema. It rolls back all temporary work
and does not change production balances. If an assertion fails, roll back the
failed transaction before retrying.

## Verification scope

`npm test` includes nine new application tests in
`tests/budget-precision.test.ts`. They call the real `addUsage()` with mocked
Supabase reads/writes, testing every accumulated payload without rounding in the
mock. Cases include 1/10/100 charges of $0.001, mixed six-decimal costs, balances
immediately below/at/above one cent, and an existing cents-based balance. These
tests would also pass before the SQL migration: they establish that application
arithmetic does not round to cents, not that PostgreSQL has been migrated.

The PostgreSQL verification script is provided for manual execution; it was not
run against a live database during T02. No database-precision claim is based on
emulated SQL or a rounding mock. Verification of the deployed type and persisted
values still requires applying the migration and running the SQL assertions.

## Remaining concerns (outside T02)

- Previously rounded-away spending cannot be recovered by widening the column.
- JavaScript still uses binary floating-point numbers. Tests allow tiny numerical
  representation error; this ticket does not introduce decimal arithmetic.
- Costs finer than six decimal places can still round when stored. For example,
  one GPT-3.5 input token currently costs $0.0000015. The unchanged request-log
  column already has this six-decimal limit; preserving finer units needs a
  separate precision policy.
- Concurrent read/modify/write lost updates remain for T03. Admission,
  thresholds, reservations, reset semantics, and pricing are unchanged.

## V2 migrations 002–008

Run numbered files once, in order, after 001. Bootstrap now includes them all for
fresh installs. 002 adds atomic accounting; 003/004 add and protect telemetry;
005 creates normalized model usage; 006 stores reasons; 007 creates verification
jobs; 008 adds SQL analytics/retention. Existing balances and historical strings
remain intact. Pause traffic while applying the RPC signature change in 005.
Retention only deletes old records when maintenance is explicitly run/scheduled.

The T02 tests remain under tests/legacy after T03 intentionally replaced the old
read/modify/write implementation. New atomic-budget tests verify RPC integration.
`npm run migrations:check` checks bootstrap parity, not SQL execution. The real
PostgreSQL workflow uses `npm run test:postgres` against an explicitly opted-in
empty disposable database, including concurrent connections and numeric checks.
