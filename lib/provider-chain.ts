// Calls one tier's models in order (primary, then fallback), retrying transient errors with backoff.
import { modelCost, type ModelConfig, type ModelTier, type Provider } from '@/lib/model-registry';
import { classifyProviderError, type CallOptions } from '@/lib/providers';
import { backoffDelay, type CircuitBreaker, type RetryPolicy } from '@/lib/resilience';
import type { ModelResponse } from '@/types';

export type AttemptOutcome = 'ok' | 'error' | 'circuit_open' | 'invalid_output';
/** One row per provider call (or skipped call) in request_attempts. Never holds prompt or answer text. */
export interface Attempt {
  attempt: number;
  model: string;
  provider: Provider;
  tier: ModelTier;
  outcome: AttemptOutcome;
  error_kind: string | null;
  http_status: number | null;
  latency_ms: number;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cost_usd: number | null;
}

export interface ChainDependencies {
  call(user: string, model: ModelConfig, options: CallOptions): Promise<ModelResponse>;
  breaker: CircuitBreaker;
  sleep(ms: number): Promise<void>;
  retryPolicy: RetryPolicy;
  random?: () => number;
  now?: () => number;
}

export class ChainFailure extends Error {
  constructor(readonly lastErrorKind: string) { super(`all_providers_failed:${lastErrorKind}`); }
}

const usageValid = (r: ModelResponse) =>
  [r.prompt_tokens, r.completion_tokens, r.total_tokens].every(n => Number.isSafeInteger(n) && n >= 0);

/**
 * Returns the first successful response. Appends every attempt, including skipped and failed
 * ones, to `attempts`. Retries stop early when the next wait would pass `deadline` (epoch ms).
 */
export async function callWithFallback(
  candidates: readonly ModelConfig[], user: string, options: CallOptions,
  deps: ChainDependencies, attempts: Attempt[], deadline: number | null = null,
): Promise<{ response: ModelResponse; model: ModelConfig }> {
  const now = deps.now ?? Date.now;
  let lastKind = 'no_candidates';
  for (const model of candidates) {
    const record = (fields: Partial<Attempt>) => attempts.push({
      attempt: attempts.length + 1, model: model.id, provider: model.provider, tier: model.tier, outcome: 'error',
      error_kind: null, http_status: null, latency_ms: 0, prompt_tokens: null, completion_tokens: null, cost_usd: null, ...fields,
    });
    for (let tryNo = 1; tryNo <= deps.retryPolicy.maxAttempts; tryNo++) {
      if (!deps.breaker.tryAcquire(model.id)) {
        record({ outcome: 'circuit_open', error_kind: 'circuit_open' }); lastKind = 'circuit_open';
        break;
      }
      const started = now();
      try {
        const response = await deps.call(user, model, options);
        deps.breaker.success(model.id);
        const valid = usageValid(response);
        record({
          outcome: 'ok', latency_ms: now() - started,
          prompt_tokens: valid ? response.prompt_tokens : null, completion_tokens: valid ? response.completion_tokens : null,
          cost_usd: valid ? modelCost(model, response.prompt_tokens, response.completion_tokens) : null,
        });
        return { response, model };
      } catch (error) {
        const e = classifyProviderError(error);
        if (e.retryable) deps.breaker.failure(model.id); else deps.breaker.release(model.id);
        // A failed call can still be billed (an empty or refused answer); record it so it is charged.
        record({
          error_kind: e.kind, http_status: e.status, latency_ms: now() - started,
          ...(e.usage ? { ...e.usage, cost_usd: modelCost(model, e.usage.prompt_tokens, e.usage.completion_tokens) } : {}),
        });
        lastKind = e.kind;
        if (!e.retryable || tryNo === deps.retryPolicy.maxAttempts) break;
        const delay = backoffDelay(tryNo, deps.retryPolicy, e.retryAfterMs, deps.random);
        if (delay === null || (deadline !== null && now() + delay > deadline)) break;
        await deps.sleep(delay);
      }
    }
  }
  throw new ChainFailure(lastKind);
}
