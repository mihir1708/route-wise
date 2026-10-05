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

// Base tier per task type until rules-v1 adds priority, difficulty and cost caps.
export const TASK_DEFAULT_TIERS: Readonly<Record<Exclude<TaskType, 'chat'>, ModelTier>> = {
  classify: 'low', extract: 'low', summarize: 'mid', draft_reply: 'mid', troubleshoot: 'high',
};

export interface TaskRoutingContext { budgetPercentage: number; allowedTiers: readonly ModelTier[]; models?: readonly ModelConfig[] }

/** Chat keeps the original heuristic-v1 router; other tasks use their default tier. */
export async function routeTask(task: TaskType, input: string, context: TaskRoutingContext): Promise<RoutingDecision> {
  const models = context.models ?? runtimeModels();
  const base = task === 'chat'
    ? await heuristicV1.route(input, { budgetPercentage: context.budgetPercentage, models })
    : { difficulty: 0, tier: TASK_DEFAULT_TIERS[task], policyVersion: 'task-default-v0', reasons: [`task ${task} defaults to ${TASK_DEFAULT_TIERS[task]}`] };
  const tier = resolveTier(base.tier, context.allowedTiers, models);
  if (!tier) throw new Error('No allowed tier has an enabled model');
  const reasons = tier === base.tier ? base.reasons : [...base.reasons, `tier ${base.tier} unavailable for tenant or registry; using ${tier}`];
  return { difficulty: base.difficulty, tier, model: modelForTier(tier, models).id, policyVersion: base.policyVersion, reasons };
}
