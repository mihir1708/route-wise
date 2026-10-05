import type { RoutingPolicy } from './routing-policy';
import { modelForTier, runtimeModels } from './model-registry';
export function routingFeatures(query: string) {
  return {
    length: Math.min(query.length/2000,1),
    constraints: Math.min((query.match(/\b(must|only|exactly|without|at least|no more than)\b/gi) ?? []).length/5,1),
    multipart: Math.min((query.match(/(?:^|\n)\s*(?:\d+[.)]|[-*])\s/g) ?? []).length/5,1),
    code: /```|\b(function|class|def)\s+\w+/.test(query) ? 1 : 0,
    structured: /\b(json|csv|schema)\b/i.test(query) ? 1 : 0,
    reasoning: /\b(prove|derive|counterexample|invariant)\b/i.test(query) ? 1 : 0,
  };
}
export interface V2Config {
  version: string; evidenceRunId: string; rationale: string; bias: number;
  weights: Record<keyof ReturnType<typeof routingFeatures>, number>;
  highThreshold: number; midThreshold: number;
}
export function createHeuristicV2(config: V2Config, evidence: { run_id: string; evidence: string; cases: unknown[] }): RoutingPolicy {
  if (!config.version?.startsWith('heuristic-v2-') || !config.rationale?.trim() || evidence.evidence !== 'paired_live_scores' ||
    !evidence.cases.length || config.evidenceRunId !== evidence.run_id) throw new Error('V2 requires measured failure evidence and an explicit rationale');
  const keys = Object.keys(routingFeatures('')) as (keyof V2Config['weights'])[];
  if (!Number.isFinite(config.bias) || !config.weights || keys.some(k => !Number.isFinite(config.weights[k])) ||
    !Number.isFinite(config.midThreshold) || !Number.isFinite(config.highThreshold) || config.midThreshold < 0 || config.midThreshold >= config.highThreshold || config.highThreshold > 1) throw new Error('Invalid feature policy configuration');
  return { version: config.version, async route(query,context) {
    const features = routingFeatures(query);
    const difficulty = Math.max(0,Math.min(1,config.bias+keys.reduce((s,k) => s+features[k]*config.weights[k],0)));
    const models = context.models ?? runtimeModels();
    const adjustment = context.budgetPercentage >= 90 ? 0.15 : context.budgetPercentage >= 80 ? 0.05 : 0;
    const tier = difficulty >= Math.min(1,config.highThreshold+adjustment) ? 'high' :
      models.some(m => m.enabled && m.tier === 'mid') && difficulty >= config.midThreshold+adjustment ? 'mid' : 'low';
    return { difficulty, tier, model: modelForTier(tier,models).id, policyVersion: config.version,
      reasons: [...keys.map(k => `${k}=${features[k]}, weight=${config.weights[k]}`), `bias=${config.bias}`, `budget_adjustment=${adjustment}`, `evidence=${config.evidenceRunId}`] };
  } };
}
