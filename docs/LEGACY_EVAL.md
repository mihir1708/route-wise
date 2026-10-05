# Legacy evaluation tooling

These tools come from RouteWise's first version, before the gateway. They still work and are tested, but the [routing experiment](EXPERIMENT.md) replaced them for measuring the gateway.

## Legacy registry and evaluation policies

The gateway's models are listed under [Models and tiers](GATEWAY.md#models-and-tiers).
`lib/model-registry.ts` also keeps the V1 registry, GPT-3.5 Turbo ($1.50/$2 per
million input/output tokens) and GPT-4 ($30/$60), for historical records and the
older `npm run eval` tooling described below; those prices are the project's
original baseline values, not current ones.

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
configured v2. There is no claim that v2 is better.

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
