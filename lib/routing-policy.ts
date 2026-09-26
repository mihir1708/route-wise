import { estimateDifficulty, selectModel } from '@/lib/difficulty-estimator';
import { modelForTier, runtimeModels, type ModelConfig, type ModelTier } from '@/lib/model-registry';
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
