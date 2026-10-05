# Routing experiment

The [README](../README.md#results) has the results table. The pre-registration, with the outcome added after the run, is [experiment/preregistration.md](../experiment/preregistration.md), and every run's raw results are in [experiment/results/](../experiment/results/).

## Running it: `npm run experiment`

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
before any live call: routed success may be at most 3 points below all-premium
overall and at most one ticket-run below in each class. It also pins the dataset hash, prompt versions, routing
policy, models and pricing. A full live run refuses to start unless every item is
reviewed, the pinned values match the code, someone has approved the
pre-registration and the working tree is committed. Savings are reported only
when routed meets the bar on the full approved run. Live runs never run in CI,
always ask for a typed `yes` (or `--yes`), and stop at a hard spend limit
(`--budget`, defaulting to the dry run's upper bound). Results go to
`experiment/results/` as JSON and a Markdown table.

**Result (2026-10-05):** routed did not meet the bar. It matched or beat
all-premium on simple and standard tickets but scored 50% on complex tickets
against 70%, so no savings figure is claimed. Seven of its 15 complex failures came
from a fallback bug that has since been fixed: an empty answer from the mid tier's
primary, then a fallback answer cut off at the token cap. The outcome section of
`experiment/preregistration.md` has the details.
