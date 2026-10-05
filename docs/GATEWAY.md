# How the gateway works

Reference for the gateway's API, routing rules, reliability, cache, telemetry and accounting. The [README](../README.md) has the overview.

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
`cache_hit`, `fallback_used`, `escalated`, `truncated` (the answer stopped at the
output cap), the number of provider attempts and the tenant's remaining budget.
Tokens a provider bills for a failed call, such as an empty or refused answer, are
charged like an answer. Errors return `{error, request_id}`: 400/413 invalid
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
and `"cache": false` always get a fresh answer. The demo page uses the cache, so
repeated sample tickets cost nothing. Expired entries are
deleted by `maintain_retention()`.

### Telemetry

Each request writes one `request_runs` row (now with `cache_hit`,
`fallback_used`, `attempt_count` and per-stage `stage_timings` in milliseconds)
and one `request_attempts` row per provider call: model, provider, outcome,
error kind, HTTP status, latency, tokens and cost. Neither holds prompt or answer
text.

The demo page's endpoint (`/api/route-query`) runs any task as the built-in
`demo` tenant, which migration 009 creates with a $1 monthly budget and 10
requests a minute, and returns the same body as `/api/generate`. The admin
dashboard reads `gateway_dashboard` (migration 012), which computes counts,
rates and p50/p95 latency in Postgres for a window of whole UTC days.

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

## Security, tradeoffs and limitations

- Shared demo/admin access is minimal; there are no individual users. Tenant
  budgets and rate limits are enforced in Postgres.
- Access limits are bounded per-process buckets (demo 10/min, public-demo visitor
  5/min, admin 60/min, attempts 120/min), not distributed throttling. Instances/restarts reset them. API query
  bodies are limited to 20KB and queries to 16K characters. POST origin checks
  reject cross-site requests; same-origin CLI requests may omit Origin.
- Provider call timeout is 60 seconds and SDK retries are disabled. Client retries
  are new billable requests. No idempotency guarantee or spending reservation.
- PostgreSQL increments prevent lost updates, but already-lost historic spending
  cannot be recovered. Sub-micro-dollar values still round at six decimal places.
- JavaScript uses binary floating point; exact decimal/integer-unit arithmetic
  is not introduced. Costs are estimates from versioned configured prices.
- Telemetry persistence failures and unknown provider outcomes still need
  operator reconciliation. No external alert delivery is installed.
- Deployment must apply migrations and schedule the maintenance command.
- Current model availability/pricing must be checked by the operator. Broad
  dependency upgrades were intentionally avoided; installation reported existing
  security audit findings. T01's stale Browserslist warning remains.
