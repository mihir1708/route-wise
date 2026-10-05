import { billableOutputCap, getModel, modelCost, tierCandidates, type ModelConfig, type ModelTier } from '@/lib/model-registry';
import { getPrompt, promptId, TASK_TYPES, type PromptTemplate, type TaskType } from '@/prompts';
import { randomUUID, createHash } from 'node:crypto';
import type { ModelName, ModelResponse } from '@/types';
import type { CallOptions } from '@/lib/providers';
import { callWithFallback, ChainFailure, type Attempt } from '@/lib/provider-chain';
import { validateJsonOutput } from '@/lib/output-validation';
import { CircuitBreaker, DEFAULT_RETRY_POLICY, sleep as realSleep, type RetryPolicy } from '@/lib/resilience';

export type FailureStage = 'validate' | 'rate_limit' | 'cache' | 'admission' | 'routing' | 'provider' | 'usage_capture' | 'output_validation' | 'accounting' | 'telemetry';
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
  cache_hit: boolean;
  fallback_used: boolean;
  attempt_count: number;
  /** Milliseconds spent in each stage that ran. */
  stage_timings: Record<string, number>;
}

export interface GenerateRequest {
  task_type: TaskType;
  input: string;
  priority: Priority;
  max_cost_usd: number | null;
  latency_target_ms: number | null;
  /** False skips the response cache (the experiment harness uses this). */
  cache: boolean;
  prompt: PromptTemplate;
}

export const MAX_INPUT_CHARS = 16000;
const FIELDS = new Set(['task_type', 'input', 'priority', 'max_cost_usd', 'latency_target_ms', 'prompt_version', 'cache']);

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
  if (b.cache !== undefined && typeof b.cache !== 'boolean') return { error: 'invalid_cache', status: 400 };
  if (b.prompt_version !== undefined && typeof b.prompt_version !== 'string') return { error: 'invalid_prompt_version', status: 400 };
  const prompt = getPrompt(b.task_type as TaskType, b.prompt_version as string | undefined);
  if (!prompt) return { error: 'unknown_prompt_version', status: 400 };
  return {
    task_type: b.task_type as TaskType, input: b.input, priority: priority as Priority,
    max_cost_usd: maxCost as number | null, latency_target_ms: latency as number | null,
    cache: b.cache !== false, prompt,
  };
}

/** Rough pre-call estimate (about 4 characters per token, plus message overhead). */
export function estimateInputTokens(...texts: string[]): number {
  return texts.reduce((sum, t) => sum + Math.ceil(t.length / 4) + 4, 0);
}

/** Worst-case USD for one call on a tier: full billable output on the priciest of its primary and fallbacks. */
export function tierWorstCase(tier: ModelTier, models: readonly ModelConfig[], inputTokens: number, outputCap: number): number {
  return Math.max(0, ...tierCandidates(tier, models).map(m => modelCost(m, inputTokens, billableOutputCap(m, outputCap))));
}

export interface RateLimitResult { allowed: boolean; window_start: string; reason?: string; retry_after_s?: number }
export interface Admission { tenantSpent: number; tenantBudget: number; globalSpent: number; globalLimit: number }
export interface Decision { model: ModelName; tier: ModelTier; difficulty: number; policyVersion: string; reasons: string[] }
export interface RouteContext {
  budgetPercentage: number;
  /** Worst-case USD for this request on a tier, across its primary and fallback. */
  worstCase(tier: ModelTier): number;
}
/** What the response cache keeps: the answer and where it came from. Never the input. */
export interface CachedAnswer { answer: string; model: string; tier: ModelTier }

export interface GenerateDependencies {
  models: readonly ModelConfig[];
  allowedTiers: readonly ModelTier[];
  takeRateLimit(tokens: number): Promise<RateLimitResult>;
  adjustTokens(windowStart: string, delta: number): Promise<void>;
  admit(): Promise<Admission>;
  route(request: GenerateRequest, context: RouteContext): Promise<Decision>;
  /** One provider call; retries and fallback happen around it. */
  call(user: string, model: ModelConfig, options: CallOptions): Promise<ModelResponse>;
  settle(cost: number, model: ModelName, tier: ModelTier): Promise<void>;
  persist(run: RequestRun, attempts: Attempt[]): Promise<void>;
  cacheGet?(key: string): Promise<CachedAnswer | null>;
  cachePut?(key: string, entry: CachedAnswer): Promise<void>;
  breaker?: CircuitBreaker;
  retryPolicy?: RetryPolicy;
  sleep?(ms: number): Promise<void>;
  random?(): number;
}

export interface GenerateResult {
  status: number;
  body: Record<string, unknown>;
  headers: Record<string, string>;
  run: RequestRun;
  attempts: Attempt[];
}

class Rejection extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); }
}

const TIERS: readonly ModelTier[] = ['low', 'mid', 'high'];
/** Rounds away float noise (e.g. 0.00066000000000000001) in amounts shown to callers. */
const usd = (n: number) => Math.round(n * 1e9) / 1e9;

/** Cache key: the prompt version and the exact input. Tenant scoping happens in the table key. */
export function cacheKey(prompt: PromptTemplate, input: string): string {
  return createHash('sha256').update(`${promptId(prompt)}\n${input}`).digest('hex');
}

/**
 * One gateway request, in fixed stages. Every outcome, including rejections,
 * produces a telemetry row with the stage it stopped at, plus one row per provider
 * attempt; raw input and output never appear in either.
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
    cache_hit: false, fallback_used: false, attempt_count: 0, stage_timings: {},
  };
  const headers: Record<string, string> = {};
  const attempts: Attempt[] = [];
  let stage: FailureStage = 'validate';
  let stageStarted = started;
  const enter = (next: FailureStage) => {
    const now = Date.now();
    run.stage_timings[stage] = (run.stage_timings[stage] ?? 0) + now - stageStarted;
    stage = next; stageStarted = now;
  };
  let status = 200;
  let payload: Record<string, unknown> = {};
  let reservation: { window: string; tokens: number } | null = null;
  let tokensUsed: number | null = null;
  // Money already spent at the provider, settled even if a later step fails.
  const spend = { cost: 0, prompt: 0, completion: 0, model: null as ModelConfig | null, settled: false };
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
    const outputCap = request.prompt.maxOutputTokens;
    const worstCase = (tier: ModelTier) => tierWorstCase(tier, deps.models, inputTokens, outputCap);
    const enabled = deps.models.filter(m => m.enabled);
    const reserved = inputTokens + Math.max(outputCap, ...enabled.map(m => billableOutputCap(m, outputCap)));

    enter('rate_limit');
    const limit = await deps.takeRateLimit(reserved);
    if (!limit.allowed) {
      headers['Retry-After'] = String(limit.retry_after_s ?? 60);
      throw new Rejection(limit.reason ?? 'rate_limited', 429);
    }
    reservation = { window: limit.window_start, tokens: reserved };
    tokensUsed = 0;

    enter('cache');
    // High-priority requests always get a fresh answer.
    const key = request.cache && request.priority !== 'high' && deps.cacheGet ? cacheKey(request.prompt, request.input) : null;
    let hit: CachedAnswer | null = null;
    if (key) {
      try { hit = await deps.cacheGet!(key); } catch { hit = null; } // a cache outage is a miss
      if (hit && request.prompt.schema && !validateJsonOutput(hit.answer, request.prompt.schema).ok) hit = null;
    }

    if (hit) {
      Object.assign(run, {
        cache_hit: true, selected_model: hit.model, selected_tier: hit.tier, routing_policy_version: 'cache',
        prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost_usd: 0, application_succeeded: true,
      });
      payload = {
        answer: hit.answer,
        ...(request.prompt.schema ? { output: (validateJsonOutput(hit.answer, request.prompt.schema) as { value: unknown }).value } : {}),
        metadata: {
          request_id: requestId, task_type: request.task_type, prompt_version: run.prompt_version,
          model: hit.model, tier: hit.tier, cache_hit: true, fallback_used: false, escalated: false, truncated: false, attempts: 0,
          tokens: { input: 0, output: 0, total: 0 }, cost_usd: 0, accounting_status: 'not_charged',
        },
      };
    } else {
      enter('admission');
      const a = await deps.admit();
      if (![a.tenantSpent, a.tenantBudget, a.globalSpent, a.globalLimit].every(Number.isFinite) || a.globalLimit <= 0) {
        throw new Error('invalid_budget');
      }
      run.budget_percentage = a.globalSpent / a.globalLimit * 100;
      if (run.budget_percentage >= 100) throw new Rejection('budget_exhausted', 503);
      if (a.tenantSpent >= a.tenantBudget) throw new Rejection('tenant_budget_exhausted', 402);
      const tenantRemaining = a.tenantBudget - a.tenantSpent;

      enter('routing');
      const decision = await deps.route(request, { budgetPercentage: run.budget_percentage, worstCase });
      const routed = getModel(decision.model, deps.models);
      run.routing_policy_version = decision.policyVersion;
      run.route_reasons = [...decision.reasons];
      run.selected_model = decision.model;
      run.selected_tier = decision.tier;
      run.pricing_version = routed.pricingVersion;
      run.estimated_difficulty = decision.difficulty;
      if (request.max_cost_usd !== null && worstCase(decision.tier) > request.max_cost_usd) throw new Rejection('max_cost_exceeded', 402);
      if (worstCase(decision.tier) > tenantRemaining) throw new Rejection('tenant_budget_exhausted', 402);

      const chain = {
        call: deps.call, breaker: deps.breaker ?? new CircuitBreaker(), sleep: deps.sleep ?? realSleep,
        retryPolicy: deps.retryPolicy ?? DEFAULT_RETRY_POLICY, random: deps.random,
      };
      const deadline = request.latency_target_ms === null ? null : started + request.latency_target_ms;
      // Failed attempts the provider still billed (empty or refused answers) are charged like answers.
      const chargeFailedAttempts = (from: number) => {
        for (const t of attempts.slice(from)) {
          if (t.outcome !== 'error' || t.cost_usd === null) continue;
          Object.assign(spend, {
            cost: spend.cost + t.cost_usd, prompt: spend.prompt + (t.prompt_tokens ?? 0),
            completion: spend.completion + (t.completion_tokens ?? 0), model: spend.model ?? getModel(t.model, deps.models),
          });
        }
      };
      const callTier = async (tier: ModelTier) => {
        enter('provider');
        const from = attempts.length;
        let result: Awaited<ReturnType<typeof callWithFallback>>;
        try {
          result = await callWithFallback(tierCandidates(tier, deps.models), user,
            { system: request.prompt.system, maxOutputTokens: outputCap }, chain, attempts, deadline);
        } finally { chargeFailedAttempts(from); }
        run.provider_succeeded = true;
        enter('usage_capture');
        const r = result.response;
        if (![r.prompt_tokens, r.completion_tokens, r.total_tokens].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error('invalid_usage');
        const cost = modelCost(result.model, r.prompt_tokens, r.completion_tokens);
        if (!Number.isFinite(cost) || cost < 0) throw new Error('invalid_cost');
        Object.assign(spend, { cost: spend.cost + cost, prompt: spend.prompt + r.prompt_tokens, completion: spend.completion + r.completion_tokens, model: result.model });
        run.selected_model = result.model.id; run.selected_tier = tier; run.pricing_version = result.model.pricingVersion;
        run.fallback_used = result.model.id !== tierCandidates(tier, deps.models)[0]?.id;
        return r;
      };

      let tier = decision.tier;
      let response = await callTier(tier);
      let output: unknown;
      if (request.prompt.schema) {
        enter('output_validation');
        let check = validateJsonOutput(response.content, request.prompt.schema);
        if (!check.ok) {
          attempts[attempts.length - 1].outcome = 'invalid_output';
          attempts[attempts.length - 1].error_kind = `schema: ${check.error}`.slice(0, 120);
          // One escalation to the next tier up the tenant may use, if it is affordable.
          const up = TIERS.slice(TIERS.indexOf(tier) + 1)
            .find(t => deps.allowedTiers.includes(t) && tierCandidates(t, deps.models).length > 0);
          const affordable = up && spend.cost + worstCase(up) <= tenantRemaining &&
            (request.max_cost_usd === null || spend.cost + worstCase(up) <= request.max_cost_usd);
          if (!up || !affordable) {
            run.route_reasons.push(`output failed validation on ${tier}; ${up ? 'escalation not affordable' : 'no higher tier'}`);
            throw new Rejection('invalid_model_output', 502);
          }
          run.escalated = true;
          run.route_reasons.push(`output failed validation on ${tier} (${check.error}); escalated to ${up}`);
          tier = up;
          response = await callTier(tier);
          enter('output_validation');
          check = validateJsonOutput(response.content, request.prompt.schema);
          if (!check.ok) {
            attempts[attempts.length - 1].outcome = 'invalid_output';
            attempts[attempts.length - 1].error_kind = `schema: ${check.error}`.slice(0, 120);
            throw new Rejection('invalid_model_output', 502);
          }
        }
        output = check.value;
      }
      run.prompt_tokens = spend.prompt;
      run.completion_tokens = spend.completion;
      run.total_tokens = spend.prompt + spend.completion;
      run.cost_usd = spend.cost;
      tokensUsed = run.total_tokens;

      enter('accounting');
      let accountingStatus = 'settled';
      spend.settled = true;
      try { await deps.settle(spend.cost, spend.model!.id, tier); }
      catch { run.failure_stage = stage; run.error_category = 'settlement_failed'; accountingStatus = 'failed'; }
      if (key && deps.cachePut && !response.truncated) {
        try { await deps.cachePut(key, { answer: response.content, model: spend.model!.id, tier }); }
        catch { console.error('cache_store_failed', { request_id: requestId }); }
      }
      // Once a valid answer is obtained, bookkeeping failure is non-fatal and visible.
      run.application_succeeded = true;
      payload = {
        answer: response.content,
        ...(request.prompt.schema ? { output } : {}),
        metadata: {
          request_id: requestId, task_type: request.task_type, prompt_version: run.prompt_version,
          model: spend.model!.id, tier, provider: spend.model!.provider, cache_hit: false,
          fallback_used: run.fallback_used, escalated: run.escalated, truncated: Boolean(response.truncated),
          attempts: attempts.length, route_reasons: run.route_reasons, difficulty_score: decision.difficulty,
          tokens: { input: spend.prompt, output: spend.completion, total: run.total_tokens },
          cost_usd: usd(run.cost_usd), accounting_status: accountingStatus,
          tenant_budget: a.tenantBudget, tenant_budget_remaining: usd(Math.max(0, tenantRemaining - run.cost_usd)),
        },
      };
    }
  } catch (error) {
    run.failure_stage = stage;
    if (error instanceof Rejection) {
      status = error.status;
      run.error_category = error.code;
    } else if (error instanceof ChainFailure) {
      status = 502;
      run.error_category = 'all_providers_failed';
    } else {
      status = ['provider', 'usage_capture'].includes(stage) ? 502 : 503;
      run.error_category = `${stage}_failed`;
    }
    payload = { error: run.error_category, request_id: requestId };
    if (['provider', 'usage_capture', 'output_validation'].includes(stage)) {
      // Nothing was sent if every attempt was skipped by an open circuit; otherwise usage is unknown.
      tokensUsed = attempts.every(t => t.outcome === 'circuit_open') && spend.cost === 0 ? 0 : null;
    }
    // A paid-for answer that then failed validation is still charged to the tenant.
    if (spend.cost > 0 && !spend.settled && spend.model) {
      run.cost_usd = spend.cost; run.prompt_tokens = spend.prompt; run.completion_tokens = spend.completion;
      run.total_tokens = spend.prompt + spend.completion;
      try { await deps.settle(spend.cost, spend.model.id, spend.model.tier); }
      catch { run.error_category += ':unsettled'; }
    }
  }
  enter('telemetry');
  run.latency_ms = Date.now() - started;
  run.attempt_count = attempts.length;
  if (payload.metadata) (payload.metadata as Record<string, unknown>).latency_ms = run.latency_ms;
  // Return unused reserved tokens; a call with unknown usage keeps its whole reservation.
  if (reservation && tokensUsed !== null && tokensUsed !== reservation.tokens) {
    try { await deps.adjustTokens(reservation.window, tokensUsed - reservation.tokens); }
    catch { console.error('rate_token_adjust_failed', { request_id: requestId }); }
  }
  try { await deps.persist(run, attempts); }
  catch {
    // Do not expose prompts/provider messages in the fallback log.
    console.error('telemetry_persistence_failed', { request_id: requestId, failure_stage: run.failure_stage });
    if (!run.failure_stage) { run.failure_stage = 'telemetry'; run.error_category = 'persistence_failed'; }
  }
  return { status, body: payload, headers, run, attempts };
}
