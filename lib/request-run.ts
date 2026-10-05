import { getModel, type ModelTier } from '@/lib/model-registry';
import { getPrompt, promptId, TASK_TYPES, type PromptTemplate, type TaskType } from '@/prompts';
import { randomUUID, createHash } from 'node:crypto';
import type { ModelName, ModelResponse } from '@/types';
import type { CallOptions } from '@/lib/model-client';

export type FailureStage = 'validate' | 'rate_limit' | 'admission' | 'routing' | 'provider' | 'usage_capture' | 'accounting' | 'telemetry';
export type Priority = 'low' | 'normal' | 'high';
export interface RequestRun {
  request_id: string;
  timestamp: string;
  tenant_id: string | null;
  task_type: TaskType | null;
  priority: Priority | null;
  prompt_version: string | null;
  latency_target_ms: number | null;
  query_hash: string | null;
  selected_model: string | null;
  selected_tier: ModelTier | null;
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

export interface GenerateRequest {
  task_type: TaskType;
  input: string;
  priority: Priority;
  max_cost_usd: number | null;
  latency_target_ms: number | null;
  prompt: PromptTemplate;
}

export const MAX_INPUT_CHARS = 16000;
const FIELDS = new Set(['task_type', 'input', 'priority', 'max_cost_usd', 'latency_target_ms', 'prompt_version']);

/** A parsed request, or the error code and HTTP status to return. */
export function parseGenerateRequest(body: unknown): GenerateRequest | { error: string; status: number } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'body_must_be_object', status: 400 };
  const b = body as Record<string, unknown>;
  const unknown = Object.keys(b).find(k => !FIELDS.has(k));
  if (unknown) return { error: `unknown_field:${unknown}`, status: 400 };
  if (!TASK_TYPES.includes(b.task_type as TaskType)) return { error: 'invalid_task_type', status: 400 };
  if (typeof b.input !== 'string' || !b.input.trim()) return { error: 'invalid_input', status: 400 };
  if (b.input.length > MAX_INPUT_CHARS) return { error: 'input_too_large', status: 413 };
  const priority = b.priority ?? 'normal';
  if (!['low', 'normal', 'high'].includes(priority as string)) return { error: 'invalid_priority', status: 400 };
  const maxCost = b.max_cost_usd ?? null;
  if (maxCost !== null && (typeof maxCost !== 'number' || !Number.isFinite(maxCost) || maxCost <= 0 || maxCost > 10)) {
    return { error: 'invalid_max_cost_usd', status: 400 };
  }
  const latency = b.latency_target_ms ?? null;
  if (latency !== null && (!Number.isSafeInteger(latency) || (latency as number) < 500 || (latency as number) > 120000)) {
    return { error: 'invalid_latency_target_ms', status: 400 };
  }
  if (b.prompt_version !== undefined && typeof b.prompt_version !== 'string') return { error: 'invalid_prompt_version', status: 400 };
  const prompt = getPrompt(b.task_type as TaskType, b.prompt_version as string | undefined);
  if (!prompt) return { error: 'unknown_prompt_version', status: 400 };
  return {
    task_type: b.task_type as TaskType, input: b.input, priority: priority as Priority,
    max_cost_usd: maxCost as number | null, latency_target_ms: latency as number | null, prompt,
  };
}

/** Rough pre-call estimate (about 4 characters per token, plus message overhead). */
export function estimateInputTokens(...texts: string[]): number {
  return texts.reduce((sum, t) => sum + Math.ceil(t.length / 4) + 4, 0);
}

export interface RateLimitResult { allowed: boolean; window_start: string; reason?: string; retry_after_s?: number }
export interface Admission { tenantSpent: number; tenantBudget: number; globalSpent: number; globalLimit: number }
export interface Decision { model: ModelName; tier: ModelTier; difficulty: number; policyVersion: string; reasons: string[] }

export interface GenerateDependencies {
  takeRateLimit(tokens: number): Promise<RateLimitResult>;
  adjustTokens(windowStart: string, delta: number): Promise<void>;
  admit(): Promise<Admission>;
  route(request: GenerateRequest, budgetPercentage: number): Promise<Decision>;
  price(model: ModelName, input: number, output: number): number;
  call(user: string, model: ModelName, options: CallOptions): Promise<ModelResponse>;
  settle(cost: number, model: ModelName, tier: ModelTier): Promise<void>;
  persist(run: RequestRun): Promise<void>;
}

export interface GenerateResult {
  status: number;
  body: Record<string, unknown>;
  headers: Record<string, string>;
  run: RequestRun;
}

class Rejection extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); }
}

/**
 * One gateway request, in fixed stages. Every outcome, including rejections,
 * produces a telemetry row with the stage it stopped at; raw input and output never do.
 */
export async function executeGenerate(
  body: unknown, tenantId: string, deps: GenerateDependencies, requestId: string = randomUUID(),
): Promise<GenerateResult> {
  const started = Date.now();
  const run: RequestRun = {
    request_id: requestId, timestamp: new Date().toISOString(), tenant_id: tenantId,
    task_type: null, priority: null, prompt_version: null, latency_target_ms: null, query_hash: null,
    selected_model: null, selected_tier: null, routing_policy_version: 'unrouted',
    pricing_version: 'unpriced', budget_percentage: null, escalated: false, route_reasons: [], estimated_difficulty: null, prompt_tokens: null,
    completion_tokens: null, total_tokens: null, cost_usd: null, latency_ms: 0,
    provider_succeeded: false, application_succeeded: false, failure_stage: null, error_category: null,
  };
  const headers: Record<string, string> = {};
  let stage: FailureStage = 'validate';
  let status = 200;
  let payload: Record<string, unknown> = {};
  let reservation: { window: string; tokens: number } | null = null;
  let tokensUsed: number | null = null;
  try {
    const request = parseGenerateRequest(body);
    if ('error' in request) throw new Rejection(request.error, request.status);
    run.task_type = request.task_type;
    run.priority = request.priority;
    run.prompt_version = promptId(request.prompt);
    run.latency_target_ms = request.latency_target_ms;
    run.query_hash = createHash('sha256').update(request.input).digest('hex');
    const user = request.prompt.render(request.input);
    const inputTokens = estimateInputTokens(request.prompt.system, user);
    const reserved = inputTokens + request.prompt.maxOutputTokens;

    stage = 'rate_limit';
    const limit = await deps.takeRateLimit(reserved);
    if (!limit.allowed) {
      headers['Retry-After'] = String(limit.retry_after_s ?? 60);
      throw new Rejection(limit.reason ?? 'rate_limited', 429);
    }
    reservation = { window: limit.window_start, tokens: reserved };
    tokensUsed = 0;

    stage = 'admission';
    const a = await deps.admit();
    if (![a.tenantSpent, a.tenantBudget, a.globalSpent, a.globalLimit].every(Number.isFinite) || a.globalLimit <= 0) {
      throw new Error('invalid_budget');
    }
    run.budget_percentage = a.globalSpent / a.globalLimit * 100;
    if (run.budget_percentage >= 100) throw new Rejection('budget_exhausted', 503);
    if (a.tenantSpent >= a.tenantBudget) throw new Rejection('tenant_budget_exhausted', 402);

    stage = 'routing';
    const decision = await deps.route(request, run.budget_percentage);
    const model = getModel(decision.model);
    run.routing_policy_version = decision.policyVersion;
    run.route_reasons = decision.reasons;
    run.selected_model = decision.model;
    run.selected_tier = decision.tier;
    run.pricing_version = model.pricingVersion;
    run.estimated_difficulty = decision.difficulty;
    const maxOutput = Math.min(request.prompt.maxOutputTokens, model.maxOutputTokens);
    const worstCase = deps.price(decision.model, inputTokens, maxOutput);
    if (request.max_cost_usd !== null && worstCase > request.max_cost_usd) throw new Rejection('max_cost_exceeded', 402);
    if (worstCase > a.tenantBudget - a.tenantSpent) throw new Rejection('tenant_budget_exhausted', 402);

    stage = 'provider';
    tokensUsed = null; // unknown until the provider reports usage
    const response = await deps.call(user, decision.model, { system: request.prompt.system, maxOutputTokens: maxOutput });
    run.provider_succeeded = true;

    stage = 'usage_capture';
    const usage = [response.prompt_tokens, response.completion_tokens, response.total_tokens];
    if (!usage.every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error('invalid_usage');
    run.prompt_tokens = response.prompt_tokens;
    run.completion_tokens = response.completion_tokens;
    run.total_tokens = response.total_tokens;
    tokensUsed = response.total_tokens;
    run.cost_usd = deps.price(decision.model, response.prompt_tokens, response.completion_tokens);
    if (!Number.isFinite(run.cost_usd) || run.cost_usd < 0) throw new Error('invalid_cost');

    stage = 'accounting';
    let accountingStatus = 'settled';
    try { await deps.settle(run.cost_usd, decision.model, decision.tier); }
    catch { run.failure_stage = stage; run.error_category = 'settlement_failed'; accountingStatus = 'failed'; }
    // Once a valid answer is obtained, bookkeeping failure is non-fatal and visible.
    run.application_succeeded = true;
    payload = {
      answer: response.content,
      metadata: {
        request_id: requestId, task_type: request.task_type, prompt_version: run.prompt_version,
        model: decision.model, tier: decision.tier, provider: model.provider, fallback_used: false,
        route_reasons: decision.reasons, difficulty_score: decision.difficulty,
        tokens: { input: response.prompt_tokens, output: response.completion_tokens, total: response.total_tokens },
        cost_usd: run.cost_usd, accounting_status: accountingStatus,
        tenant_budget: a.tenantBudget, tenant_budget_remaining: Math.max(0, a.tenantBudget - a.tenantSpent - run.cost_usd),
      },
    };
  } catch (error) {
    run.failure_stage = stage;
    if (error instanceof Rejection) {
      status = error.status;
      run.error_category = error.code;
    } else {
      status = stage === 'provider' || stage === 'usage_capture' ? 502 : 503;
      run.error_category = `${stage}_failed`;
    }
    payload = { error: run.error_category, request_id: requestId };
  }
  run.latency_ms = Date.now() - started;
  if (payload.metadata) (payload.metadata as Record<string, unknown>).latency_ms = run.latency_ms;
  // Return unused reserved tokens; a call with unknown usage keeps its whole reservation.
  if (reservation && tokensUsed !== null && tokensUsed !== reservation.tokens) {
    try { await deps.adjustTokens(reservation.window, tokensUsed - reservation.tokens); }
    catch { console.error('rate_token_adjust_failed', { request_id: requestId }); }
  }
  try { await deps.persist(run); }
  catch {
    // Do not expose prompts/provider messages in the fallback log.
    console.error('telemetry_persistence_failed', { request_id: requestId, failure_stage: run.failure_stage });
    if (!run.failure_stage) { run.failure_stage = 'telemetry'; run.error_category = 'persistence_failed'; }
  }
  return { status, body: payload, headers, run };
}
