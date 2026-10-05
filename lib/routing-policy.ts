import { estimateDifficulty, selectModel } from '@/lib/difficulty-estimator';
import { modelForTier, runtimeModels, type ModelConfig, type ModelTier } from '@/lib/model-registry';
import type { TaskType } from '@/prompts';
export interface RoutingDecision {
  difficulty: number; tier: ModelTier; model: string; policyVersion: string; reasons: string[];
}
export interface RoutingContext { budgetPercentage: number; models?: readonly ModelConfig[] }
export interface RoutingPolicy {
  version: string;
  route(query: string, context: RoutingContext): Promise<RoutingDecision>;
}
export const heuristicV1: RoutingPolicy = {
  version: 'heuristic-v1',
  async route(query, context) {
    const difficulty = await estimateDifficulty(query);
    const tier = selectModel(difficulty, context.budgetPercentage) === 'gpt-4' ? 'high' : 'low';
    const model = modelForTier(tier, context.models ?? runtimeModels());
    return { difficulty, tier, model: model.id, policyVersion: 'heuristic-v1', reasons: [
      `v1 first-match score=${difficulty}`, `characters=${query.length}`,
      `literal-space words=${query.split(' ').length}`,
      `budget threshold=${context.budgetPercentage >= 90 ? 0.95 : context.budgetPercentage >= 80 ? 0.85 : 0.8}`,
    ] };
  },
};

const TIER_ORDER: readonly ModelTier[] = ['low', 'mid', 'high'];

/**
 * The closest tier that is both allowed for the tenant and has an enabled model.
 * Ties go to the cheaper tier. Null when nothing qualifies.
 */
export function resolveTier(wanted: ModelTier, allowed: readonly ModelTier[], models: readonly ModelConfig[]): ModelTier | null {
  const usable = TIER_ORDER.filter(t => allowed.includes(t) && models.some(m => m.tier === t && m.enabled));
  const at = TIER_ORDER.indexOf(wanted);
  const distance = (t: ModelTier) => Math.abs(TIER_ORDER.indexOf(t) - at);
  return usable.reduce<ModelTier | null>((best, t) => (best === null || distance(t) < distance(best) ? t : best), null);
}

// Base tier per task type; rules-v1 adjusts it per request.
export const TASK_DEFAULT_TIERS: Readonly<Record<Exclude<TaskType, 'chat'>, ModelTier>> = {
  classify: 'low', extract: 'low', summarize: 'mid', draft_reply: 'mid', troubleshoot: 'high',
};

const SIGNALS: readonly { name: string; weight: number; test: (input: string) => boolean }[] = [
  { name: 'long_thread', weight: 0.3, test: i => i.length > 2500 },
  { name: 'very_long_thread', weight: 0.2, test: i => i.length > 6000 },
  { name: 'error_output', weight: 0.25, test: i => /\b(exception|traceback|stack trace|errno|segfault)\b|\bHTTP [45]\d\d\b|^\s+at \S+\(/im.test(i) },
  { name: 'many_questions', weight: 0.15, test: i => (i.match(/\?/g) ?? []).length >= 3 },
  { name: 'high_stakes', weight: 0.3, test: i => /\b(outage|data loss|security|breach|chargeback|legal|lawsuit|all users|production down)\b/i.test(i) },
  { name: 'already_tried', weight: 0.1, test: i => /\b(already tried|still (?:not|failing|broken)|tried everything|again and again)\b/i.test(i) },
];

/** 0..1 from transparent ticket signals; every signal that fired is returned for the route reasons. */
export function ticketDifficulty(input: string): { score: number; signals: string[] } {
  const fired = SIGNALS.filter(s => s.test(input));
  const score = Math.min(1, Math.round(fired.reduce((sum, s) => sum + s.weight, 0) * 100) / 100);
  return { score, signals: fired.map(s => s.name) };
}

export interface TaskRoutingContext {
  budgetPercentage: number;
  allowedTiers: readonly ModelTier[];
  models?: readonly ModelConfig[];
  priority?: 'low' | 'normal' | 'high';
  latencyTargetMs?: number | null;
  maxCostUsd?: number | null;
  /** Worst-case USD for this request on a tier; needed to honor maxCostUsd. */
  worstCase?: (tier: ModelTier) => number;
}

const step = (tier: ModelTier, by: number): ModelTier =>
  TIER_ORDER[Math.max(0, Math.min(TIER_ORDER.length - 1, TIER_ORDER.indexOf(tier) + by))];

/**
 * rules-v1, in order: task default, ticket difficulty, priority, latency target, global budget
 * pressure, then tenant tiers and the per-request cost cap. Chat keeps heuristic-v1.
 */
export async function routeTask(task: TaskType, input: string, context: TaskRoutingContext): Promise<RoutingDecision> {
  const models = context.models ?? runtimeModels();
  let tier: ModelTier; let difficulty: number; let policyVersion: string; const reasons: string[] = [];
  if (task === 'chat') {
    const v1 = await heuristicV1.route(input, { budgetPercentage: context.budgetPercentage, models });
    ({ tier, difficulty, policyVersion } = v1); reasons.push(...v1.reasons);
  } else {
    policyVersion = 'rules-v1';
    tier = TASK_DEFAULT_TIERS[task]; reasons.push(`task ${task} starts at ${tier}`);
    const d = ticketDifficulty(input); difficulty = d.score;
    if (d.signals.length) reasons.push(`difficulty ${d.score} (${d.signals.join(', ')})`);
    if (['extract', 'summarize', 'draft_reply'].includes(task) && d.score >= 0.6 && tier !== 'high') {
      tier = step(tier, 1); reasons.push(`hard ticket: up to ${tier}`);
    }
    if (task === 'troubleshoot' && d.score === 0 && input.length < 400) {
      tier = step(tier, -1); reasons.push(`short ticket with no hard signals: down to ${tier}`);
    }
    if (context.priority === 'high' && tier !== 'high') { tier = step(tier, 1); reasons.push(`priority high: up to ${tier}`); }
    if (context.priority === 'low' && tier !== 'low') { tier = step(tier, -1); reasons.push(`priority low: down to ${tier}`); }
    if (context.latencyTargetMs != null && context.latencyTargetMs <= 3000 && tier === 'high') {
      tier = 'mid'; reasons.push(`latency target ${context.latencyTargetMs}ms: capped at mid`);
    }
    if (context.budgetPercentage >= 90 && context.priority !== 'high' && tier !== 'low') {
      tier = step(tier, -1); reasons.push(`global budget ${context.budgetPercentage.toFixed(0)}% used: down to ${tier}`);
    }
  }
  const resolved = resolveTier(tier, context.allowedTiers, models);
  if (!resolved) throw new Error('No allowed tier has an enabled model');
  if (resolved !== tier) reasons.push(`tier ${tier} unavailable for tenant or registry; using ${resolved}`);
  let final = resolved;
  const cap = context.maxCostUsd;
  if (cap != null && context.worstCase && context.worstCase(final) > cap) {
    const cheaper = TIER_ORDER.slice(0, TIER_ORDER.indexOf(final)).reverse()
      .filter(t => context.allowedTiers.includes(t) && models.some(m => m.tier === t && m.enabled));
    const fits = cheaper.find(t => context.worstCase!(t) <= cap);
    if (fits) { reasons.push(`max cost $${cap}: down to ${fits}`); final = fits; }
  }
  return { difficulty, tier: final, model: modelForTier(final, models).id, policyVersion, reasons };
}
