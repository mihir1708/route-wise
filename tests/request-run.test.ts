import { describe, expect, it, vi } from 'vitest';
import { cacheKey, estimateInputTokens, executeGenerate, parseGenerateRequest, type GenerateDependencies } from '@/lib/request-run';
import type { ModelConfig } from '@/lib/model-registry';
import { ProviderError } from '@/lib/providers';
import { CircuitBreaker } from '@/lib/resilience';
import { getPrompt } from '@/prompts';

const m = (id: string, provider: ModelConfig['provider'], tier: ModelConfig['tier'], price: number): ModelConfig => ({
  id, provider, tier, inputPricePerMillion: price, outputPricePerMillion: price, enabled: true, temperature: null, maxOutputTokens: 1000, pricingVersion: 'test',
});
const MODELS = [m('o-low', 'openai', 'low', 1), m('a-low', 'anthropic', 'low', 1), m('o-mid', 'openai', 'mid', 2),
  m('a-mid', 'anthropic', 'mid', 2), m('o-high', 'openai', 'high', 10), m('a-high', 'anthropic', 'high', 10)];
const OK = { content: 'answer', prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 };
const HIGH = { model: 'o-high', tier: 'high', difficulty: 0.8, policyVersion: 'rules-v1', reasons: ['r'] };
const fail = (status: number, retryAfter?: string) =>
  Object.assign(new Error('secret provider detail'), { status, headers: new Headers(retryAfter ? { 'retry-after': retryAfter } : {}) });

const deps = (): GenerateDependencies => ({
  models: MODELS,
  allowedTiers: ['low', 'mid', 'high'],
  takeRateLimit: vi.fn().mockResolvedValue({ allowed: true, window_start: '2026-10-05T02:00:00Z' }),
  adjustTokens: vi.fn().mockResolvedValue(undefined),
  admit: vi.fn().mockResolvedValue({ tenantSpent: 0, tenantBudget: 5, globalSpent: 0, globalLimit: 100 }),
  route: vi.fn().mockResolvedValue(HIGH),
  call: vi.fn().mockResolvedValue(OK),
  settle: vi.fn().mockResolvedValue(undefined),
  persist: vi.fn().mockResolvedValue(undefined),
  sleep: vi.fn().mockResolvedValue(undefined),
  retryPolicy: { maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 100 },
  random: () => 0.5,
});
const body = (extra: Record<string, unknown> = {}) => ({ task_type: 'summarize', input: 'Customer cannot log in.', ...extra });
const TENANT = 'tenant-1';
const calledModels = (d: GenerateDependencies) => (d.call as ReturnType<typeof vi.fn>).mock.calls.map(c => c[1].id);
const reservedOf = (d: GenerateDependencies) => (d.takeRateLimit as ReturnType<typeof vi.fn>).mock.calls[0][0];

it('records success, actual usage, attempts and request metadata', async () => {
  const d = deps(); const r = await executeGenerate(body({ priority: 'high', latency_target_ms: 3000 }), TENANT, d);
  expect(r.status).toBe(200);
  expect(r.run).toMatchObject({
    tenant_id: TENANT, task_type: 'summarize', priority: 'high', prompt_version: 'summarize@v1', latency_target_ms: 3000,
    selected_model: 'o-high', selected_tier: 'high', cost_usd: expect.closeTo(0.0003, 12), provider_succeeded: true, application_succeeded: true,
    fallback_used: false, cache_hit: false, attempt_count: 1,
  });
  expect(r.body.metadata).toMatchObject({ model: 'o-high', tier: 'high', provider: 'openai', fallback_used: false, escalated: false, cost_usd: expect.closeTo(0.0003, 12), tenant_budget_remaining: expect.closeTo(4.9997, 12) });
  expect(d.settle).toHaveBeenCalledWith(expect.closeTo(0.0003, 12), 'o-high', 'high');
  expect(d.persist).toHaveBeenCalledWith(r.run, [expect.objectContaining({ attempt: 1, model: 'o-high', outcome: 'ok', cost_usd: expect.closeTo(0.0003, 12) })]);
  expect(Object.keys(r.run.stage_timings)).toEqual(expect.arrayContaining(['validate', 'rate_limit', 'cache', 'admission', 'routing', 'provider', 'accounting']));
});

it('sends the versioned system prompt and the input wrapped as data', async () => {
  const d = deps(); await executeGenerate(body(), TENANT, d);
  const [user, model, options] = (d.call as ReturnType<typeof vi.fn>).mock.calls[0];
  expect(model.id).toBe('o-high'); expect(user).toContain('<ticket>\nCustomer cannot log in.\n</ticket>');
  expect(options.system).not.toContain('Customer'); expect(options.maxOutputTokens).toBe(400);
});

it('retries a transient error once with backoff, then succeeds on the same model', async () => {
  const d = deps(); d.call = vi.fn().mockRejectedValueOnce(fail(500)).mockResolvedValue(OK);
  const r = await executeGenerate(body(), TENANT, d);
  expect(r.status).toBe(200); expect(calledModels(d)).toEqual(['o-high', 'o-high']);
  expect(d.sleep).toHaveBeenCalledWith(5); // full jitter: 0.5 * min(100, 10 * 2^0)
  expect(r.attempts.map(a => a.outcome)).toEqual(['error', 'ok']); expect(r.run.fallback_used).toBe(false);
});

it('falls back to the other provider in the same tier after retries are spent', async () => {
  const d = deps(); d.call = vi.fn().mockImplementation(async (_u, model) => { if (model.provider === 'openai') throw fail(529); return OK; });
  const r = await executeGenerate(body(), TENANT, d);
  expect(r.status).toBe(200); expect(calledModels(d)).toEqual(['o-high', 'o-high', 'a-high']);
  expect(r.body.metadata).toMatchObject({ model: 'a-high', provider: 'anthropic', fallback_used: true, attempts: 3 });
  expect(r.run).toMatchObject({ selected_model: 'a-high', fallback_used: true });
  expect(r.attempts.map(a => [a.model, a.error_kind, a.http_status])).toEqual([['o-high', 'overloaded', 529], ['o-high', 'overloaded', 529], ['a-high', null, null]]);
});

it('does not retry a non-transient error; it goes straight to the fallback', async () => {
  const d = deps(); d.call = vi.fn().mockRejectedValueOnce(fail(401)).mockResolvedValue(OK);
  const r = await executeGenerate(body(), TENANT, d);
  expect(calledModels(d)).toEqual(['o-high', 'a-high']); expect(d.sleep).not.toHaveBeenCalled();
  expect(r.attempts[0]).toMatchObject({ error_kind: 'auth', http_status: 401 });
});

it('charges the tokens billed for an empty answer, then falls back', async () => {
  const d = deps();
  d.call = vi.fn().mockRejectedValueOnce(new ProviderError('empty', null, null, { prompt_tokens: 10, completion_tokens: 1000 })).mockResolvedValue(OK);
  const r = await executeGenerate(body(), TENANT, d);
  expect(r.status).toBe(200); expect(calledModels(d)).toEqual(['o-high', 'a-high']);
  expect(r.attempts[0]).toMatchObject({ error_kind: 'empty', prompt_tokens: 10, completion_tokens: 1000, cost_usd: expect.closeTo(0.0101, 12) });
  // 1,010 tokens for the empty answer plus 30 for the fallback's answer, both at $10 per million.
  expect(r.run).toMatchObject({ cost_usd: expect.closeTo(0.0104, 12), prompt_tokens: 20, completion_tokens: 1020 });
  expect(r.body.metadata).toMatchObject({ cost_usd: expect.closeTo(0.0104, 12), tokens: { input: 20, output: 1020, total: 1040 } });
  expect(d.settle).toHaveBeenCalledWith(expect.closeTo(0.0104, 12), 'a-high', 'high');
});

it('charges billed empty answers even when every provider fails', async () => {
  const d = deps(); d.call = vi.fn().mockRejectedValue(new ProviderError('empty', null, null, { prompt_tokens: 10, completion_tokens: 90 }));
  const r = await executeGenerate(body(), TENANT, d);
  expect(r.status).toBe(502); expect(calledModels(d)).toEqual(['o-high', 'a-high']);
  expect(r.run).toMatchObject({ error_category: 'all_providers_failed', cost_usd: expect.closeTo(0.002, 12) });
  expect(d.settle).toHaveBeenCalledWith(expect.closeTo(0.002, 12), 'o-high', 'high');
});

it('moves to the fallback instead of waiting out a long Retry-After', async () => {
  const d = deps(); d.call = vi.fn().mockRejectedValueOnce(fail(429, '30')).mockResolvedValue(OK);
  await executeGenerate(body(), TENANT, d);
  expect(calledModels(d)).toEqual(['o-high', 'a-high']); expect(d.sleep).not.toHaveBeenCalled();
});

it('does not retry past the latency target', async () => {
  const d = deps(); d.retryPolicy = { maxAttempts: 3, baseDelayMs: 5000, maxDelayMs: 5000 };
  d.call = vi.fn().mockRejectedValueOnce(fail(500)).mockResolvedValue(OK);
  await executeGenerate(body({ latency_target_ms: 1000 }), TENANT, d);
  expect(calledModels(d)).toEqual(['o-high', 'a-high']); expect(d.sleep).not.toHaveBeenCalled();
});

it('skips a model whose circuit is open', async () => {
  const d = deps(); d.breaker = new CircuitBreaker(1, 60000); d.breaker.failure('o-high');
  const r = await executeGenerate(body(), TENANT, d);
  expect(r.status).toBe(200); expect(calledModels(d)).toEqual(['a-high']);
  expect(r.attempts.map(a => a.outcome)).toEqual(['circuit_open', 'ok']);
});

it('opens the circuit after repeated transient failures and shares it across requests', async () => {
  const d = deps(); d.breaker = new CircuitBreaker(2, 60000);
  d.call = vi.fn().mockImplementation(async (_u, model) => { if (model.id === 'o-high') throw fail(503); return OK; });
  await executeGenerate(body(), TENANT, d);
  expect(d.breaker.state('o-high')).toBe('open');
  (d.call as ReturnType<typeof vi.fn>).mockClear();
  await executeGenerate(body(), TENANT, d);
  expect(calledModels(d)).toEqual(['a-high']);
});

it('returns 502 when every provider fails, keeps the reservation and hides details', async () => {
  const d = deps(); d.call = vi.fn().mockRejectedValue(fail(500));
  const r = await executeGenerate(body(), TENANT, d);
  expect(r.status).toBe(502); expect(r.run).toMatchObject({ error_category: 'all_providers_failed', failure_stage: 'provider', cost_usd: null, attempt_count: 4 });
  expect(JSON.stringify(r.body)).not.toContain('secret'); expect(d.adjustTokens).not.toHaveBeenCalled(); expect(d.settle).not.toHaveBeenCalled();
});

it('keeps the paid answer and actual usage after settlement fails', async () => {
  const d = deps(); d.settle = vi.fn().mockRejectedValue(new Error('down'));
  const r = await executeGenerate(body(), TENANT, d);
  expect(r.status).toBe(200); expect(r.body.answer).toBe('answer');
  expect(r.run).toMatchObject({ failure_stage: 'accounting', cost_usd: expect.closeTo(0.0003, 12), provider_succeeded: true });
});

it('logging failure is non-fatal', async () => {
  const d = deps(); d.persist = vi.fn().mockRejectedValue(new Error('down'));
  const r = await executeGenerate(body(), TENANT, d); expect(r.status).toBe(200); expect(r.run.failure_stage).toBe('telemetry');
});

it('returns unused reserved tokens after a successful call', async () => {
  const d = deps(); await executeGenerate(body(), TENANT, d);
  expect(d.adjustTokens).toHaveBeenCalledWith('2026-10-05T02:00:00Z', 30 - reservedOf(d));
});

it('reserves room for reasoning headroom', async () => {
  const d = deps(); d.models = MODELS.map(x => (x.id === 'a-high' ? { ...x, reasoningHeadroomTokens: 2000 } : x));
  await executeGenerate(body(), TENANT, d);
  expect(reservedOf(d)).toBeGreaterThan(2400);
});

it('rate limits before budget or provider access, with Retry-After, and logs the rejection', async () => {
  const d = deps(); d.takeRateLimit = vi.fn().mockResolvedValue({ allowed: false, window_start: 'w', reason: 'tpm_exceeded', retry_after_s: 17 });
  const r = await executeGenerate(body(), TENANT, d);
  expect(r.status).toBe(429); expect(r.headers['Retry-After']).toBe('17');
  expect(r.run).toMatchObject({ failure_stage: 'rate_limit', error_category: 'tpm_exceeded' });
  expect(d.admit).not.toHaveBeenCalled(); expect(d.call).not.toHaveBeenCalled(); expect(d.persist).toHaveBeenCalled();
});

it('rejects an exhausted tenant budget with 402 and refunds the reservation', async () => {
  const d = deps(); d.admit = vi.fn().mockResolvedValue({ tenantSpent: 5, tenantBudget: 5, globalSpent: 0, globalLimit: 100 });
  const r = await executeGenerate(body(), TENANT, d);
  expect(r.status).toBe(402); expect(r.run.error_category).toBe('tenant_budget_exhausted'); expect(d.call).not.toHaveBeenCalled();
  expect(d.adjustTokens).toHaveBeenCalledWith('2026-10-05T02:00:00Z', -reservedOf(d));
});

it('rejects when the worst-case cost would overrun the tenant budget', async () => {
  const d = deps(); d.admit = vi.fn().mockResolvedValue({ tenantSpent: 4.999, tenantBudget: 5, globalSpent: 0, globalLimit: 100 });
  const r = await executeGenerate(body(), TENANT, d);
  expect(r.status).toBe(402); expect(d.call).not.toHaveBeenCalled();
});

it('rejects with 503 when the global budget is exhausted', async () => {
  const d = deps(); d.admit = vi.fn().mockResolvedValue({ tenantSpent: 0, tenantBudget: 5, globalSpent: 100, globalLimit: 100 });
  const r = await executeGenerate(body(), TENANT, d);
  expect(r.status).toBe(503); expect(r.run.error_category).toBe('budget_exhausted'); expect(d.call).not.toHaveBeenCalled();
});

it('rejects when the worst-case cost exceeds max_cost_usd, before calling the provider', async () => {
  const d = deps(); const r = await executeGenerate(body({ max_cost_usd: 0.001 }), TENANT, d);
  expect(r.status).toBe(402); expect(r.run.error_category).toBe('max_cost_exceeded'); expect(d.call).not.toHaveBeenCalled();
  expect((await executeGenerate(body({ max_cost_usd: 1 }), TENANT, deps())).status).toBe(200);
});

it('gives routing the worst case per tier across primary and fallback', async () => {
  const d = deps(); d.models = MODELS.map(x => (x.id === 'a-mid' ? { ...x, outputPricePerMillion: 50 } : x));
  await executeGenerate(body(), TENANT, d);
  const { worstCase } = (d.route as ReturnType<typeof vi.fn>).mock.calls[0][1];
  expect(worstCase('mid')).toBeGreaterThan(400 * 50 / 1e6); expect(worstCase('low')).toBeLessThan(0.001);
});

it('fails closed for invalid budget data', async () => {
  const d = deps(); d.admit = vi.fn().mockResolvedValue({ tenantSpent: NaN, tenantBudget: 5, globalSpent: 0, globalLimit: 100 });
  expect((await executeGenerate(body(), TENANT, d)).status).toBe(503); expect(d.call).not.toHaveBeenCalled();
});

it('missing usage is unknown rather than a fabricated free success', async () => {
  const d = deps(); d.call = vi.fn().mockResolvedValue({ content: 'answer' });
  const r = await executeGenerate(body(), TENANT, d);
  expect(r.run).toMatchObject({ provider_succeeded: true, application_succeeded: false, failure_stage: 'usage_capture', cost_usd: null });
  expect(d.settle).not.toHaveBeenCalled(); expect(d.adjustTokens).not.toHaveBeenCalled();
});

it('stores hashes and versions but never the raw input or answer', async () => {
  const d = deps(); const r = await executeGenerate(body({ input: 'private prompt' }), TENANT, d);
  expect(r.run.query_hash).toHaveLength(64);
  for (const record of [r.run, ...r.attempts]) {
    expect(JSON.stringify(record)).not.toContain('private prompt'); expect(JSON.stringify(record)).not.toContain('answer');
  }
});

describe('structured output', () => {
  const LOW = { model: 'o-low', tier: 'low', difficulty: 0, policyVersion: 'rules-v1', reasons: ['task classify starts at low'] };
  const VALID = { ...OK, content: '```json\n{"category": "billing", "urgency": "low"}\n```' };
  const INVALID = { ...OK, content: '{"category": "refunds"}' };
  const classify = { task_type: 'classify', input: 'I was charged twice.' };

  it('returns parsed output when the answer matches the schema', async () => {
    const d = deps(); d.route = vi.fn().mockResolvedValue(LOW); d.call = vi.fn().mockResolvedValue(VALID);
    const r = await executeGenerate(classify, TENANT, d);
    expect(r.status).toBe(200); expect(r.body.output).toEqual({ category: 'billing', urgency: 'low' }); expect(r.run.escalated).toBe(false);
  });

  it('escalates one tier when the answer fails the schema and charges both calls', async () => {
    const d = deps(); d.route = vi.fn().mockResolvedValue(LOW); d.call = vi.fn().mockResolvedValueOnce(INVALID).mockResolvedValue(VALID);
    const r = await executeGenerate(classify, TENANT, d);
    expect(r.status).toBe(200); expect(calledModels(d)).toEqual(['o-low', 'o-mid']);
    expect(r.run).toMatchObject({ escalated: true, selected_model: 'o-mid', selected_tier: 'mid', cost_usd: expect.closeTo(0.00009, 12), total_tokens: 60 });
    expect(r.run.route_reasons.at(-1)).toContain('escalated to mid');
    expect(r.attempts.map(a => a.outcome)).toEqual(['invalid_output', 'ok']);
    expect(r.attempts[0].error_kind).toBe('schema: urgency is required');
    expect(d.settle).toHaveBeenCalledWith(expect.closeTo(0.00009, 12), 'o-mid', 'mid');
  });

  it('returns 502 when the tenant has no higher tier, and still charges the paid call', async () => {
    const d = deps(); d.route = vi.fn().mockResolvedValue(LOW); d.allowedTiers = ['low']; d.call = vi.fn().mockResolvedValue(INVALID);
    const r = await executeGenerate(classify, TENANT, d);
    expect(r.status).toBe(502); expect(r.run).toMatchObject({ error_category: 'invalid_model_output', failure_stage: 'output_validation', cost_usd: expect.closeTo(0.00003, 12) });
    expect(d.settle).toHaveBeenCalledWith(expect.closeTo(0.00003, 12), 'o-low', 'low'); expect(calledModels(d)).toEqual(['o-low']);
  });

  it('escalates only once', async () => {
    const d = deps(); d.route = vi.fn().mockResolvedValue(LOW); d.call = vi.fn().mockResolvedValue(INVALID);
    const r = await executeGenerate(classify, TENANT, d);
    expect(r.status).toBe(502); expect(calledModels(d)).toEqual(['o-low', 'o-mid']);
    expect(d.settle).toHaveBeenCalledWith(expect.closeTo(0.00009, 12), 'o-mid', 'mid');
  });

  it('does not escalate past max_cost_usd', async () => {
    const d = deps(); d.route = vi.fn().mockResolvedValue(LOW); d.call = vi.fn().mockResolvedValue(INVALID);
    const r = await executeGenerate({ ...classify, max_cost_usd: 0.0005 }, TENANT, d);
    expect(r.status).toBe(502); expect(calledModels(d)).toEqual(['o-low']);
    expect(r.run.route_reasons.at(-1)).toContain('escalation not affordable');
  });
});

describe('response cache', () => {
  const withCache = (hit: unknown = null) => {
    const d = deps(); d.cacheGet = vi.fn().mockResolvedValue(hit); d.cachePut = vi.fn().mockResolvedValue(undefined); return d;
  };

  it('stores a fresh answer under a key of prompt version and input', async () => {
    const d = withCache(); await executeGenerate(body(), TENANT, d);
    const key = cacheKey(getPrompt('summarize')!, 'Customer cannot log in.');
    expect(d.cacheGet).toHaveBeenCalledWith(key);
    expect(d.cachePut).toHaveBeenCalledWith(key, { answer: 'answer', model: 'o-high', tier: 'high' });
  });

  it('serves a hit without budget, routing or provider calls, and refunds the whole reservation', async () => {
    const d = withCache({ answer: 'cached', model: 'o-mid', tier: 'mid' });
    const r = await executeGenerate(body(), TENANT, d);
    expect(r.status).toBe(200); expect(r.body.answer).toBe('cached');
    expect(r.body.metadata).toMatchObject({ cache_hit: true, cost_usd: 0, model: 'o-mid' });
    expect(r.run).toMatchObject({ cache_hit: true, cost_usd: 0, routing_policy_version: 'cache', application_succeeded: true });
    expect(d.admit).not.toHaveBeenCalled(); expect(d.call).not.toHaveBeenCalled(); expect(d.settle).not.toHaveBeenCalled();
    expect(d.adjustTokens).toHaveBeenCalledWith('2026-10-05T02:00:00Z', -reservedOf(d));
  });

  it('is skipped for priority high and when the request opts out', async () => {
    for (const extra of [{ priority: 'high' }, { cache: false }]) {
      const d = withCache({ answer: 'cached', model: 'o-mid', tier: 'mid' });
      const r = await executeGenerate(body(extra), TENANT, d);
      expect(r.run.cache_hit).toBe(false); expect(d.cacheGet).not.toHaveBeenCalled(); expect(d.cachePut).not.toHaveBeenCalled();
    }
  });

  it('treats a cache outage as a miss and does not cache truncated answers', async () => {
    const d = withCache(); d.cacheGet = vi.fn().mockRejectedValue(new Error('down'));
    d.call = vi.fn().mockResolvedValue({ ...OK, truncated: true });
    const r = await executeGenerate(body(), TENANT, d);
    expect(r.status).toBe(200); expect(d.cachePut).not.toHaveBeenCalled(); expect(r.body.metadata).toMatchObject({ truncated: true });
  });

  it('ignores a cached JSON answer that no longer matches the schema', async () => {
    const d = withCache({ answer: 'not json', model: 'o-low', tier: 'low' });
    d.route = vi.fn().mockResolvedValue({ model: 'o-low', tier: 'low', difficulty: 0, policyVersion: 'rules-v1', reasons: [] });
    d.call = vi.fn().mockResolvedValue({ ...OK, content: '{"category":"other","urgency":"low"}' });
    const r = await executeGenerate({ task_type: 'classify', input: 'hi' }, TENANT, d);
    expect(r.run.cache_hit).toBe(false); expect(d.call).toHaveBeenCalled();
  });
});

it.each([
  [{}, 'body_must_be_object'],
  [{ task_type: 'poem', input: 'x' }, 'invalid_task_type'],
  [{ task_type: 'chat', input: '  ' }, 'invalid_input'],
  [{ task_type: 'chat', input: 'x', priority: 'urgent' }, 'invalid_priority'],
  [{ task_type: 'chat', input: 'x', max_cost_usd: 0 }, 'invalid_max_cost_usd'],
  [{ task_type: 'chat', input: 'x', max_cost_usd: '1' }, 'invalid_max_cost_usd'],
  [{ task_type: 'chat', input: 'x', latency_target_ms: 100 }, 'invalid_latency_target_ms'],
  [{ task_type: 'chat', input: 'x', prompt_version: 'summarize@v1' }, 'unknown_prompt_version'],
  [{ task_type: 'chat', input: 'x', tenant_id: 'someone-else' }, 'unknown_field:tenant_id'],
  [{ task_type: 'chat', input: 'x', cache: 'no' }, 'invalid_cache'],
])('rejects invalid request %j as %s without touching limits or budget', async (bad, code) => {
  const d = deps(); const r = await executeGenerate(Object.keys(bad).length ? bad : [], TENANT, d);
  expect(r.status).toBe(400); expect(r.body.error).toBe(code);
  expect(d.takeRateLimit).not.toHaveBeenCalled(); expect(d.admit).not.toHaveBeenCalled();
});

it('rejects oversized input with 413 before rate limits or budget access', async () => {
  const d = deps(); const r = await executeGenerate(body({ input: 'x'.repeat(16001) }), TENANT, d);
  expect(r.status).toBe(413); expect(d.takeRateLimit).not.toHaveBeenCalled();
});

it('defaults priority and prompt version', () => {
  const parsed = parseGenerateRequest({ task_type: 'classify', input: 'refund please' });
  expect(parsed).toMatchObject({ priority: 'normal', max_cost_usd: null, latency_target_ms: null, cache: true, prompt: { task: 'classify', version: 'v2' } });
});

it('estimates about four characters per token plus message overhead', () => {
  expect(estimateInputTokens('abcd', 'abcdefgh')).toBe(1 + 4 + 2 + 4);
});
