// npm run experiment            dry run: routing plan, cost estimate, review and pre-registration status
// npm run experiment -- --live  the pre-registered experiment (needs approval, a clean tree and API keys)
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { runtimeModels } from '../lib/model-registry';
import { callProvider } from '../lib/providers';
import { benchmarkHash, TASK_CLASSES, validateBenchmark, type Benchmark } from '../experiment/benchmark';
import { makeJudge, runExperiment, SpendLimitReached, type ItemResult } from '../experiment/harness';
import { planExperiment, type ExperimentPlan } from '../experiment/plan';
import { checkPreregistration, DEFAULT_RUNS, pinnedValues, renderPinned } from '../experiment/preregistration';
import { renderMarkdown, summarize } from '../experiment/report';

const BENCHMARK = 'experiment/benchmark-v1.json';
const PREREGISTRATION = 'experiment/preregistration.md';

const args = process.argv.slice(2);
const flags = new Set<string>();
const values: Record<string, string> = {};
for (let i = 0; i < args.length; i++) {
  const key = args[i];
  if (['--live', '--yes'].includes(key)) { flags.add(key); continue; }
  if (!['--runs', '--budget', '--concurrency', '--limit', '--out'].includes(key) || args[i + 1] === undefined) throw new Error(`Invalid argument ${key}`);
  values[key] = args[++i];
}
function positive(name: string, fallback: number, integer = true): number {
  const n = values[name] === undefined ? fallback : Number(values[name]);
  if (!(Number.isFinite(n) && n > 0 && (!integer || Number.isSafeInteger(n)))) throw new Error(`${name} must be a positive ${integer ? 'integer' : 'number'}`);
  return n;
}
const live = flags.has('--live');
const runs = positive('--runs', DEFAULT_RUNS);
const concurrency = positive('--concurrency', 4);
const limit = values['--limit'] === undefined ? null : positive('--limit', 1);

const usd = (n: number) => `$${n.toFixed(2)}`;
function git(...cmd: string[]): string | null {
  try { return execFileSync('git', cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; }
}

/** The first N items of each class, for a smoke run. */
function limited(benchmark: Benchmark, n: number | null): Benchmark {
  if (n === null) return benchmark;
  return { ...benchmark, items: TASK_CLASSES.flatMap(cls => benchmark.items.filter(i => i.class === cls).slice(0, n)) };
}

function printPlan(plan: ExperimentPlan, items: number) {
  console.log(`Routing plan for ${items} items x ${plan.runs} runs (no model calls):`);
  for (const c of plan.configs) {
    const tiers = Object.entries(c.tiers).filter(([, n]) => n).map(([t, n]) => `${t} ${n}`).join(', ');
    console.log(`  ${c.config.padEnd(12)} ${tiers.padEnd(22)} per run: up to ${usd(c.upper_bound_usd)}, typically ${usd(c.typical_usd)}; judge up to ${usd(c.judge_upper_bound_usd)}, typically ${usd(c.judge_typical_usd)}`);
    if (c.refused.length) console.log(`    refused by max_cost_usd: ${c.refused.join(', ')}`);
  }
  console.log(`Estimated total: up to ${usd(plan.upper_bound_usd)}, typically about ${usd(plan.typical_usd)} (rough; real costs are measured).`);
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await rl.question(question)).trim().toLowerCase() === 'yes'; } finally { rl.close(); }
}

async function main() {
  const raw = readFileSync(resolve(BENCHMARK));
  const full = validateBenchmark(JSON.parse(raw.toString('utf8')));
  const benchmark = limited(full, limit);
  const models = runtimeModels();
  const hash = benchmarkHash(raw);
  const plan = await planExperiment(benchmark, models, runs);
  const fullPlan = limit === null ? plan : await planExperiment(full, models, runs);
  const pinned = pinnedValues({
    benchmarkVersion: full.version, benchmarkHash: hash, promptVersions: fullPlan.prompt_versions,
    policyVersions: fullPlan.policy_versions, models, runs,
  });
  const prereg = checkPreregistration(readFileSync(resolve(PREREGISTRATION), 'utf8'), pinned);
  const unreviewed = full.items.filter(i => !i.reviewed).map(i => i.id);

  console.log(`Benchmark ${full.version}: ${full.items.length} items, SHA-256 ${hash}`);
  printPlan(plan, benchmark.items.length);
  console.log(`Review: ${full.items.length - unreviewed.length}/${full.items.length} items reviewed.`);
  console.log(prereg.problems.length
    ? `Pre-registration: not ready (${prereg.problems.join('; ')}).`
    : `Pre-registration: approved by ${prereg.approvedBy}; pinned values match.`);
  if (prereg.problems.some(p => !p.startsWith('not approved'))) console.log(`Pinned values as the code stands:\n${renderPinned(pinned)}`);
  const refused = plan.configs.filter(c => c.refused.length);
  if (refused.length) throw new Error('Some items cannot fit their max_cost_usd on the routed tier; raise their limits before running.');

  if (!live) { console.log('Dry run only. Add --live to call the models.'); return; }

  // A smoke run (--limit) checks keys and plumbing; only the full approved run can report savings.
  const smoke = limit !== null;
  const blockers: string[] = [];
  if (process.env.CI) blockers.push('live runs never happen in CI');
  if (!process.env.OPENAI_API_KEY) blockers.push('OPENAI_API_KEY is not set');
  if (!smoke) {
    if (unreviewed.length) blockers.push(`${unreviewed.length} items are not reviewed`);
    blockers.push(...prereg.problems.map(p => `pre-registration: ${p}`));
    if (git('status', '--porcelain')) blockers.push('the working tree has uncommitted changes; results must point at a commit');
  }
  if (blockers.length) throw new Error(`Live run refused:\n- ${blockers.join('\n- ')}`);
  if (!process.env.ANTHROPIC_API_KEY) console.warn('Warning: ANTHROPIC_API_KEY is not set, so fallbacks to Anthropic models will fail.');

  const spendLimit = positive('--budget', Math.ceil(plan.upper_bound_usd), false);
  const question = `${smoke ? 'Smoke run' : 'Pre-registered run'}: ${benchmark.items.length} items x 3 configs x ${runs} runs, hard stop at ${usd(spendLimit)}. Type "yes" to spend real money: `;
  if (!flags.has('--yes') && !(await confirm(question))) { console.log('Not confirmed; nothing was spent.'); return; }

  const startedAt = new Date();
  let results: ItemResult[];
  let stopped = false;
  try {
    results = await runExperiment(benchmark, {
      models, call: callProvider, judge: makeJudge(models, callProvider), spendLimitUsd: spendLimit, concurrency,
      onResult: (r, done, total) => console.log(`[${done}/${total}] run ${r.run} ${r.config} ${r.item_id}: ${r.success ? 'pass' : 'fail'} (${r.tier ?? r.error}, $${r.cost_usd.toFixed(5)}, ${r.latency_ms} ms)`),
    }, { runs });
  } catch (error) {
    if (!(error instanceof SpendLimitReached)) throw error;
    results = error.partial; stopped = true;
    console.error(`Stopped at the ${usd(spendLimit)} spend limit after ${results.length} requests.`);
  }

  const summary = summarize(results, { preregistered: !smoke && !stopped });
  const commit = git('rev-parse', 'HEAD');
  const meta = {
    mode: smoke ? 'smoke' : 'preregistered', completed: !stopped, started_at: startedAt.toISOString(), finished_at: new Date().toISOString(),
    commit, dirty: Boolean(git('status', '--porcelain')), benchmark_version: full.version, benchmark_sha256: hash,
    items: benchmark.items.length, runs, concurrency, spend_limit_usd: spendLimit, pinned, approved_by: prereg.approvedBy,
  };
  const title = smoke ? `RouteWise routing experiment: smoke run (${benchmark.items.length} items)`
    : stopped ? 'RouteWise routing experiment: incomplete (spend limit reached)' : 'RouteWise routing experiment';
  const markdown = renderMarkdown(summary, { title, lines: [
    `Benchmark \`${full.version}\` (SHA-256 \`${hash.slice(0, 12)}\`), ${benchmark.items.length} items, ${runs} runs, commit \`${commit?.slice(0, 7) ?? 'unknown'}\`, ${startedAt.toISOString().slice(0, 10)}.`,
    `Configs: all-premium (high tier only), routed (rules-v1), all-small (low tier only). Pre-registration: ${PREREGISTRATION}.`,
  ] });
  const out = resolve(values['--out'] ?? 'experiment/results');
  mkdirSync(out, { recursive: true });
  const stem = `${out}/${startedAt.toISOString().replace(/[:.]/g, '-')}-${meta.mode}`;
  writeFileSync(`${stem}.json`, `${JSON.stringify({ meta, plan, summary, results }, null, 2)}\n`);
  writeFileSync(`${stem}.md`, markdown);
  console.log(`\n${markdown}\nWrote ${stem}.json and ${stem}.md`);
  if (stopped) process.exitCode = 1;
}

main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
