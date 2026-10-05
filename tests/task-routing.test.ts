import { expect, it } from 'vitest';
import { heuristicV1, resolveTier, routeTask } from '@/lib/routing-policy';
import { LEGACY_MODELS, type ModelConfig } from '@/lib/model-registry';

const THREE: ModelConfig[] = [
  ...LEGACY_MODELS,
  { id: 'mid-model', provider: 'openai', tier: 'mid', inputPricePerMillion: 1, outputPricePerMillion: 2, enabled: true, temperature: 0.5, maxOutputTokens: 1000, pricingVersion: 'test' },
];
const ALL = ['low', 'mid', 'high'] as const;

it('task types start at their default tier', async () => {
  const cases = { classify: 'low', extract: 'low', summarize: 'mid', draft_reply: 'mid', troubleshoot: 'high' } as const;
  for (const [task, tier] of Object.entries(cases)) {
    const d = await routeTask(task as keyof typeof cases, 'x', { budgetPercentage: 0, allowedTiers: ALL, models: THREE });
    expect(d).toMatchObject({ tier, policyVersion: 'task-default-v0' });
  }
});

it('chat keeps heuristic-v1 decisions', async () => {
  for (const q of ['hello', 'explain the implications of compound interest in detail?']) {
    const v1 = await heuristicV1.route(q, { budgetPercentage: 0, models: LEGACY_MODELS });
    const d = await routeTask('chat', q, { budgetPercentage: 0, allowedTiers: ALL, models: LEGACY_MODELS });
    expect(d).toMatchObject({ model: v1.model, tier: v1.tier, policyVersion: 'heuristic-v1', difficulty: v1.difficulty });
  }
});

it('falls to the nearest usable tier, cheaper on ties, and says why', async () => {
  expect(resolveTier('mid', ALL, LEGACY_MODELS)).toBe('low'); // no mid model in the legacy registry
  expect(resolveTier('high', ['low', 'mid'], THREE)).toBe('mid');
  expect(resolveTier('low', ['high'], THREE)).toBe('high');
  expect(resolveTier('low', ['mid'], LEGACY_MODELS)).toBeNull();
  const d = await routeTask('troubleshoot', 'x', { budgetPercentage: 0, allowedTiers: ['low'], models: THREE });
  expect(d.tier).toBe('low'); expect(d.reasons.at(-1)).toContain('using low');
  await expect(routeTask('classify', 'x', { budgetPercentage: 0, allowedTiers: ['mid'], models: LEGACY_MODELS })).rejects.toThrow();
});
