import { expect, it, vi } from 'vitest';
import { executeQuery, type RunDependencies } from '@/lib/request-run';
const deps = (): RunDependencies => ({
  admit: vi.fn().mockResolvedValue({ percentage: 0, remaining: 100 }),
  route: vi.fn().mockResolvedValue({ model: 'gpt-4', difficulty: 0.8 }),
  call: vi.fn().mockResolvedValue({ content: 'answer', prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }),
  price: () => 0.0015, settle: vi.fn().mockResolvedValue(undefined), persist: vi.fn().mockResolvedValue(undefined),
});
it('records success and actual usage', async () => {
  const d = deps(); const r = await executeQuery('valid query', d);
  expect(r.status).toBe(200); expect(r.run).toMatchObject({ selected_model: 'gpt-4', cost_usd: 0.0015, provider_succeeded: true, application_succeeded: true });
});
it('keeps the paid answer and actual usage after settlement fails', async () => {
  const d = deps(); d.settle = vi.fn().mockRejectedValue(new Error('down'));
  const r = await executeQuery('valid query', d);
  expect(r.status).toBe(200); expect(r.body.answer).toBe('answer');
  expect(r.run).toMatchObject({ failure_stage: 'accounting', cost_usd: 0.0015, selected_model: 'gpt-4', provider_succeeded: true });
});
it('logging failure is non-fatal', async () => {
  const d = deps(); d.persist = vi.fn().mockRejectedValue(new Error('down'));
  const r = await executeQuery('valid query', d); expect(r.status).toBe(200); expect(r.run.failure_stage).toBe('telemetry');
});
it('provider failure preserves the selection and unknown usage', async () => {
  const d = deps(); d.call = vi.fn().mockRejectedValue(new Error('secret provider detail'));
  const r = await executeQuery('valid query', d);
  expect(r.status).toBe(502); expect(r.run).toMatchObject({ selected_model: 'gpt-4', cost_usd: null, provider_succeeded: false, failure_stage: 'provider' });
  expect(JSON.stringify(r.body)).not.toContain('secret');
});
it('validation and admission failures never call provider', async () => {
  const d = deps(); expect((await executeQuery('', d)).status).toBe(400);
  d.admit = vi.fn().mockResolvedValue({ percentage: 100, remaining: 0 });
  expect((await executeQuery('query', d)).status).toBe(503); expect(d.call).not.toHaveBeenCalled();
});
it('missing usage is unknown rather than a fabricated free success', async () => {
  const d = deps(); d.call = vi.fn().mockResolvedValue({ content: 'answer' });
  const r = await executeQuery('query', d);
  expect(r.run).toMatchObject({ provider_succeeded: true, application_succeeded: false, failure_stage: 'usage_capture', cost_usd: null });
  expect(d.settle).not.toHaveBeenCalled();
});
it('stores versioned metadata but no raw prompt or answer', async () => {
  const d = deps(); const r = await executeQuery('private prompt', d);
  expect(r.run).toMatchObject({ selected_tier: 'high', routing_policy_version: 'heuristic-v1', pricing_version: 'legacy-2026-01', budget_percentage: 0, escalated: false });
  expect(r.run.query_hash).toHaveLength(64);
  expect(JSON.stringify(r.run)).not.toContain('private prompt'); expect(JSON.stringify(r.run)).not.toContain('answer');
});
it('fails closed for invalid budget data',async()=>{
  const d=deps();d.admit=vi.fn().mockResolvedValue({percentage:NaN,remaining:100});
  expect((await executeQuery('query',d)).status).toBe(503);expect(d.call).not.toHaveBeenCalled();
});
it('rejects oversized input before provider or budget access',async()=>{
  const d=deps();expect((await executeQuery('x'.repeat(16001),d)).status).toBe(413);expect(d.admit).not.toHaveBeenCalled();
});
