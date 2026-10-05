import { afterEach, expect, it, vi } from 'vitest';
import data from '@/eval/datasets/starter-v1.json';
import { validateDataset } from '@/eval/schema';
import { runEvaluation } from '@/eval/runner';
import { LEGACY_MODELS } from '@/lib/model-registry';
afterEach(() => vi.unstubAllEnvs());
it('defaults to zero paid calls and null metrics', async () => {
  vi.stubEnv('ROUTEWISE_LIVE_EVAL',''); const call = vi.fn();
  const run = await runEvaluation(validateDataset(data), { strategies: ['low-only','high-only','heuristic-v1'], limit: 2, call });
  expect(call).not.toHaveBeenCalled(); expect(run.records).toHaveLength(6);
  expect(run.records.every(r => r.quality === null && r.estimated_cost === null && r.latency_ms === null)).toBe(true);
});
it('CI blocks live calls even with opt-in', async () => {
  vi.stubEnv('ROUTEWISE_LIVE_EVAL','1'); vi.stubEnv('CI','true'); const call = vi.fn();
  const run = await runEvaluation(validateDataset(data), { strategies: ['low-only'], call });
  expect(run.mode).toBe('dry-run'); expect(call).not.toHaveBeenCalled();
});
it('rejects an unconfigured mid tier before any provider call', async () => {
  const call = vi.fn(); await expect(runEvaluation(validateDataset(data), { strategies: ['mid-only'], models: LEGACY_MODELS, call })).rejects.toThrow(); expect(call).not.toHaveBeenCalled();
});
it('records provider results only with explicit opt-in (mock)', async () => {
  vi.stubEnv('ROUTEWISE_LIVE_EVAL','1'); vi.stubEnv('CI','false');
  const call = vi.fn().mockResolvedValue({ content: 'sample', prompt_tokens: 10, completion_tokens: 20 });
  const run = await runEvaluation(validateDataset(data), { strategies: ['low-only'], limit: 1, call });
  expect(call).toHaveBeenCalledTimes(1); expect(run.records[0].status).toBe('completed'); expect(run.records[0].input_tokens).toBe(10);
});
it('also blocks live calls for CI=1',async()=>{
 vi.stubEnv('CI','1');vi.stubEnv('ROUTEWISE_LIVE_EVAL','1');const call=vi.fn();
 const run=await runEvaluation(validateDataset(data),{strategies:['low-only'],limit:1,call});
 expect(run.mode).toBe('dry-run');expect(call).not.toHaveBeenCalled();
});
