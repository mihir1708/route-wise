// Turns item results into the pre-registered comparison: success, cost per success, latency, tiers.
import { TASK_CLASSES, type TaskClass } from './benchmark';
import type { ConfigName, ItemResult } from './harness';

/** Routed passes when its success rate is no more than this far below all-premium overall... */
export const MAX_SUCCESS_GAP = 0.03;
/** ...and, in each class, no more than this gap or one ticket-run below, whichever is larger. A class has
 * 15 tickets, so over 2 runs a single ticket-run is 3.3 points: a strict 3-point class bar would allow no loss at all. */
export const MAX_CLASS_LOSS_RUNS = 1;

export interface RunMetrics {
  items: number;
  successes: number;
  success_rate: number;
  by_class: Record<TaskClass, number>;
  total_cost_usd: number;
  cost_per_success_usd: number | null;
}

export interface ConfigSummary {
  config: ConfigName;
  runs: RunMetrics[];
  success_rate: number;
  by_class: Record<TaskClass, number>;
  total_cost_usd: number;
  cost_per_success_usd: number | null;
  latency_p50_ms: number | null;
  latency_p95_ms: number | null;
  tier_share: Record<string, number>;
  fallback_rate: number;
  escalation_rate: number;
  over_cost: number;
  over_latency: number;
}

export interface ExperimentSummary {
  configs: ConfigSummary[];
  bar: { passed: boolean; gaps: { overall: number } & Record<TaskClass, number>; allowed: { overall: number } & Record<TaskClass, number> } | null;
  /** False for smoke runs and runs stopped early; those never report savings. */
  preregistered: boolean;
  /** Reduction in cost per successful task vs all-premium; null unless routed passed the bar in a pre-registered run. */
  routed_savings: number | null;
  /** Items whose success differed between runs of the same config. */
  unstable: { config: ConfigName; item_id: string; outcomes: boolean[] }[];
  judge: { calls: number; failures: number; cost_usd: number };
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p / 100 * sorted.length) - 1))];
}

function runMetrics(results: ItemResult[]): RunMetrics {
  const successes = results.filter(r => r.success).length;
  const cost = results.reduce((sum, r) => sum + r.cost_usd, 0);
  const byClass = Object.fromEntries(TASK_CLASSES.map(cls => {
    const rs = results.filter(r => r.class === cls);
    return [cls, rs.length ? rs.filter(r => r.success).length / rs.length : 0];
  })) as Record<TaskClass, number>;
  return {
    items: results.length, successes, success_rate: results.length ? successes / results.length : 0, by_class: byClass,
    total_cost_usd: cost, cost_per_success_usd: successes ? cost / successes : null,
  };
}

function summarizeConfig(config: ConfigName, results: ItemResult[]): ConfigSummary {
  const runNumbers = [...new Set(results.map(r => r.run))].sort((a, b) => a - b);
  const runs = runNumbers.map(n => runMetrics(results.filter(r => r.run === n)));
  const answered = results.filter(r => r.status === 200);
  const perSuccess = runs.map(r => r.cost_per_success_usd).filter((v): v is number => v !== null);
  const tiers: Record<string, number> = {};
  for (const r of answered) if (r.tier) tiers[r.tier] = (tiers[r.tier] ?? 0) + 1 / answered.length;
  return {
    config, runs,
    success_rate: mean(runs.map(r => r.success_rate)),
    by_class: Object.fromEntries(TASK_CLASSES.map(cls => [cls, mean(runs.map(r => r.by_class[cls]))])) as Record<TaskClass, number>,
    total_cost_usd: mean(runs.map(r => r.total_cost_usd)),
    cost_per_success_usd: perSuccess.length === runs.length && runs.length ? mean(perSuccess) : null,
    latency_p50_ms: percentile(answered.map(r => r.latency_ms), 50),
    latency_p95_ms: percentile(answered.map(r => r.latency_ms), 95),
    tier_share: tiers,
    fallback_rate: results.length ? results.filter(r => r.fallback_used).length / results.length : 0,
    escalation_rate: results.length ? results.filter(r => r.escalated).length / results.length : 0,
    over_cost: results.filter(r => !r.within_cost).length,
    over_latency: results.filter(r => !r.within_latency).length,
  };
}

export function summarize(results: ItemResult[], options: { preregistered?: boolean } = {}): ExperimentSummary {
  const preregistered = options.preregistered ?? true;
  const names = [...new Set(results.map(r => r.config))];
  const configs = names.map(name => summarizeConfig(name, results.filter(r => r.config === name)));
  const premium = configs.find(c => c.config === 'all-premium');
  const routed = configs.find(c => c.config === 'routed');
  let bar: ExperimentSummary['bar'] = null;
  let savings: number | null = null;
  if (premium && routed) {
    const gaps = {
      overall: routed.success_rate - premium.success_rate,
      ...Object.fromEntries(TASK_CLASSES.map(cls => [cls, routed.by_class[cls] - premium.by_class[cls]])),
    } as { overall: number } & Record<TaskClass, number>;
    const premiumRuns = results.filter(r => r.config === 'all-premium');
    const allowed = {
      overall: MAX_SUCCESS_GAP,
      ...Object.fromEntries(TASK_CLASSES.map(cls => {
        const n = premiumRuns.filter(r => r.class === cls).length;
        return [cls, Math.max(MAX_SUCCESS_GAP, n ? MAX_CLASS_LOSS_RUNS / n : 0)];
      })),
    } as { overall: number } & Record<TaskClass, number>;
    // A tiny tolerance so a gap equal to the allowance in floating point still passes.
    const passed = (Object.keys(gaps) as (keyof typeof gaps)[]).every(k => gaps[k] >= -allowed[k] - 1e-9);
    bar = { passed, gaps, allowed };
    if (preregistered && passed && routed.cost_per_success_usd !== null && premium.cost_per_success_usd) {
      savings = 1 - routed.cost_per_success_usd / premium.cost_per_success_usd;
    }
  }
  const unstable: ExperimentSummary['unstable'] = [];
  for (const name of names) {
    const byItem = new Map<string, boolean[]>();
    for (const r of results.filter(x => x.config === name)) byItem.set(r.item_id, [...(byItem.get(r.item_id) ?? []), r.success]);
    for (const [item_id, outcomes] of byItem) if (new Set(outcomes).size > 1) unstable.push({ config: name, item_id, outcomes });
  }
  const judged = results.filter(r => r.check.method === 'judge' && r.status === 200);
  return {
    configs, bar, preregistered, routed_savings: savings, unstable,
    judge: {
      calls: judged.length, failures: judged.filter(r => r.check.score === null).length,
      cost_usd: results.reduce((sum, r) => sum + r.judge_cost_usd, 0),
    },
  };
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const usd = (x: number | null) => (x === null ? 'n/a' : `$${x.toFixed(x < 0.01 ? 5 : 4)}`);
const ms = (x: number | null) => (x === null ? 'n/a' : `${Math.round(x)} ms`);
const requests = (n: number) => `${n} request${n === 1 ? '' : 's'}`;
const points = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)} pts`;

export function renderMarkdown(summary: ExperimentSummary, meta: { title: string; lines: string[] }): string {
  const out: string[] = [`# ${meta.title}`, '', ...meta.lines, ''];
  out.push('| Config | Success | Simple | Standard | Complex | Total cost | Cost per success | p50 | p95 | Fallbacks | Escalations |');
  out.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const c of summary.configs) {
    out.push(`| ${c.config} | ${pct(c.success_rate)} | ${pct(c.by_class.simple)} | ${pct(c.by_class.standard)} | ${pct(c.by_class.complex)} | ${usd(c.total_cost_usd)} | ${usd(c.cost_per_success_usd)} | ${ms(c.latency_p50_ms)} | ${ms(c.latency_p95_ms)} | ${pct(c.fallback_rate)} | ${pct(c.escalation_rate)} |`);
  }
  const items = summary.configs[0]?.runs[0]?.items ?? 0;
  out.push('', `Success rates and costs are means across runs; cost is per run of ${items} items. Latency percentiles pool every answered request.`, '');
  for (const c of summary.configs.filter(x => x.over_cost || x.over_latency)) {
    out.push(`${c.config}: ${requests(c.over_cost)} over the cost limit and ${requests(c.over_latency)} over the latency limit, counted as failures.`, '');
  }
  const routed = summary.configs.find(c => c.config === 'routed');
  if (routed) {
    const share = Object.entries(routed.tier_share).sort().map(([t, s]) => `${t} ${pct(s)}`).join(', ');
    out.push(`Routed traffic by tier: ${share || 'none'}.`, '');
  }
  if (summary.bar) {
    const g = summary.bar.gaps;
    const heading = summary.preregistered ? 'Pre-registered bar' : 'Bar check (not binding for this run)';
    out.push(`## ${heading}: ${summary.bar.passed ? 'passed' : 'not met'}`, '');
    out.push(`Routed minus all-premium success: overall ${points(g.overall)}, simple ${points(g.simple)}, standard ${points(g.standard)}, complex ${points(g.complex)}. The bar allows ${(MAX_SUCCESS_GAP * 100).toFixed(0)} points below overall and one ticket-run (${(summary.bar.allowed.simple * 100).toFixed(1)} points here) below in each class.`, '');
    out.push(summary.routed_savings !== null
      ? `Routing cut cost per successful task by **${pct(summary.routed_savings)}** compared with all-premium.`
      : !summary.preregistered ? 'Savings are not reported, because this is not the full pre-registered run.'
      : summary.bar.passed ? 'Savings are not reported, because a config had no successful tasks.'
      : 'Savings are not reported, because routed did not meet the pre-registered bar.', '');
  }
  if (summary.unstable.length) {
    out.push('## Items that changed between runs', '');
    for (const u of summary.unstable) out.push(`- ${u.config} / ${u.item_id}: ${u.outcomes.map(o => (o ? 'pass' : 'fail')).join(', ')}`);
    out.push('');
  }
  out.push(`Judge: ${summary.judge.calls} rubric verdicts, ${summary.judge.failures} without a usable score, ${usd(summary.judge.cost_usd)} in judge calls (not counted in config costs).`);
  return `${out.join('\n')}\n`;
}
