# RouteWise V2

RouteWise explores the quality/cost tradeoff of routing requests between LLM
tiers. It retains a small Next.js Pages Router app, OpenAI integration and
Supabase/PostgreSQL. It now includes atomic accounting, protected APIs, explicit
request outcomes, versioned routing and offline evaluation tooling.

**No live benchmark has been run for this implementation. No quality parity,
cost reduction, routing accuracy, or human-reviewed dataset count is claimed.**
The starter dataset contains 12 generated, unreviewed cases.

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
7. 007: consent-based verification jobs and atomic worker claim.
8. 008: bounded analytics and retention maintenance.

Apply migrations before deploying code, preferably with traffic paused because
005 changes an RPC signature. Existing monthly balances and budget limits are
preserved; historical model strings/logs are not rewritten. Legacy model counters
are frozen after 005; new model_usage counts start at migration time, not at the
beginning of historical records. See `migrations/README.md` and
`docs/IMPLEMENTATION.md` for validation limits.

## Architecture and lifecycle

The browser calls protected Next.js API routes. The request handler coordinates:

validate → admission → routing → provider → usage capture → atomic accounting →
telemetry → response. Every routed request has a UUID. RequestRun stores actual
model, tier, difficulty, reasons, policy/pricing versions, tokens, cost, latency,
provider/application outcomes and failure stage/category.

Provider/usage failures are fatal, with unknown costs represented as null.
Accounting failure returns a valid answer with `accounting_status=failed` and
preserves captured usage for investigation. Telemetry failure does not discard
an answer; a sanitized console event identifies the request. If both accounting
and persistence fail, external provider billing/log reconciliation is necessary.
No automatic client or SDK retry is attempted. Admission still checks already
recorded spending; there is no reservation or guarantee against concurrent budget
overshoot. The displayed remaining budget is an estimate from the admission
snapshot, not an authoritative post-call balance.

## Budget/accounting design

PostgreSQL handles insert-on-conflict monthly creation and row-locked increments.
Monthly spend uses NUMERIC(14,6), preserving eight integer digits and six fractional
digits. `budget_limit` remains NUMERIC(10,2). Future model_usage rows accumulate by
UTC month, model ID and tier in the same transaction. Existing configured monthly
limits are not overwritten by environment changes. Default limit remains $100.

Routing becomes more conservative at 80%/90% usage; admission blocks at 100%.
The configured alert threshold controls warnings, not routing. No reservation,
settlement ledger, idempotency ledger or distributed rate limiter was added.
An uncertain RPC response requires reconciliation, not blindly replaying charges.
The legacy reset endpoint is protected but retains its known upsert semantics;
its dashboard button was removed. Resetting counters never reverses provider
charges or deletes telemetry.

## Model registry and routing policies

`lib/model-registry.ts` is the source of IDs, tiers, provider, prices, generation
settings and pricing version. Legacy defaults remain GPT-3.5 Turbo ($1.50/$2 per
million input/output tokens) and GPT-4 ($30/$60); these are project baseline
values, **not verified current prices or model availability**. Only OpenAI is
implemented. No fictional mid-tier model is supplied.

To configure current runtime IDs, set `ROUTEWISE_MODELS_JSON` to an array of
complete ModelConfig objects, each with `id`, `provider: "openai"`, `tier`,
`inputPricePerMillion`, `outputPricePerMillion`, `enabled`, `temperature`,
`maxOutputTokens`, and `pricingVersion`. Provide exactly one enabled low and high
model and optionally one mid model. Confirm compatibility with Chat Completions,
its temperature/token settings and structured JSON judging before opting into live
calls. Historical records keep their original IDs and prices. UI uses tier metadata
rather than inferring capabilities from model names.

**heuristic-v1** delegates to the original unchanged estimator/selector. All 130
T01 tests remain. Short-prompt exits, substring matching, calculate-before-math
and the unreachable high tier at >=90% remain baseline behavior.

**heuristic-v2** is an evidence-gated deterministic feature policy factory. It
extracts bounded length, constraints, multipart, code, structured-output and
reasoning features and emits explanations. Activation requires paired measured
failure evidence, explicit versioned weights/thresholds and a rationale. No tuned
configuration is shipped because no measured v1 failures exist yet. Production
uses v1. `--v2-config` and `--evidence-run` let the evaluator compare a future
configured v2. There is no claim that v2 is better. Learned-router interfaces
exist, but training is deferred until sufficient reviewed labels are available.

## Evaluation dataset and scoring

`eval/datasets/starter-v1.json` contains 12 generated cases across extraction,
formatting, classification, factual QA, summarization, coding, reasoning,
comparison, multi-constraint instructions and structured output. Each case has
versioned dataset membership, task/difficulty, scoring method and applicable
references/properties/rubric. All have `reviewed=false`.

A human must correct prompts, references and rubrics before promotion. The command
below requires explicit reviewer/date and writes a new version without overwriting
an existing file. It records the operator's attestation; it cannot verify that the
human actually reviewed the content.

```sh
npm run eval:promote -- INPUT.json OUTPUT.json NEW_VERSION REVIEWER ISO_DATE CASE_IDS --confirm-human-review
```

Deterministic methods handle normalized exact text/labels, fields (including false
and zero), JSON schema/value checks and formatting properties. The supported JSON
schema subset is type, required, properties, items, enum and additionalProperties.
Coding cases remain unscored unless a safe named executable fixture is supplied;
the CLI never executes arbitrary generated code. This is a deliberate limitation,
not a simulated coding benchmark.

Rubric cases alone can use a separate configured judge, temperature 0, strict JSON
score/reason validation, with judge ID/version/usage/cost recorded. Invalid output
has null quality. Judging requires both live opt-in and `--judge`; model judges
are fallible and need the human validation workflow.

## Running offline evaluations

```sh
npm run eval -- --dataset starter-v1 --dry-run
npm run eval -- --strategy low-only,high-only,heuristic-v1 --limit 3
npm run eval:regression
```

Without `ROUTEWISE_LIVE_EVAL=1`, eval is a routing-only dry run: no provider calls,
no fabricated response, latency, cost or quality. Run JSON goes to ignored
`eval/runs/` (override with `--out`). It records run/time/Git/dataset/policy/pricing
versions and runtime model settings. Mid-only fails unless a mid model exists.

## Explicitly opted-in live evaluation

CLI commands read process environment, not Next.js environment files automatically.
Export required configuration or use Node's env-file support:

```sh
ROUTEWISE_LIVE_EVAL=1 node --env-file=.env.local --import tsx scripts/eval.ts --dataset starter-v1 --limit 3
ROUTEWISE_LIVE_EVAL=1 node --env-file=.env.local --import tsx scripts/eval.ts --dataset starter-v1 --limit 3 --judge
```

The second command also needs `ROUTEWISE_JUDGE_MODEL` naming an enabled registry
model. These commands **spend money**. In CI, live calls are blocked regardless of
opt-in. Live evaluations are separate from production monthly accounting; use
small limits and provider-side spending controls. There is no evaluation dollar
reservation. Each strategy performs a separate call; failures are not retried.

## Benchmark methodology and reports

```sh
npm run eval:report -- RUN.json
npm run eval:compare -- BEFORE.json AFTER.json
npm run eval:failures -- RUN.json eval/datasets/starter-v1.json
npm run eval:pareto -- RUN.json
```

Reports produce JSON/CSV/Markdown: mean quality, quality by task/difficulty,
scored/total coverage, costs/projection per 1,000 requests, p50/p95 latency and
model/tier distribution. Unknown cost is not silently zero; known spend is shown
separately. Judge spend is separate from inference spend. Percentiles use nearest
rank. Compare identical datasets/case sets with comparable scored coverage and
recorded configuration; investigate differences in errors and missing scores.
Run comparison reports quality/cost/latency/failure/distribution deltas. Repeated
live runs and human validation are needed before conclusions about superiority.

Failure reports require actual paired routed/high-only scores, retain reasons,
and label observed task attributes where supported. A positive gap is a likely
failure signal, not proof of a causal router defect. Empty evidence yields no
invented categories.

Pareto output requires fully scored matching live case sets, including high-only.
It plots total inference cost against mean quality and identifies nondominated
points. Quality parity is routed quality / high-only quality; cost reduction is
1 - routed cost / high-only cost. Zero denominators are unavailable. No chart is
created for dry runs or incomplete evidence.

## Human judge validation

```sh
npm run eval:review -- export RUN.json DATASET.json REVIEW.json 20
npm run eval:review -- compare REVIEW.json
```

Export samples deterministically by hashed run/case/strategy identity and leaves
human_score, human_notes, reviewer and reviewed_at empty. Humans fill them in.
Comparison reports paired count, per-case absolute disagreement, mean absolute
disagreement and the fraction within 0.1. Empty reviews are never interpreted as
zero. Do not promote model-judge scores to human labels.

## Async verification and retention

Verification is disabled by default. Enabling `ROUTEWISE_VERIFICATION_ENABLED=1`
and a sample rate (default target 0.15) still requires request `verify_consent=true`.
The query page offers an explicit opt-in checkbox. A durable verification_jobs
row stores prompt/answer with a 24-hour expiry. The response waits only for the
small database enqueue; it does not wait for a model verification result.

```sh
ROUTEWISE_VERIFICATION_WORKER=1 node --env-file=.env.local --import tsx scripts/verification-worker.ts
ROUTEWISE_MAINTENANCE=1 node --env-file=.env.local --import tsx scripts/maintenance.ts
```

The worker also requires verification enabled and an explicit
`ROUTEWISE_VERIFICATION_MIN_SCORE` (0..1). It processes one job per invocation,
with an enabled high-tier verifier, atomic SKIP LOCKED claim and no automatic
retry after uncertain outcomes. Schedule repeated invocations with your existing
cron/host scheduler; no Redis, Kafka or unreliable fire-and-forget is used.
Verifier costs are included in monthly accounting. Scores are automated opinions;
quality_gap remains null without a second comparable score.

Schedule maintenance frequently (e.g. every five minutes) to clear expired or
interrupted jobs and delete telemetry after 30 days. Payload expiry is 24 hours;
physical deletion happens at the next successful maintenance run, not exactly at
the expiry instant. A crashed claimed job is marked failed after 15 minutes; do
not blindly replay paid calls. Jobs and telemetry have RLS/server-only grants.

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

## Security, tradeoffs and limitations

- Shared demo/admin access is minimal; there are no individual users or per-user budgets.
- Rate limits are bounded per-process buckets (demo 10/min, admin 60/min, attempts
  120/min), not distributed throttling. Instances/restarts reset them. API query
  bodies are limited to 20KB and queries to 16K characters. POST origin checks
  reject cross-site requests; same-origin CLI requests may omit Origin.
- Provider call timeout is 60 seconds and SDK retries are disabled. Client retries
  are new billable requests. No idempotency guarantee or spending reservation.
- PostgreSQL increments prevent lost updates, but already-lost historic spending
  cannot be recovered. Sub-micro-dollar values still round at six decimal places.
- JavaScript uses binary floating point; exact decimal/integer-unit arithmetic
  is not introduced. Costs are estimates from versioned configured prices.
- Telemetry/worker persistence failures and unknown provider outcomes still need
  operator reconciliation. No external alert delivery is installed.
- Deployment must apply migrations and schedule cleanup/worker commands. No
  production Supabase migration or live benchmark was executed by this work.
- Current model availability/pricing must be checked by the operator. Broad
  dependency upgrades were intentionally avoided; installation reported existing
  security audit findings. T01's stale Browserslist warning remains.

See `docs/DECISIONS.md` for architecture decisions and `docs/IMPLEMENTATION.md`
for the phase record, preserved baselines, verification results and deferred work.
