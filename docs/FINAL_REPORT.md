# RouteWise V2 final engineering report

## A. Final architecture
Next.js Pages Router and Supabase retained. Protected query/admin APIs use a typed
request lifecycle, versioned routing, central registry, OpenAI adapter, atomic
PostgreSQL accounting and minimized telemetry. Separate CLI modules handle
controlled evaluation artifacts. Optional durable verification jobs use an
explicit worker/cron invocation, not fire-and-forget.

## B. Files added/changed
See [FILES.md](FILES.md) for every tracked change and new source file. The inventory
includes the pre-existing uncommitted T01/T02 baseline; those changes were retained.
Main additions are request-run/access/registry/policy modules, eight migrations,
evaluation modules and commands, 20 test files, SQL integration checks, CI and
operator/decision documentation. No repository rewrite or production deployment.

## C. Migrations
001 precision; 002 atomic accounting; 003 request runs; 004 metadata/privacy;
005 normalized model usage; 006 routing reasons; 007 verification jobs;
008 SQL analytics and retention. Bootstrap includes the final schema. Historic
balances, limits and model strings remain preserved. Migration 005 changes the
accounting RPC signature; pause traffic while deploying migrations/code.

## D. Tests
216 tests passed across 20 files. The original 130 T01 tests remain. T02's nine
arithmetic characterization tests were retained against a clearly frozen legacy
implementation because T03 intentionally replaced the application read/modify/write.
Current integration tests verify atomic RPC usage, lifecycle partial failures,
auth/rates, registry, policy parity, evaluation safety/scoring/reporting and jobs.
Real PostgreSQL 16 checks also passed for all migrations, precision, concurrent
updates, fresh bootstrap, permissions, analytics, claims and retention.

## E. Build/lint/typecheck
`npm test`, `npm run typecheck`, `npm run lint`, `npm run build`,
`npm run migrations:check`, `npm run eval:regression`, and `git diff --check` passed.
Lint has one pre-existing plain-link warning, down from two. Build retains the
stale Browserslist warning. Node 24.18.0/npm 12.0.2 were used. Broad dependency
upgrades were avoided; tsx was the only new direct dependency beyond T01 tooling.

## F. Router v1 preservation / intentional changes
`lib/difficulty-estimator.ts` is unchanged; heuristic-v1 delegates to it. Legacy
price assertions pass. Explicit runtime registry configuration can change live
model IDs without rewriting historical records. Intentional V2 changes include
protected access, finite admission data validation, size limits, UTC accounting,
truthful partial-failure outcomes, no zero-cost fabrication, SDK retry disabling,
minimized telemetry and normalized accounting. These are documented and tested.

## G. Router v2 design
A deterministic feature policy factory supports bounded length, constraints,
multipart, code, structured output and reasoning indicators with explicit weights,
thresholds, version, evidence-run ID and rationale. It refuses activation without
paired measured failure evidence. No tuned configuration or quality improvement
claim is shipped; production remains v1. Learned-router interfaces exist, but
training is deferred because all starter cases are unreviewed.

## H. Evaluation commands
`eval`, `eval:report`, `eval:compare`, `eval:failures`, `eval:pareto`,
`eval:review`, `eval:promote`, and `eval:regression` are npm scripts. See README for
arguments. The runner stores dataset/Git/policy/model/pricing versions and raw
controlled evaluation responses. Reports include explicit score coverage and
unknown costs. Dry runs contain no fabricated measurements.

## I. Live-eval safety
Provider evaluation requires ROUTEWISE_LIVE_EVAL=1 outside CI; --dry-run always
prevents calls. Rubric judging also needs --judge and a configured judge model.
CI blocks live execution even with opt-in. Tests inject mocks. No live provider,
judge or verifier was called during implementation.

## J. CI behavior
Actions runs offline tests/types/lint/build/static migrations/routing regression
without model secrets. A separate PostgreSQL service runs real migration and
concurrency tests. YAML was parsed/checked locally; hosted Actions has not run.
Ten initial route/scorer fixture cases are explicitly synthetic software
expectations, not model benchmark records. Live baseline gates need an accepted
run and operator-supplied tolerances; no benchmark threshold was invented.

## K. Security changes
Server-only shared admin/demo Basic credentials, HTTPS requirement, role checks,
POST origin checks, body/query limits and bounded per-instance rate limits.
Database RLS/revocations require service-role access. Production telemetry omits
raw prompts/responses. Temporary verification payloads require consent and expire
at 24 hours; scheduled cleanup enforces deletion. Basic auth is deliberately a
restricted-demo solution, not multi-user identity or a distributed quota system.

## L. Accounting changes
Monthly NUMERIC(14,6) spend and unchanged NUMERIC(10,2) limits. PostgreSQL atomic
initialization/increments preserve balances and update model/tier totals in one
transaction. Real concurrent tests passed. Legacy fixed counters are frozen,
not reinterpreted. No reservation or idempotency ledger was introduced.

## M. Manual Supabase/deployment steps
Apply numbered migrations once (start at 002 if 001 is already deployed), or run
bootstrap only for a fresh empty project. Configure server secrets and HTTPS
origin. Review model compatibility and prices. Deploy code with migrations.
Schedule retention maintenance and, only if wanted, the consent-based worker.
No production database was modified here. Do not run disposable DB tests against
Supabase production. Existing reset API behavior still requires care.

## N. Remaining human-review work
Review/correct starter prompts, references and rubrics; promote with genuine
reviewer/date metadata; expand toward the requested reviewed dataset size. Review
judge outputs with the empty-score export workflow. No generated case has been
marked human-reviewed.

## O. Remaining live benchmark work
Explicitly opt into matched low/high/v1 runs (mid only if configured), complete
scoring/human calibration, inspect failures, accept a versioned baseline, then
choose v2 weights and compare. Generate Pareto data only from complete paired
live results. No quality parity, savings, accuracy or failure-rate claim is made.

## P. Deferred features and why
Tuned v2/default promotion, learned training, accepted benchmark thresholds and
larger reviewed/CI benchmark sets await measured/reviewed evidence. Coding execution
is unscored until a safe isolated fixture exists. Optional verification is disabled
until configured/consented. Existing deployment, rate-distribution, decimal
rounding below six places, uncertain paid-call outcomes and manual reconciliation
limits remain documented rather than concealed by fake implementations.
