# RouteWise routing experiment: pre-registration

Written before any live model call. `npm run experiment -- --live` checks the pinned values below against the code and data, and refuses to run if any differ or if the experiment is not approved. Changing anything pinned after approval means a new approval, and every earlier result is kept.

## Question

Does rules-v1 routing keep the success rate within 3 points of sending every request to the premium tier, without losing more than one ticket-run in any class, and how much does it cut the cost per successful task?

## Pinned values

- Dataset: `support-v1`
- Dataset SHA-256: `fa31f71b8326d57caf233635e317c35fe30a8687648b265982f792f1e5ed1870`
- Configs: `all-premium=high; routed=low+mid+high; all-small=low`
- Prompts: `classify@v2, draft_reply@v1, extract@v2, summarize@v1, troubleshoot@v1`
- Routing policy: `rules-v1`
- Models: `low: gpt-5.6-luna > claude-haiku-4-5; mid: gpt-5.6-terra > claude-sonnet-5-5; high: gpt-5.6-sol > claude-opus-5-5`
- Pricing: `gateway-2026-10`
- Judge: `support-judge-v1 on claude-sonnet-5-5 > gpt-5.6-terra, pass at 4/5`
- Bar: `routed success at most 3 points below all-premium overall, and at most 1 ticket-run below in each class`
- Runs: `2`

The dataset hash covers the file's exact bytes, including each item's review record. It was pinned after the review was recorded.

## Dataset

`experiment/benchmark-v1.json`: 45 synthetic support tickets for Ledgerly, a fictional invoicing and payments product. There are 15 items per class.

- **Simple:** 8 classify and 7 extract items, scored by exact match against expected values. Case, surrounding whitespace, repeated spaces and trailing full stops are ignored. Each field has exactly one accepted value.
- **Standard:** 8 summarize items, plus 7 draft_reply items that include knowledge-base excerpts. These are scored by the rubric judge.
- **Complex:** 10 troubleshoot items and 5 policy or edge-case draft_reply items, scored by the rubric judge.

Eleven items carry a non-normal priority, as real traffic would: 7 high in complex, 1 high in simple, and 3 low in standard. Each item has a cost and latency limit for its class: $0.10 and 30 s for simple, $0.15 and 45 s for standard, $0.25 and 90 s for complex. The limits are generous on purpose, so the all-premium worst case fits and the comparison is about quality rather than limits.

Mihir Mukhi reviewed every item on 2026-10-05, before any live call, and the reviewer and date are recorded on each item. The review set one accepted product name per extract item and rewrote the status criteria of four summaries (summarize-01, -04, -05 and -08).

## Configs

Every config sends the same request body: task type, input, priority, max_cost_usd, latency_target_ms, and the cache turned off. Only the tenant's allowed tiers differ.

- **all-premium:** high tier only (gpt-5.6-sol, with claude-opus-5-5 as its fallback).
- **routed:** all tiers, and rules-v1 chooses.
- **all-small:** low tier only (gpt-5.6-luna, with claude-haiku-4-5 as its fallback).

Requests go through the production gateway code (`executeGenerate`), with retries, provider fallback, schema validation and one-tier escalation exactly as in production. An in-memory ledger replaces Postgres. Escalation can only happen in routed, because all-premium is already at the top tier and all-small has no higher tier allowed. Configs are interleaved item by item, with 4 requests in flight at a time.

## Success

An item succeeds only when all four hold:

1. The gateway returned 200.
2. For classify and extract, every field matches. For the other tasks, the judge scores the answer 4 or 5 out of 5.
3. The request's cost is at most the item's max_cost_usd.
4. The request's latency is at most the item's latency_target_ms.

A failed or refused request counts as a failure and is never dropped.

## Judge

`support-judge-v1` runs on claude-sonnet-5-5 with thinking off, and falls back to gpt-5.6-terra only if Anthropic fails. Every tier's primary is an OpenAI model, so in normal operation the grader never grades its own model family. Each verdict records which model gave it. The judge receives the task, ticket, rubric and answer as JSON data and replies with a JSON score from 1 to 5. Any invented policy, price, date, step or fact caps the score at 2. A malformed verdict is retried once and then counts as a failure. Judge cost is reported separately and is not added to any config's cost.

## Metrics

- **Primary:** success rate overall and per class, as the mean of the runs. Cost per successful task is total model cost divided by successes, as the mean of the runs.
- **Secondary:** p50 and p95 latency over answered requests, tier share, fallback and escalation rates, and items whose outcome changed between runs.

## The bar, and what gets reported

- **The bar:** routed success may be at most 3 points below all-premium overall (2 of 90 ticket-runs), and at most one ticket-run below all-premium in each of the three classes (1 of 30, or 3.3 points). A ticket-run is one ticket in one run.
- **If routed passes,** the result reads: "routing cut cost per successful task by X% compared with all-premium, at Y% success (all-premium Z%)".
- **If routed fails,** the report shows the gaps and gives no savings figure. The dataset, prompts and rules are not tuned and rerun for a better number. Any later attempt is a new pre-registration with a new dataset or policy version, and both results stay published.
- **Every run is kept** in `experiment/results/`, including smoke runs and runs that stopped early. Only the full approved run can report savings.

## Known limitations

- **The sample is small.** With 15 items per class and 2 runs, one ticket failing in one run moves a class by 3.3 points, so a 3-point class bar would allow no loss at all. That is why the class bar is one ticket-run. Even so, 45 tickets cannot show a difference of a few points with statistical confidence; the result is evidence, not proof.
- **The data is synthetic.** The tickets were drafted with AI help and then reviewed by a person. They are not real customer traffic.
- **The judge may favor some answers.** A Claude grader could prefer Claude-written answers, which appear only when a tier falls back to its Anthropic model, and the fallback grader is also routed's mid-tier primary. Results record the answering and grading model for every item, so these cases can be checked. The judge was changed from gpt-5.6-sol to claude-sonnet-5-5 before any live run, to cut grading cost by about 90%.
- **Prices change.** They come from the providers' pricing pages as of the pricing version, so savings are relative to those prices.
- **Latency depends on conditions.** It includes provider load at run time and the concurrency of 4.

Approved by: Mihir Mukhi, 2026-10-05
