# Setup, operations and CI

How to run RouteWise locally, set up the database, keep it tidy, and run the checks CI runs. The [README](../README.md) has the short version.

## Running locally

Use Node 24.18.0 (`.nvmrc`). The locked development toolchain supports
`^20.19.0 || ^22.12.0 || >=24.0.0`; Node 18 is not supported. Verified installed
requirements: Next 16.1.3 needs >=20.9; Supabase 2.90.1 >=20; Vitest 4.0.18 supports
20/22/24+; Vite 7.3.6 needs ^20.19 or >=22.12. npm 12.0.2 was used locally.

```sh
nvm install
nvm use
npm ci
cp env.example .env.local
npm run dev
```

Set OpenAI/Supabase server credentials in `.env.local`. Set separate random
`ROUTEWISE_ADMIN_PASSWORD` and `ROUTEWISE_DEMO_PASSWORD` values of at least 32
characters. The browser uses HTTP Basic authentication: username `admin` or
`demo`. Admin can query and inspect statistics; demo cannot access admin APIs.
`ROUTEWISE_PUBLIC_DEMO=1` opens the demo page to visitors without the demo
password, at 5 requests a minute per visitor on each server instance. The demo
tenant's budget and rate limits, enforced in Postgres, cap what all visitors
together can spend; the admin pages still need the admin password.
There is no default credential or development bypass. Use HTTPS outside localhost.
Keep `APP_ORIGIN` equal to the deployed browser origin (no trailing slash).

Secrets remain server-only; neither the OpenAI key nor service-role key is passed
to the browser. No authentication provider or session database is added. Basic
auth is appropriate for a restricted demo, not a multi-tenant product. Browser
credential logout/change requires clearing site credentials or a new private
session. Do not share an admin credential with demo users.

## Database setup and migrations

For a **fresh, empty** Supabase project, execute `supabase-schema.sql` in the SQL
Editor. The bootstrap assumes `uuid_generate_v4()` is available (`uuid-ossp`,
provided in normal Supabase projects). For an existing installation run numbered
files in `migrations/` in order; if 001 is already applied, start at 002. Do not
rerun bootstrap over an existing installation. Migrations 003 onward are intended
to run once; there is no automatic migration ledger.

1. 001: spend precision, DECIMAL(10,2) → DECIMAL(14,6).
2. 002: atomic monthly initialization and increments.
3. 003: explicit request-run outcomes.
4. 004: telemetry versions, tiers and database access restrictions.
5. 005: normalized future model/tier accounting.
6. 006: routing decision reasons.
7. 007: verification jobs (removed by 013).
8. 008: analytics query (replaced by 012) and retention maintenance.
9. 009: tenants, per-tenant budgets and Postgres rate limits.
10. 010: provider attempts, request flags and stage timings, response cache.
11. 011: global spend spread over shard rows so concurrent requests stop queuing on one row.
12. 012: `gateway_dashboard`, the admin dashboard's aggregates and latency percentiles.
13. 013: drops the verification queue and the old stats query.

Apply migrations before deploying code, preferably with traffic paused because
005 changes an RPC signature. Existing monthly balances and budget limits are
preserved; historical model strings/logs are not rewritten. Legacy model counters
are frozen after 005; new model_usage counts start at migration time, not at the
beginning of historical records. See `migrations/README.md` and
`docs/IMPLEMENTATION.md` for validation limits.

## Retention

```sh
ROUTEWISE_MAINTENANCE=1 node --env-file=.env.local --import tsx scripts/maintenance.ts
```

Schedule maintenance daily or more often. It deletes telemetry after 30 days,
rate-limit windows after a day and expired cache entries. Telemetry tables have
RLS and server-only grants.

Normal request_runs stores **no raw query or response**. SHA-256 query hashes are
pseudonymous and susceptible to dictionary matching, not anonymization. Legacy
router_logs may contain raw prompts; maintenance applies the same 30-day policy.
No historic rows are deleted merely by applying a migration. Local eval/review
artifacts contain controlled prompts/answers and remain ignored by Git; manage
retention and access to those files separately.

## CI and verification

```sh
npm test
npm run typecheck
npm run lint
npm run migrations:check
npm run eval:regression
npm run experiment
npm run build
git diff --check
```

GitHub Actions runs these checks without production credentials. A separate
PostgreSQL 16 service tests migrations and 100 concurrent fractional-cent updates.
For local DB verification, point `ROUTEWISE_TEST_DATABASE_URL` to an **empty,
disposable** PostgreSQL database with permission to create roles/extensions and
set `ROUTEWISE_DB_TEST_DISPOSABLE=1`, then `npm run test:postgres`. Never use a
production database: this script bootstraps and inserts test records.

CI's versioned expectations currently cover six route cases and four deterministic
scoring fixtures. They are software test fixtures, not recorded model outputs or
human-reviewed benchmark evidence. The eventual 40–60 accepted CI benchmark
subset and 150–250 reviewed dataset remain human-review work.

An accepted live baseline gate is available with:
`npm run eval:compare -- BEFORE AFTER ACCEPTED_BASELINE.json`. The baseline file
must contain run_id, accepted_by, accepted_at, max_quality_drop and
max_cost_increase_fraction. No accepted baseline or arbitrary benchmark regression
tolerance is shipped. Ordinary CI asserts only explicit software expectations.
