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

## 009: tenants and rate limits

Adds `tenants` (hashed API keys, monthly budget, RPM/TPM limits, allowed tiers),
`tenant_usage`, `rate_limit_windows` and new `request_runs` columns (tenant, task
type, priority, prompt version, latency target). Its RPCs take a rate-limit slot
under a row lock, read tenant and global spend together, and charge tenant and
global spend in one transaction. It also creates the keyless `demo` tenant used by
the chat UI and extends retention to delete rate-limit windows older than a day.
`npm run test:postgres` covers it, including 30 concurrent requests against a
10 RPM limit and 100 concurrent tenant charges.

## 010: reliability and response cache

Adds `request_attempts` (one row per provider call or circuit-breaker skip:
model, provider, tier, outcome, error kind, HTTP status, latency, tokens, cost;
deleted with its run), new `request_runs` columns (`cache_hit`, `fallback_used`,
`attempt_count`, `stage_timings`), and `response_cache` with the `cache_lookup`
and `cache_store` RPCs. Cache rows are scoped to a tenant, keyed by a hash, and
removed by `maintain_retention()` once expired. `npm run test:postgres` covers
the cache round trip, tenant isolation, expiry, retention and attempt cascades.

## 011: sharded global spend

Every settled request used to update the same `budget_tracking` month row and
`model_usage` row, so concurrent requests from all tenants queued on those row
locks. This migration adds `budget_usage_shards` (16 rows per month) and a `shard`
column on `model_usage`; `increment_budget_usage` adds each charge to the shard
chosen by its transaction id. `ensure_budget_month` returns the month row plus its
shards, so `tenant_admission`, the admin stats and the budget alerts read exact
totals as before. Read per-model totals from the new `model_usage_totals` view.
`reset_budget_month` clears a month and its shards in one transaction. Spend
recorded before the migration stays on the month row and is still counted.
`npm run test:postgres` covers concurrent increments across shards, the reset and
the new privileges, and `npm run load-test` measures the effect.

## 012: dashboard aggregates

Adds `gateway_dashboard(p_start, p_end, p_tenant)`, which returns everything the
admin dashboard charts as one JSON object: request, success, cache, fallback,
escalation and rate-limit counts; spend; p50/p95 latency overall and per tier;
a zero-filled daily series by tier; model counts; the tenant list for the filter;
and the 25 most recent requests (no hashes or text). Only `service_role` can run
it. `npm run test:postgres` checks its numbers against fixed fixture rows.

## 013: remove the verification queue

The async verification worker was removed from the app. This migration redefines
`maintain_retention()` without the job queue, then drops `claim_verification_job`,
`verification_jobs` and the old `request_stats` query that 012 replaced. Any
queued jobs are deleted with the table; they held at most 24 hours of consented
question and answer text.
