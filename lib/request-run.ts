import { getModel } from '@/lib/model-registry';
import { randomUUID, createHash } from 'node:crypto';
import type { ModelName, ModelResponse } from '@/types';

export type FailureStage = 'validate' | 'admission' | 'routing' | 'provider' | 'usage_capture' | 'accounting' | 'telemetry';
export interface RequestRun {
  request_id: string;
  timestamp: string;
  query_hash: string | null;
  selected_model: string | null;
  selected_tier: 'low' | 'mid' | 'high' | null;
  routing_policy_version: string;
  pricing_version: string;
  budget_percentage: number | null;
  escalated: boolean;
  route_reasons: string[];
  estimated_difficulty: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  cost_usd: number | null;
  latency_ms: number;
  provider_succeeded: boolean;
  application_succeeded: boolean;
  failure_stage: FailureStage | null;
  error_category: string | null;
}
export interface RunDependencies {
  admit(): Promise<{ percentage: number; remaining: number; limit?: number }>;
  route(query: string, percentage: number): Promise<{ model: ModelName; difficulty: number; policyVersion?: string; reasons?: string[] }>;
  call(query: string, model: ModelName): Promise<ModelResponse>;
  price(model: ModelName, input: number, output: number): number;
  settle(cost: number, model: ModelName): Promise<void>;
  persist(run: RequestRun): Promise<void>;
}
export async function executeQuery(query: unknown, deps: RunDependencies, requestId = randomUUID()) {
  const started = Date.now();
  const run: RequestRun = {
    request_id: requestId, timestamp: new Date().toISOString(), query_hash: null,
    selected_model: null, selected_tier: null, routing_policy_version: 'heuristic-v1',
    pricing_version: 'legacy-2026-01', budget_percentage: null, escalated: false, route_reasons: [], estimated_difficulty: null, prompt_tokens: null,
    completion_tokens: null, total_tokens: null, cost_usd: null, latency_ms: 0,
    provider_succeeded: false, application_succeeded: false, failure_stage: null, error_category: null,
  };
  let stage: FailureStage = 'validate';
  let status = 200;
  let body: Record<string, unknown> = {};
  try {
    if (typeof query !== 'string' || !query.trim() || query.length > 16000) {
      status = typeof query === 'string' && query.length > 16000 ? 413 : 400;
      throw new Error('invalid_query');
    }
    run.query_hash = createHash('sha256').update(query).digest('hex');
    stage = 'admission';
    const budget = await deps.admit();
    if (!Number.isFinite(budget.percentage) || !Number.isFinite(budget.remaining)) throw new Error('invalid_budget');
    run.budget_percentage = budget.percentage;
    if (budget.percentage >= 100) { status = 503; throw new Error('budget_exhausted'); }
    stage = 'routing';
    const decision = await deps.route(query, budget.percentage);
    run.routing_policy_version = decision.policyVersion ?? 'heuristic-v1';
    run.route_reasons = decision.reasons ?? [];
    run.selected_model = decision.model;
    run.selected_tier = getModel(decision.model).tier;
    run.pricing_version = getModel(decision.model).pricingVersion;
    run.estimated_difficulty = decision.difficulty;
    stage = 'provider';
    const response = await deps.call(query, decision.model);
    run.provider_succeeded = true;
    stage = 'usage_capture';
    const usage = [response.prompt_tokens, response.completion_tokens, response.total_tokens];
    if (!usage.every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error('invalid_usage');
    run.prompt_tokens = response.prompt_tokens;
    run.completion_tokens = response.completion_tokens;
    run.total_tokens = response.total_tokens;
    run.cost_usd = deps.price(decision.model, response.prompt_tokens, response.completion_tokens);
    if (!Number.isFinite(run.cost_usd) || run.cost_usd < 0) throw new Error('invalid_cost');
    stage = 'accounting';
    let accountingStatus = 'settled';
    try { await deps.settle(run.cost_usd, decision.model); }
    catch { run.failure_stage = stage; run.error_category = 'settlement_failed'; accountingStatus = 'failed'; }
    // Once a valid answer is obtained, bookkeeping failure is non-fatal and visible.
    run.application_succeeded = true;
    body = { answer: response.content, metadata: {
      request_id: requestId, model_used: decision.model, difficulty_score: decision.difficulty,
      tokens_used: response.total_tokens, cost: run.cost_usd,
      remaining_budget: Math.max(0, budget.remaining - run.cost_usd),
      accounting_status: accountingStatus, budget_limit: budget.limit ?? 100, model_tier: run.selected_tier,
    } };
  } catch (error) {
    run.failure_stage = stage;
    run.error_category = stage === 'validate' || status === 503 ? (error as Error).message : `${stage}_failed`;
    if (status === 200) status = stage === 'provider' || stage === 'usage_capture' ? 502 : 503;
    body = { error: run.error_category, request_id: requestId };
  }
  run.latency_ms = Date.now() - started;
  try { await deps.persist(run); }
  catch {
    // Do not expose prompts/provider messages in the fallback log.
    console.error('telemetry_persistence_failed', { request_id: requestId, failure_stage: run.failure_stage });
    if (!run.failure_stage) { run.failure_stage = 'telemetry'; run.error_category = 'persistence_failed'; }
  }
  return { status, body, run };
}
