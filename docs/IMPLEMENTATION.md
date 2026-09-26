# V2 implementation record

## T03 — atomic accounting
PostgreSQL RPC performs increments under the row lock and initializes months with
ON CONFLICT DO NOTHING. Existing budget limits survive initialization. Migration
002 and bootstrap contain the operation. No reservations were introduced.
T02's nine arithmetic tests now target a clearly frozen legacy implementation;
new tests assert concurrent application calls send increments, not stale totals.
These mocked tests do not prove PostgreSQL concurrency; use the optional database
integration workflow documented below when a disposable PostgreSQL is available.

## T04 — explicit request lifecycle
Validation/admission/routing/provider/usage/accounting/telemetry/response stages
now share a request ID. Missing usage is fatal and unknown, provider failures keep
the real selection, and accounting failure preserves the answer with a failed
accounting status. Telemetry failure is non-fatal. Remaining budget is a snapshot
estimate, not a reservation. New request_runs records are separate from legacy
router_logs; history is not rewritten. Partial failures have offline tests.

## T05 — access protection
HTTP Basic auth protects pages and APIs; server-only random passwords have demo
and admin roles. Native browser login works locally with no client secret bundle.
No default password or anonymous bypass. HTTPS is required in deployment. POST
origin checks, a 20KB body cap, 16K character cap, and bounded in-process rate
buckets limit abuse. Rate counters are per instance (not a distributed quota).
Existing data tables are locked down by the next telemetry migration.

## T06 — trustworthy telemetry
One RequestRun type now holds versions, tiers, budget-at-route, usage, outcomes,
and error stage/category. No raw production query or response is retained in this
table. SHA-256 hashes are pseudonymous, not anonymous (guessable prompts remain
matchable). Keep telemetry 30 days via the maintenance command added below.
Legacy router_logs still contains historic raw prompts: operators must review
and purge it according to their policy; migration does not silently delete it.
RLS and revocations remove anonymous access; server credentials are now required.
Missing provider usage no longer becomes zero. SDK retries disabled to avoid
hidden duplicate charges; timeout is explicit. Build imports require no secrets.

## T07 — model registry
Legacy prices live once in the typed registry. Explicit server JSON configuration
can replace runtime model IDs/prices with an operator version; no unverified
claim is made about current provider availability. Mid tier is absent unless a
real enabled model is configured. Migration 005 records future usage by month,
model and tier atomically. Legacy fixed counters remain frozen, with no inferred
historical per-model costs. API, pricing and model client use registry settings.

## T08 — versioned routing
heuristic-v1 delegates directly to the unchanged estimator and selector. Its
result records tier, model, policy version and score/length/budget reasons.
Boundary parity tests supplement (not replace) the original 110 routing tests.

## T09 — evaluation dataset
Versioned starter-v1 has twelve generated cases across ten task types. Every
case is unreviewed. Dataset validation requires provenance before reviewed=true.
Promotion means editing/correcting the case, adding reviewer/date, and creating a
new dataset version; tooling never assigns a human identity automatically.
The eventual 150–250 reviewed case target is not met or claimed.

## T10 — offline/live runner
The CLI emits versioned run metadata and routing decisions by default, with null
quality/cost/latency (not invented measurements). Only ROUTEWISE_LIVE_EVAL=1 and
non-CI execution permit provider calls. Limits and tier configuration validate
before calls. Runtime model settings/prices, Git commit and dataset version are
stored. Evaluation artifacts are local, ignored by Git, and separate from
production telemetry. No live calls were made during implementation.

## T11 — task-aware scoring
Exact labels/text, field correctness, bounded JSON-schema subset and formatting
properties are deterministic and normalized to 0..1. Coding is explicitly
unscored without an approved isolated fixture; no arbitrary generated code is
executed. Rubrics alone may use a separately configured strict-JSON, temperature-0
judge under the live-eval gate. Invalid judge output retains its usage/cost but
has null quality. Unsupported provider structured-output settings fail visibly.

## T12 — human validation workflow
Deterministic sampling exports empty human fields alongside model outputs.
Comparison requires explicit reviewer/date and reports paired count, absolute
disagreement and mean disagreement. Empty reviews are not zero scores. No human
review artifact was generated or marked reviewed by this implementation.

## T13 — benchmark reports
JSON/CSV/Markdown report commands compute quality with explicit scoring coverage,
by-task/difficulty means, complete-vs-known cost, projections, nearest-rank p50/p95
and model/tier distribution. Judge costs are separate. Dry runs produce no metric
points. No live benchmark or savings claim was generated.

## T14 — measured failure analysis
Only paired, completed, scored high-only/routed records yield likely failure
cases. Reports include quality gap and route reasons; categories describe
observable task attributes rather than asserting causality. Without measured
outputs the report is empty, not a fabricated analysis.

## T15 and optional learned experiment — evidence-gated fallback
A deterministic feature-based v2 policy factory supports length, explicit
constraints, multipart structure, code, structured output and reasoning features.
It refuses activation without paired measured failure evidence, a versioned
configuration and rationale. No tuned weights/default configuration is shipped:
there is no real benchmark to justify them. Production remains heuristic-v1.
The CLI can compare a future configured v2 to v1. Tests use clearly synthetic
unit fixtures, never exported as benchmark data. Learned-router interfaces exist;
training is deferred because all current starter cases are unreviewed.

## T16 — durable optional verification
Disabled-by-default sampling requires explicit request consent. A database job
holds prompt/answer for up to 24 hours; the response waits only for enqueue, not
for a verifier. An explicit worker claims one row with SKIP LOCKED, uses a high
tier judge, accounts its spend, and removes payload on completion/failure.
Crashed jobs are not automatically retried (unknown paid-call outcome); cleanup
marks stale jobs failed. Run maintenance regularly to enforce retention. Scores
are automated opinions, not human labels; quality_gap is null without comparison.

## T17 — CI regression gate
GitHub Actions runs unit/offline tests, types, lint, build and static migration
checks without credentials or paid calls. A separate disposable PostgreSQL job
checks real migrations, precision, preserved balances and concurrent increments.
Local mocked tests do not stand in for that database job. Versioned CI fixtures
are explicitly synthetic software expectations (6 routes + 4 scorer cases), not
recorded model outputs; the eventual 40–60 accepted benchmark subset is deferred.
No benchmark quality/cost threshold has been invented; baseline acceptance tooling
is added with run comparison below.

## Phase 17 — run comparison and accepted baseline gate
Comparison requires matching dataset and case/strategy sets, reports quality,
cost, latency, routing-failure and distribution deltas, and flags configuration
changes. Quality deltas require matching scored coverage. Optional regression
gates require an explicitly accepted run and operator-supplied tolerances; no
accepted baseline or numeric tolerance is supplied by the implementation.

## Phase 18 — Pareto output
JSON point data and SVG generation require fully scored matching live case sets
and a high-only reference. The command emits no chart for dry/incomplete runs.
Quality parity and cost reduction handle zero denominators as unavailable. No
chart or claimed performance point was generated without actual benchmarks.

## Phase 19 — analytics and retention
SQL aggregates one UTC month and limits recent rows to twenty. The dashboard
shows captured query cost separately from accounted spend (including verification),
actual configured budget limits, failures, policy/tier/model distribution, and
unknown usage. It never mixes evaluation records into production analytics.
Retention maintenance deletes telemetry/legacy logs after 30 days and clears
expired/interrupted job payloads; deployment must schedule it. The dashboard reset
button was removed to avoid presenting the known legacy reset as a safe erasure.
The protected reset API remains available with its existing semantics.

## Phase 20 — operator documentation
README covers local auth/setup, all eight migrations, registry/runtime limits,
offline/live/judge commands, dataset promotion, review, benchmark reporting,
Pareto methodology, async verification and retention scheduling. ADRs record why
Next.js/Supabase and atomic SQL were retained and why no Redis or fabricated
benchmarks were added. Legacy README's unsupported 80%-quality claim was removed.

## Phase 21 — final verification
- 216 tests across 20 files passed, including the original 130 T01 cases and the
  preserved nine T02 legacy characterization cases.
- Typecheck passed. Lint passed with one remaining pre-existing plain-link warning
  (the admin rewrite removed the other). Production build passed with the existing
  stale Browserslist dataset warning.
- All eight migrations match bootstrap via static checks; git diff --check passed.
- Real PostgreSQL 16 in a disposable Docker container passed the complete
  integration script: migration application, existing-value preservation,
  NUMERIC precision, 100 concurrent updates, normalized model totals, fresh
  bootstrap, anonymous access restrictions, SQL analytics, job claims and
  dependent retention. The container was stopped/removed afterward.
- GitHub Actions YAML parsed locally and its offline gate/Postgres service were
  checked. The hosted Actions workflow has not been dispatched.
- Offline CLI smoke tests covered dry run, JSON/CSV/Markdown report, run comparison,
  empty failure analysis, empty human-review export/comparison, and Pareto refusing
  to create a chart without live evidence. Outputs were written under /tmp.
- No paid model/judge/verifier calls, real human labels, or live benchmark metrics
  were generated. No production Supabase state was changed.

### Final deferred work and limits
Heuristic-v2 tuning/default promotion, learned training, 150–250 reviewed cases,
the eventual 40–60 accepted benchmark CI subset, coding execution fixtures and
accepted live regression tolerances require evidence/review that does not exist
in this repository. Interfaces, commands and gates are implemented; pretending
these were completed would fabricate results. Production remains heuristic-v1.
Atomic accounting is not reservation/idempotency: concurrent admission may exceed
a budget and uncertain provider/accounting outcomes require reconciliation.
