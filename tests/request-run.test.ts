import { expect, it, vi } from 'vitest';
import { estimateInputTokens, executeGenerate, parseGenerateRequest, type GenerateDependencies } from '@/lib/request-run';

const deps = (): GenerateDependencies => ({
  takeRateLimit: vi.fn().mockResolvedValue({ allowed: true, window_start: '2026-10-05T02:00:00Z' }),
  adjustTokens: vi.fn().mockResolvedValue(undefined),
  admit: vi.fn().mockResolvedValue({ tenantSpent: 0, tenantBudget: 5, globalSpent: 0, globalLimit: 100 }),
  route: vi.fn().mockResolvedValue({ model: 'gpt-4', tier: 'high', difficulty: 0.8, policyVersion: 'heuristic-v1', reasons: ['r'] }),
  price: () => 0.0015,
  call: vi.fn().mockResolvedValue({ content: 'answer', prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }),
  settle: vi.fn().mockResolvedValue(undefined),
  persist: vi.fn().mockResolvedValue(undefined),
});
const body = (extra: Record<string, unknown> = {}) => ({ task_type: 'summarize', input: 'Customer cannot log in.', ...extra });
const TENANT = 'tenant-1';

it('records success, actual usage and request metadata', async () => {
  const d = deps(); const r = await executeGenerate(body({ priority: 'high', latency_target_ms: 3000 }), TENANT, d);
  expect(r.status).toBe(200);
  expect(r.run).toMatchObject({
    tenant_id: TENANT, task_type: 'summarize', priority: 'high', prompt_version: 'summarize@v1', latency_target_ms: 3000,
    selected_model: 'gpt-4', selected_tier: 'high', cost_usd: 0.0015, provider_succeeded: true, application_succeeded: true,
  });
  expect(r.body.metadata).toMatchObject({ model: 'gpt-4', tier: 'high', provider: 'openai', fallback_used: false, cost_usd: 0.0015, tenant_budget_remaining: 4.9985 });
  expect(d.settle).toHaveBeenCalledWith(0.0015, 'gpt-4', 'high');
});

it('sends the versioned system prompt and the input wrapped as data', async () => {
  const d = deps(); await executeGenerate(body(), TENANT, d);
  const [user, model, options] = (d.call as ReturnType<typeof vi.fn>).mock.calls[0];
  expect(model).toBe('gpt-4'); expect(user).toContain('<ticket>\nCustomer cannot log in.\n</ticket>');
  expect(options.system).not.toContain('Customer'); expect(options.maxOutputTokens).toBe(400);
});

it('keeps the paid answer and actual usage after settlement fails', async () => {
  const d = deps(); d.settle = vi.fn().mockRejectedValue(new Error('down'));
  const r = await executeGenerate(body(), TENANT, d);
  expect(r.status).toBe(200); expect(r.body.answer).toBe('answer');
  expect(r.run).toMatchObject({ failure_stage: 'accounting', cost_usd: 0.0015, provider_succeeded: true });
});

it('logging failure is non-fatal', async () => {
  const d = deps(); d.persist = vi.fn().mockRejectedValue(new Error('down'));
  const r = await executeGenerate(body(), TENANT, d); expect(r.status).toBe(200); expect(r.run.failure_stage).toBe('telemetry');
});

it('provider failure preserves the selection, keeps the token reservation and hides details', async () => {
  const d = deps(); d.call = vi.fn().mockRejectedValue(new Error('secret provider detail'));
  const r = await executeGenerate(body(), TENANT, d);
  expect(r.status).toBe(502); expect(r.run).toMatchObject({ selected_model: 'gpt-4', cost_usd: null, failure_stage: 'provider' });
  expect(JSON.stringify(r.body)).not.toContain('secret'); expect(d.adjustTokens).not.toHaveBeenCalled();
});

it('returns unused reserved tokens after a successful call', async () => {
  const d = deps(); await executeGenerate(body(), TENANT, d);
  const reserved = (d.takeRateLimit as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(d.adjustTokens).toHaveBeenCalledWith('2026-10-05T02:00:00Z', 30 - reserved);
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
  const reserved = (d.takeRateLimit as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(d.adjustTokens).toHaveBeenCalledWith('2026-10-05T02:00:00Z', -reserved);
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
  const d = deps(); d.price = (_m, input, output) => (input + output) / 1e6 * 60;
  const r = await executeGenerate(body({ max_cost_usd: 0.001 }), TENANT, d);
  expect(r.status).toBe(402); expect(r.run.error_category).toBe('max_cost_exceeded'); expect(d.call).not.toHaveBeenCalled();
  expect((await executeGenerate(body({ max_cost_usd: 1 }), TENANT, deps())).status).toBe(200);
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
  expect(JSON.stringify(r.run)).not.toContain('private prompt'); expect(JSON.stringify(r.run)).not.toContain('answer');
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
  expect(parsed).toMatchObject({ priority: 'normal', max_cost_usd: null, latency_target_ms: null, prompt: { task: 'classify', version: 'v1' } });
});

it('estimates about four characters per token plus message overhead', () => {
  expect(estimateInputTokens('abcd', 'abcdefgh')).toBe(1 + 4 + 2 + 4);
});
