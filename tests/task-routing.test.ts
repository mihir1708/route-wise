import { expect, it } from 'vitest';
import { heuristicV1, resolveTier, routeTask, ticketDifficulty, type TaskRoutingContext } from '@/lib/routing-policy';
import { GATEWAY_MODELS, LEGACY_MODELS, type ModelConfig } from '@/lib/model-registry';

const THREE: ModelConfig[] = [
  ...LEGACY_MODELS,
  { id: 'mid-model', provider: 'openai', tier: 'mid', inputPricePerMillion: 1, outputPricePerMillion: 2, enabled: true, temperature: 0.5, maxOutputTokens: 1000, pricingVersion: 'test' },
];
const ALL = ['low', 'mid', 'high'] as const;
const ctx = (extra: Partial<TaskRoutingContext> = {}): TaskRoutingContext => ({ budgetPercentage: 0, allowedTiers: ALL, models: GATEWAY_MODELS, ...extra });
const HARD = 'Production down for all users since the deploy. HTTP 500 on every request, we already tried a rollback. '.repeat(30);

it('task types start at their default tier under rules-v1', async () => {
  const cases = { classify: 'low', extract: 'low', summarize: 'mid', draft_reply: 'mid', troubleshoot: 'high' } as const;
  for (const [task, tier] of Object.entries(cases)) {
    const input = 'Customer says the export button does nothing in Firefox, no error shown, works in Chrome. Version 4.2. '.repeat(5);
    const d = await routeTask(task as keyof typeof cases, input, ctx());
    expect(d).toMatchObject({ tier, policyVersion: 'rules-v1' });
    expect(d.model).toBe(GATEWAY_MODELS.find(m => m.tier === tier)!.id);
  }
});

it('scores tickets from named signals', () => {
  expect(ticketDifficulty('How do I reset my password?')).toEqual({ score: 0, signals: [] });
  const hard = ticketDifficulty(HARD);
  expect(hard.signals).toEqual(expect.arrayContaining(['long_thread', 'error_output', 'high_stakes', 'already_tried']));
  expect(hard.score).toBe(0.95);
});

it('moves hard tickets up and trivial troubleshooting down, with reasons', async () => {
  const up = await routeTask('summarize', HARD, ctx());
  expect(up.tier).toBe('high'); expect(up.reasons.join('|')).toContain('hard ticket');
  const down = await routeTask('troubleshoot', 'How do I reset my password?', ctx());
  expect(down.tier).toBe('mid'); expect(down.reasons.join('|')).toContain('down to mid');
  expect((await routeTask('classify', HARD, ctx())).tier).toBe('low'); // classification stays cheap
});

it('applies priority, latency target and budget pressure in order', async () => {
  expect((await routeTask('classify', 'refund?', ctx({ priority: 'high' }))).tier).toBe('mid');
  expect((await routeTask('summarize', 'thread', ctx({ priority: 'low' }))).tier).toBe('low');
  const fast = await routeTask('troubleshoot', HARD, ctx({ latencyTargetMs: 2000 }));
  expect(fast.tier).toBe('mid'); expect(fast.reasons.at(-1)).toContain('latency target');
  expect((await routeTask('summarize', 'thread', ctx({ budgetPercentage: 95 }))).tier).toBe('low');
  expect((await routeTask('summarize', 'thread', ctx({ budgetPercentage: 95, priority: 'high' }))).tier).toBe('high');
});

it('steps down to the most capable tier that fits max_cost_usd', async () => {
  const costs = { low: 0.001, mid: 0.01, high: 0.1 } as const;
  const d = await routeTask('troubleshoot', HARD, ctx({ maxCostUsd: 0.02, worstCase: t => costs[t] }));
  expect(d.tier).toBe('mid'); expect(d.reasons.at(-1)).toBe('max cost $0.02: down to mid');
  // Nothing fits: routing keeps its choice and the gateway rejects with 402.
  expect((await routeTask('troubleshoot', HARD, ctx({ maxCostUsd: 0.0001, worstCase: t => costs[t] }))).tier).toBe('high');
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
  const d = await routeTask('troubleshoot', HARD, { budgetPercentage: 0, allowedTiers: ['low'], models: THREE });
  expect(d.tier).toBe('low'); expect(d.reasons.at(-1)).toContain('using low');
  await expect(routeTask('classify', 'x', { budgetPercentage: 0, allowedTiers: ['mid'], models: LEGACY_MODELS })).rejects.toThrow();
});
