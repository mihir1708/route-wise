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

## Gateway API: `POST /api/generate`

Tenants call one endpoint with their own API key. The key identifies the tenant;
the request body cannot name one.

```sh
curl -X POST https://<host>/api/generate \
  -H "Authorization: Bearer rw_xxxxxxxx_..." -H "Content-Type: application/json" \
  -d '{"task_type":"classify","input":"I was charged twice for order 1182","priority":"normal","max_cost_usd":0.01}'
```

| Field | Required | Meaning |
| --- | --- | --- |
| `task_type` | yes | `classify`, `extract`, `summarize`, `draft_reply`, `troubleshoot` or `chat` |
| `input` | yes | Up to 16,000 characters |
| `priority` | no | `low`, `normal` (default) or `high`; moves the routed tier down or up one step; `high` also bypasses the cache |
| `max_cost_usd` | no | Routing steps down to the most capable tier whose worst-case cost fits; 402 if none does |
| `latency_target_ms` | no | 500 to 120,000; at 3,000 or less the high tier is skipped, and retries never wait past it |
| `prompt_version` | no | e.g. `summarize@v1`; defaults to the newest version of the task's template |
| `cache` | no | `false` skips the response cache (default `true`) |

Unknown fields are rejected. A success returns `answer` (and `output`, the parsed
JSON, for `classify` and `extract`) plus `metadata` with the model, tier,
provider, prompt version, route reasons, tokens, `cost_usd`, `latency_ms`,
`cache_hit`, `fallback_used`, `escalated`, the number of provider attempts and the
tenant's remaining budget. Errors return `{error, request_id}`: 400/413 invalid
input, 401 bad key, 402 tenant budget or `max_cost_usd`, 429 rate limit (with
`Retry-After`), 502 when every provider failed (`all_providers_failed`) or the
answer never matched its schema (`invalid_model_output`), 503 global budget or a
dependency outage. Rejections after authentication are logged
in `request_runs` with the stage that stopped them.

Each tenant has a monthly budget, requests-per-minute and tokens-per-minute
limits, and the tiers it may use. Limits are counted in Postgres, so they hold
across serverless instances. Tokens are reserved before the call (estimated input
plus the output cap) and corrected to actual usage afterwards. Tenant spend and
global spend are charged in one transaction. Create a tenant (the key is printed
once; only its SHA-256 hash is stored):

```sh
npm run tenant:create -- --name acme --budget 5 --rpm 30 --tpm 20000 --tiers low,mid,high
```

### Models and tiers

Three tiers, each with an OpenAI primary and an Anthropic fallback (prices in USD
per million input/output tokens, checked 2026-10-05; `lib/model-registry.ts`):

| Tier | Primary | Fallback |
| --- | --- | --- |
| low | `gpt-5.6-luna` ($0.20 / $1.20), reasoning off | `claude-haiku-4-5` ($1 / $5) |
| mid | `gpt-5.6-terra` ($2 / $12), low reasoning | `claude-sonnet-5-5` ($2 / $10), thinking off |
| high | `gpt-5.6-sol` ($5 / $30), low reasoning | `claude-opus-5-5` ($4 / $20), low effort |

Reasoning models are billed for hidden reasoning tokens, so each model can declare
`reasoningHeadroomTokens`; it is added to the provider's output cap and to every
worst-case cost and token reservation. Override the registry with
`ROUTEWISE_MODELS_JSON` (one enabled model per tier per provider; the first
enabled model of a tier is the primary).

### Routing: rules-v1

Each step that changes the tier adds a line to `route_reasons`:

1. Start at the task's tier: classify and extract low; summarize and draft_reply
   mid; troubleshoot high.
2. Ticket difficulty (0 to 1, from named signals: long thread, error output, many
   questions, high stakes such as outages or security, "already tried"). Extract,
   summarize and draft_reply move up a tier at 0.6 or more; a short troubleshoot
   ticket with no signals moves down to mid.
3. Priority `high` moves up one tier; `low` moves down one.
4. A latency target of 3,000 ms or less caps the tier at mid.
5. With 90% of the global monthly budget spent, non-high-priority requests move
   down one tier.
6. The tenant's allowed tiers: the nearest usable tier, cheaper on ties.
7. `max_cost_usd`: the most capable allowed tier whose worst case fits.

`chat` keeps the original heuristic-v1 router. Prompt templates live in
`prompts/`; their system text never contains request input, so it is a stable
prefix for providers' prompt caching.

### Reliability

Provider errors are normalized (rate limited, overloaded, server, timeout,
network, auth, bad request, refused, empty). Transient ones are retried once on
the same model with full-jitter exponential backoff (250 ms base, 2 s cap,
`Retry-After` respected; a longer `Retry-After` goes straight to the fallback).
Then the other provider in the same tier is tried. A per-model circuit breaker
opens after 5 consecutive transient failures, skips the model for 30 seconds,
then lets one probe through; its state is per server instance. Both SDKs run with
their own retries off, so every call is visible in `request_attempts`.

`classify` and `extract` answers are checked against the template's JSON schema.
An answer that fails is escalated once to the next tier up the tenant may use,
if its worst case still fits the budget and `max_cost_usd`; both calls are
charged.

### Response cache

Successful answers are cached per tenant for `ROUTEWISE_CACHE_TTL_S` seconds
(default 86,400; `0` turns the cache off), keyed by a SHA-256 of the prompt
version and the exact input. A hit skips budget, routing and the provider, costs
nothing and refunds the token reservation; it still counts against the request
rate limit. The cache stores the answer text but never the input. Priority `high`,
`"cache": false` and the chat UI always get a fresh answer. Expired entries are
deleted by `maintain_retention()`.

### Telemetry

Each request writes one `request_runs` row (now with `cache_hit`,
`fallback_used`, `attempt_count` and per-stage `stage_timings` in milliseconds)
and one `request_attempts` row per provider call: model, provider, outcome,
error kind, HTTP status, latency, tokens and cost. Neither holds prompt or answer
text.

The chat UI (`/api/route-query`) is a thin wrapper that runs `chat` tasks as the
built-in `demo` tenant, which migration 009 creates with a $1 monthly budget.

## Routing experiment: `npm run experiment`

The experiment asks whether rules-v1 routing keeps quality while cutting cost. It
sends the same 45 support tickets (`experiment/benchmark-v1.json`, 15 each of
simple, standard and complex) through the real gateway code under three configs:

| Config | Allowed tiers |
| --- | --- |
| all-premium | high only |
| routed | low, mid and high; rules-v1 decides |
| all-small | low only |

Every config sends the same request body; only the tenant's allowed tiers differ,
so retries, fallback, validation and escalation behave as in production. An item
succeeds when the gateway answers, the answer is right (exact field match for
classify and extract, a rubric judge score of at least 4/5 otherwise) and it stays
within the item's cost and latency limits. Failures count; nothing is dropped.

```sh
npm run experiment                      # dry run: routing plan, cost estimate, readiness; no calls
node --env-file=.env.local --import tsx scripts/experiment.ts --live            # the pre-registered run
node --env-file=.env.local --import tsx scripts/experiment.ts --live --limit 1  # smoke run, 3 items per config
```

`experiment/preregistration.md` fixes the question, success rule, judge and bar
before any live call: routed success may be at most 3 points below all-premium,
overall and in each class. It also pins the dataset hash, prompt versions, routing
policy, models and pricing. A full live run refuses to start unless every item is
reviewed, the pinned values match the code, someone has approved the
pre-registration and the working tree is committed. Savings are reported only
when routed meets the bar on the full approved run. Live runs never run in CI,
always ask for a typed `yes` (or `--yes`), and stop at a hard spend limit
(`--budget`, defaulting to the dry run's upper bound). Results go to
`experiment/results/` as JSON and a Markdown table.

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
9. 009: tenants, per-tenant budgets and Postgres rate limits.
10. 010: provider attempts, request flags and stage timings, response cache.

Apply migrations before deploying code, preferably with traffic paused because
005 changes an RPC signature. Existing monthly balances and budget limits are
preserved; historical model strings/logs are not rewritten. Legacy model counters
are frozen after 005; new model_usage counts start at migration time, not at the
beginning of historical records. See `migrations/README.md` and
`docs/IMPLEMENTATION.md` for validation limits.

## Architecture and lifecycle

The browser calls protected Next.js API routes. The request handler coordinates:

validate → rate limit → cache → admission → routing and cost check → provider
(retries and fallback) → usage capture → output validation (and escalation) →
atomic accounting → telemetry → response. Every routed request has a UUID. RequestRun stores actual
model, tier, difficulty, reasons, policy/pricing versions, tokens, cost, latency,
provider/application outcomes and failure stage/category.

Provider/usage failures are fatal, with unknown costs represented as null.
Accounting failure returns a valid answer with `accounting_status=failed` and
preserves captured usage for investigation. Telemetry failure does not discard
an answer; a sanitized console event identifies the request. If both accounting
and persistence fail, external provider billing/log reconciliation is necessary.
SDK retries are off; the gateway's own retries and fallback are described above. Admission still checks already
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
The configured alert threshold controls warnings, not routing. Per-tenant rate limits are counted in Postgres (migration 009). There is no
spend reservation, settlement ledger or idempotency ledger.
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
