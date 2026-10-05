// The dry run: where each config would send every item and what the run could cost. No model calls.
import { modelCost, modelForTier, tierCandidates, type ModelConfig, type ModelTier } from '@/lib/model-registry';
import { estimateInputTokens, tierWorstCase } from '@/lib/request-run';
import { routeTask } from '@/lib/routing-policy';
import { getPrompt, promptId } from '@/prompts';
import { isStructured, type Benchmark, type BenchmarkItem } from './benchmark';
import { CONFIGS, judgeCandidates, judgeWorstCase, type ConfigName } from './harness';
import { JUDGE_SYSTEM, judgeRequest } from './scoring';

const TIERS: readonly ModelTier[] = ['low', 'mid', 'high'];

/**
 * Rough visible output per task, in tokens, for the typical estimate only. Reasoning models are
 * assumed to use a third of their headroom. Real runs report measured cost; these never enter results.
 */
const TYPICAL_OUTPUT_TOKENS: Record<BenchmarkItem['task_type'], number> = {
  classify: 15, extract: 60, summarize: 150, draft_reply: 250, troubleshoot: 450,
};
const TYPICAL_JUDGE_OUTPUT_TOKENS = 60;

function typicalCost(model: ModelConfig, inputTokens: number, visibleOutput: number): number {
  return modelCost(model, inputTokens, visibleOutput + Math.round((model.reasoningHeadroomTokens ?? 0) / 3));
}

export interface ConfigPlan {
  config: ConfigName;
  tiers: Record<ModelTier, number>;
  /** Items whose routed tier cannot fit max_cost_usd; the gateway would refuse them with 402. */
  refused: string[];
  /** Per run of the benchmark, model calls only (judge separate). */
  upper_bound_usd: number;
  typical_usd: number;
  judge_upper_bound_usd: number;
  judge_typical_usd: number;
}

export interface ExperimentPlan {
  configs: ConfigPlan[];
  runs: number;
  prompt_versions: string[];
  policy_versions: string[];
  upper_bound_usd: number;
  typical_usd: number;
}

export async function planExperiment(benchmark: Benchmark, models: readonly ModelConfig[], runs: number): Promise<ExperimentPlan> {
  const promptVersions = new Set<string>();
  const policyVersions = new Set<string>();
  const configs: ConfigPlan[] = [];
  const judgeModels = judgeCandidates(models);
  if (!judgeModels.length) throw new Error('No judge model is enabled in the registry');
  for (const config of CONFIGS) {
    const plan: ConfigPlan = {
      config: config.name, tiers: { low: 0, mid: 0, high: 0 }, refused: [],
      upper_bound_usd: 0, typical_usd: 0, judge_upper_bound_usd: 0, judge_typical_usd: 0,
    };
    for (const item of benchmark.items) {
      const prompt = getPrompt(item.task_type)!;
      promptVersions.add(promptId(prompt));
      const inputTokens = estimateInputTokens(prompt.system, prompt.render(item.input));
      const worstCase = (tier: ModelTier) => tierWorstCase(tier, models, inputTokens, prompt.maxOutputTokens);
      const decision = await routeTask(item.task_type, item.input, {
        budgetPercentage: 0, allowedTiers: config.allowedTiers, models, priority: item.priority,
        latencyTargetMs: item.latency_target_ms, maxCostUsd: item.max_cost_usd, worstCase,
      });
      policyVersions.add(decision.policyVersion);
      if (worstCase(decision.tier) > item.max_cost_usd) { plan.refused.push(item.id); continue; }
      plan.tiers[decision.tier]++;
      // A structured answer that fails its schema may be retried one allowed tier up, within max_cost_usd.
      const up = TIERS.slice(TIERS.indexOf(decision.tier) + 1)
        .find(t => config.allowedTiers.includes(t) && tierCandidates(t, models).length > 0);
      const escalation = isStructured(item) && up && worstCase(up) <= item.max_cost_usd
        ? Math.min(item.max_cost_usd, worstCase(decision.tier) + worstCase(up)) - worstCase(decision.tier) : 0;
      plan.upper_bound_usd += worstCase(decision.tier) + escalation;
      plan.typical_usd += typicalCost(modelForTier(decision.tier, models), inputTokens, TYPICAL_OUTPUT_TOKENS[item.task_type]);
      if (!isStructured(item)) {
        plan.judge_upper_bound_usd += judgeWorstCase(item, judgeModels);
        const answer = 'x'.repeat(TYPICAL_OUTPUT_TOKENS[item.task_type] * 4);
        const judgeInput = estimateInputTokens(JUDGE_SYSTEM, judgeRequest(item, answer));
        plan.judge_typical_usd += typicalCost(judgeModels[0], judgeInput, TYPICAL_JUDGE_OUTPUT_TOKENS);
      }
    }
    configs.push(plan);
  }
  const perRun = (pick: (c: ConfigPlan) => number) => configs.reduce((sum, c) => sum + pick(c), 0);
  return {
    configs, runs,
    prompt_versions: [...promptVersions].sort(),
    policy_versions: [...policyVersions].sort(),
    upper_bound_usd: runs * perRun(c => c.upper_bound_usd + c.judge_upper_bound_usd),
    typical_usd: runs * perRun(c => c.typical_usd + c.judge_typical_usd),
  };
}
