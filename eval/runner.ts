import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { heuristicV1, type RoutingPolicy } from '@/lib/routing-policy';
import { modelForTier, modelCost, runtimeModels, type ModelConfig, type ModelTier } from '@/lib/model-registry';
import type { ModelResponse } from '@/types';
import type { Dataset, EvalCase } from './schema';
export type Strategy = 'low-only' | 'mid-only' | 'high-only' | 'heuristic-v1' | 'heuristic-v2';
export interface EvalRecord {
  eval_case_id: string; eval_run_id: string; strategy: Strategy; routing_policy_version: string;
  selected_tier: ModelTier; selected_model: string; difficulty_score: number | null; route_reasons: string[];
  task_type: EvalCase['task_type']; intended_difficulty: EvalCase['intended_difficulty'];
  input_tokens: number | null; output_tokens: number | null; latency_ms: number | null;
  estimated_cost: number | null; response: string | null;
  status: 'dry_run' | 'completed' | 'failed'; error: string | null;
  quality: number | null; scoring_status: string;
  judge?: { model: string; version: string; cost: number | null; input_tokens: number | null; output_tokens: number | null; latency_ms: number; reason: string };
}
export interface EvalRun {
  run_id: string; timestamp: string; git_commit: string | null; dataset_version: string;
  routing_policy_versions: string[]; registry_pricing_versions: string[]; runtime_models: readonly ModelConfig[];
  mode: 'dry-run' | 'live'; reviewed_cases: number; records: EvalRecord[];
}
export function isCI(env = process.env): boolean {
  return Boolean(env.CI && !['false','0'].includes(env.CI));
}
export function liveEvalAllowed(env = process.env): boolean {
  return env.ROUTEWISE_LIVE_EVAL === '1' && !isCI(env);
}
export async function runEvaluation(dataset: Dataset, options: {
  strategies: Strategy[]; limit?: number; dryRun?: boolean; models?: readonly ModelConfig[];
  policyV2?: RoutingPolicy;
  call: (query: string, model: string) => Promise<ModelResponse>;
}): Promise<EvalRun> {
  const models = options.models ?? runtimeModels();
  const limit = options.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('Limit must be 1..500');
  if (!options.strategies.length) throw new Error('At least one strategy required');
  // Validate all requested strategies before making any calls.
  for (const strategy of options.strategies) {
    if (strategy.endsWith('-only')) modelForTier(strategy.split('-')[0] as ModelTier, models);
    else if (strategy === 'heuristic-v2') { if (!options.policyV2) throw new Error('V2 requires measured-evidence configuration'); }
    else if (strategy !== 'heuristic-v1') throw new Error('Unknown strategy');
  }
  let commit: string | null = null;
  try { commit = execFileSync('git', ['rev-parse','HEAD'], { encoding: 'utf8', stdio: ['ignore','pipe','ignore'] }).trim(); } catch { /* no Git metadata */ }
  const run: EvalRun = {
    run_id: randomUUID(), timestamp: new Date().toISOString(), git_commit: commit,
    dataset_version: dataset.version, routing_policy_versions: [],
    registry_pricing_versions: [...new Set(models.map(m => m.pricingVersion))], runtime_models: models,
    mode: !options.dryRun && liveEvalAllowed() ? 'live' : 'dry-run',
    reviewed_cases: dataset.cases.slice(0,limit).filter(c => c.reviewed).length, records: [],
  };
  for (const c of dataset.cases.slice(0,limit)) for (const strategy of options.strategies) {
    const policy = strategy === 'heuristic-v2' ? options.policyV2! : heuristicV1;
    const decision = strategy.endsWith('-only') ? null : await policy.route(c.prompt, { budgetPercentage: 0, models });
    const model = decision ? models.find(m => m.id === decision.model)! : modelForTier(strategy.split('-')[0] as ModelTier, models);
    const record: EvalRecord = {
      eval_case_id: c.id, eval_run_id: run.run_id, strategy, routing_policy_version: decision?.policyVersion ?? `fixed-${model.tier}-v1`,
      selected_tier: model.tier, selected_model: model.id, difficulty_score: decision?.difficulty ?? null,
      route_reasons: decision?.reasons ?? ['fixed tier baseline'], task_type: c.task_type, intended_difficulty: c.intended_difficulty,
      input_tokens: null, output_tokens: null, latency_ms: null, estimated_cost: null, response: null,
      status: 'dry_run', error: null, quality: null, scoring_status: 'not_scored',
    };
    if (run.mode === 'live') {
      const started = Date.now();
      try {
        // Defense in depth if opt-in changes during an embedded run.
        if (!liveEvalAllowed()) throw new Error('Live evaluation not opted in');
        const result = await options.call(c.prompt, model.id);
        record.response = result.content;
        if (![result.prompt_tokens,result.completion_tokens].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error('Usage unavailable');
        record.input_tokens = result.prompt_tokens; record.output_tokens = result.completion_tokens;
        record.estimated_cost = modelCost(model,result.prompt_tokens,result.completion_tokens); record.status = 'completed';
      } catch { record.status = 'failed'; record.error = 'provider_or_usage_failed'; }
      record.latency_ms = Date.now() - started;
    }
    run.records.push(record);
  }
  run.routing_policy_versions = [...new Set(run.records.map(r => r.routing_policy_version))];
  return run;
}
