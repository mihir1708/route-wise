// Runs the benchmark through the real gateway pipeline under each configuration.
// Postgres is replaced by an in-memory ledger; routing, retries, fallback, escalation,
// validation and cost accounting are the production code paths.
import { billableOutputCap, modelCost, type ModelConfig, type ModelTier } from '@/lib/model-registry';
import { callWithFallback, type Attempt } from '@/lib/provider-chain';
import type { CallOptions } from '@/lib/providers';
import { estimateInputTokens, executeGenerate, type GenerateDependencies, type RequestRun } from '@/lib/request-run';
import { CircuitBreaker, DEFAULT_RETRY_POLICY, sleep as realSleep } from '@/lib/resilience';
import { routeTask } from '@/lib/routing-policy';
import type { ModelResponse } from '@/types';
import { isStructured, type Benchmark, type BenchmarkItem, type TaskClass } from './benchmark';
import { JUDGE_MAX_OUTPUT_TOKENS, JUDGE_MODELS, JUDGE_PASS_SCORE, JUDGE_SYSTEM, judgeRequest, parseJudge, scoreStructured } from './scoring';

export type ConfigName = 'all-premium' | 'routed' | 'all-small';
/** Each config is the same request under different tenant tier permissions. */
export const CONFIGS: readonly { name: ConfigName; allowedTiers: readonly ModelTier[]; description: string }[] = [
  { name: 'all-premium', allowedTiers: ['high'], description: 'Every item on the high tier' },
  { name: 'routed', allowedTiers: ['low', 'mid', 'high'], description: 'rules-v1 picks the tier' },
  { name: 'all-small', allowedTiers: ['low'], description: 'Every item on the low tier' },
];

export interface Judgement { score: number | null; reason: string; cost_usd: number; model: string | null }

export interface ItemResult {
  run: number;
  config: ConfigName;
  item_id: string;
  class: TaskClass;
  task_type: BenchmarkItem['task_type'];
  priority: BenchmarkItem['priority'];
  status: number;
  error: string | null;
  tier: ModelTier | null;
  model: string | null;
  provider: string | null;
  route_reasons: string[];
  fallback_used: boolean;
  escalated: boolean;
  attempts: Pick<Attempt, 'model' | 'outcome' | 'error_kind' | 'latency_ms'>[];
  cost_usd: number;
  latency_ms: number;
  stage_timings: Record<string, number>;
  answer: string | null;
  check: { method: 'exact' | 'judge'; passed: boolean; fields?: Record<string, boolean>; score?: number | null; reason?: string; judge_model?: string | null };
  judge_cost_usd: number;
  within_cost: boolean;
  within_latency: boolean;
  success: boolean;
}

export interface ExperimentDependencies {
  models: readonly ModelConfig[];
  call(user: string, model: ModelConfig, options: CallOptions): Promise<ModelResponse>;
  judge(item: BenchmarkItem, answer: string): Promise<Judgement>;
  /** The judge's candidate models, for reserving its worst-case cost. */
  judgeModels: readonly ModelConfig[];
  /** Hard stop for the whole run, model and judge calls together. */
  spendLimitUsd: number;
  concurrency?: number;
  sleep?(ms: number): Promise<void>;
  random?(): number;
  onResult?(result: ItemResult, done: number, total: number): void;
}

export class SpendLimitReached extends Error {
  constructor(readonly partial: ItemResult[]) { super('spend_limit_reached'); }
}

export interface Job { run: number; item: BenchmarkItem; config: typeof CONFIGS[number] }

/** Configs are interleaved per item, so time-of-day effects hit them equally. */
export function plannedJobs(benchmark: Benchmark, runs: number, configs: readonly ConfigName[] = CONFIGS.map(c => c.name)): Job[] {
  const jobs: Job[] = [];
  for (let run = 1; run <= runs; run++) {
    for (const item of benchmark.items) {
      for (const config of CONFIGS.filter(c => configs.includes(c.name))) jobs.push({ run, item, config });
    }
  }
  return jobs;
}

/** The request body every config sends; only the tenant's allowed tiers differ. */
export function requestBody(item: BenchmarkItem) {
  return {
    task_type: item.task_type, input: item.input, priority: item.priority,
    max_cost_usd: item.max_cost_usd, latency_target_ms: item.latency_target_ms, cache: false,
  };
}

/** Longest answer the judge may be handed, in characters (about the largest prompt output cap). */
const MAX_ANSWER_CHARS = 4000;

/** The enabled judge models in the registry, grader first. */
export function judgeCandidates(models: readonly ModelConfig[]): ModelConfig[] {
  return JUDGE_MODELS.map(id => models.find(m => m.id === id && m.enabled)).filter((m): m is ModelConfig => Boolean(m));
}

/** Worst-case USD to judge one answer: two tries on the priciest judge candidate. */
export function judgeWorstCase(item: BenchmarkItem, judgeModels: readonly ModelConfig[]): number {
  if (isStructured(item)) return 0;
  const input = estimateInputTokens(JUDGE_SYSTEM, judgeRequest(item, 'x'.repeat(MAX_ANSWER_CHARS)));
  return 2 * Math.max(0, ...judgeModels.map(m => modelCost(m, input, billableOutputCap(m, JUDGE_MAX_OUTPUT_TOKENS))));
}

export async function runExperiment(
  benchmark: Benchmark, deps: ExperimentDependencies, options: { runs: number; configs?: readonly ConfigName[] },
): Promise<ItemResult[]> {
  const jobs = plannedJobs(benchmark, options.runs, options.configs);
  // Spend is reserved before a job starts, so concurrent jobs cannot together pass the limit.
  const ledger = { spent: 0, reserved: 0, stopped: false };
  const breakers = new Map(CONFIGS.map(c => [c.name, new CircuitBreaker()]));
  const results: ItemResult[] = [];

  async function runJob(job: Job): Promise<void> {
    const reserve = job.item.max_cost_usd + judgeWorstCase(job.item, deps.judgeModels);
    if (ledger.stopped || ledger.spent + ledger.reserved + reserve > deps.spendLimitUsd) {
      ledger.stopped = true;
      return;
    }
    ledger.reserved += reserve;
    try { await runReservedJob(job); } finally { ledger.reserved -= reserve; }
  }

  async function runReservedJob({ run, item, config }: Job): Promise<void> {
    let persisted: { run: RequestRun; attempts: Attempt[] } | null = null;
    const gateway: GenerateDependencies = {
      models: deps.models,
      allowedTiers: config.allowedTiers,
      takeRateLimit: async () => ({ allowed: true, window_start: 'experiment' }),
      adjustTokens: async () => {},
      // The spend limit is enforced by the reservations above, so the gateway's own budget never
      // blocks an escalation that the item's max_cost_usd allows; every config sees the same rules.
      admit: async () => ({ tenantSpent: 0, tenantBudget: 1e9, globalSpent: 0, globalLimit: 1e9 }),
      route: (request, context) => routeTask(request.task_type, request.input, {
        budgetPercentage: context.budgetPercentage, allowedTiers: config.allowedTiers, models: deps.models,
        priority: request.priority, latencyTargetMs: request.latency_target_ms, maxCostUsd: request.max_cost_usd,
        worstCase: context.worstCase,
      }),
      call: deps.call,
      settle: async cost => { ledger.spent += cost; },
      persist: async (r, attempts) => { persisted = { run: r, attempts }; },
      breaker: breakers.get(config.name),
      retryPolicy: DEFAULT_RETRY_POLICY,
      sleep: deps.sleep ?? realSleep,
      random: deps.random,
    };
    const response = await executeGenerate(requestBody(item), 'experiment', gateway);
    const r = response.run;
    const answer = typeof response.body.answer === 'string' ? response.body.answer : null;
    let check: ItemResult['check'];
    let judgeCost = 0;
    if (isStructured(item)) {
      const s = response.status === 200 ? scoreStructured(item, response.body.output) : { passed: false, fields: {} };
      check = { method: 'exact', passed: s.passed, fields: s.fields };
    } else if (response.status === 200 && answer !== null) {
      const j = await deps.judge(item, answer);
      judgeCost = j.cost_usd;
      ledger.spent += j.cost_usd;
      check = { method: 'judge', passed: j.score !== null && j.score >= JUDGE_PASS_SCORE, score: j.score, reason: j.reason, judge_model: j.model };
    } else {
      check = { method: 'judge', passed: false, score: null, reason: 'no answer to judge' };
    }
    const cost = r.cost_usd ?? 0;
    const withinCost = cost <= item.max_cost_usd;
    const withinLatency = r.latency_ms <= item.latency_target_ms;
    results.push({
      run, config: config.name, item_id: item.id, class: item.class, task_type: item.task_type, priority: item.priority,
      status: response.status, error: r.error_category, tier: r.selected_tier, model: r.selected_model,
      provider: deps.models.find(m => m.id === r.selected_model)?.provider ?? null,
      route_reasons: r.route_reasons, fallback_used: r.fallback_used, escalated: r.escalated,
      attempts: (persisted as { attempts: Attempt[] } | null)?.attempts.map(a => ({ model: a.model, outcome: a.outcome, error_kind: a.error_kind, latency_ms: a.latency_ms })) ?? [],
      cost_usd: cost, latency_ms: r.latency_ms, stage_timings: r.stage_timings, answer, check, judge_cost_usd: judgeCost,
      within_cost: withinCost, within_latency: withinLatency,
      success: response.status === 200 && check.passed && withinCost && withinLatency,
    });
    deps.onResult?.(results[results.length - 1], results.length, jobs.length);
  }

  // A small worker pool; each worker takes the next job in order.
  let next = 0;
  const workers = Array.from({ length: Math.max(1, deps.concurrency ?? 4) }, async () => {
    while (next < jobs.length && !ledger.stopped) await runJob(jobs[next++]);
  });
  await Promise.all(workers);
  const order = new Map(jobs.map((j, i) => [`${j.run}/${j.item.id}/${j.config.name}`, i]));
  results.sort((a, b) => order.get(`${a.run}/${a.item_id}/${a.config}`)! - order.get(`${b.run}/${b.item_id}/${b.config}`)!);
  if (ledger.stopped) throw new SpendLimitReached(results);
  return results;
}

/** A rubric judge on the given models (grader, then fallback); a malformed verdict is retried once. */
export function makeJudge(
  judgeModels: readonly ModelConfig[], call: ExperimentDependencies['call'], sleep: (ms: number) => Promise<void> = realSleep,
): ExperimentDependencies['judge'] {
  if (!judgeModels.length) throw new Error('No judge model is enabled in the registry');
  const breaker = new CircuitBreaker();
  return async (item, answer) => {
    let cost = 0; let model: string | null = null;
    for (let tryNo = 0; tryNo < 2; tryNo++) {
      try {
        const { response, model: used } = await callWithFallback([...judgeModels], judgeRequest(item, answer),
          { system: JUDGE_SYSTEM, maxOutputTokens: JUDGE_MAX_OUTPUT_TOKENS }, { call, breaker, sleep, retryPolicy: DEFAULT_RETRY_POLICY }, []);
        model = used.id;
        if (Number.isSafeInteger(response.prompt_tokens) && Number.isSafeInteger(response.completion_tokens)) {
          cost += modelCost(used, response.prompt_tokens, response.completion_tokens);
        }
        const verdict = parseJudge(response.content);
        if (verdict) return { ...verdict, cost_usd: cost, model };
      } catch { /* provider failure: try once more, then record no score */ }
    }
    return { score: null, reason: 'judge_failed', cost_usd: cost, model };
  };
}
