import { afterEach, expect, it, vi } from 'vitest';
import { billableOutputCap, GATEWAY_MODELS, LEGACY_MODELS, getModel, modelForTier, parseRegistry, runtimeModels, tierCandidates } from '@/lib/model-registry';
afterEach(() => vi.unstubAllEnvs());
it('retains exact legacy prices and has no fictitious mid tier', () => {
  expect(getModel('gpt-4').inputPricePerMillion).toBe(30);
  expect(() => modelForTier('mid', LEGACY_MODELS)).toThrow('No enabled');
});
it('defaults to three tiers, each with an OpenAI primary and an Anthropic fallback', () => {
  expect(parseRegistry(JSON.stringify(GATEWAY_MODELS))).toEqual(GATEWAY_MODELS);
  for (const tier of ['low', 'mid', 'high'] as const) {
    expect(tierCandidates(tier).map(m => m.provider)).toEqual(['openai', 'anthropic']);
  }
  expect(modelForTier('high').id).toBe('gpt-5.6-sol');
  expect(getModel('claude-opus-5-5')).toMatchObject({ inputPricePerMillion: 4, outputPricePerMillion: 20 });
});
it('resolves historical ids by default but not in an explicit registry', () => {
  expect(getModel('gpt-3.5-turbo').tier).toBe('low');
  expect(() => getModel('gpt-3.5-turbo', GATEWAY_MODELS)).toThrow('Unknown model');
});
it('counts reasoning headroom as billable output', () => {
  expect(billableOutputCap(getModel('claude-opus-5-5'), 400)).toBe(2400);
  expect(billableOutputCap(getModel('gpt-5.6-luna'), 5000)).toBe(1000);
});
it('supports explicitly versioned runtime identifiers without mutating history', () => {
  const models = LEGACY_MODELS.map(m => ({ ...m, id: `configured-${m.tier}`, pricingVersion: 'operator-1' }));
  vi.stubEnv('ROUTEWISE_MODELS_JSON', JSON.stringify(models));
  expect(modelForTier('low').id).toBe('configured-low'); expect(LEGACY_MODELS[0].id).toBe('gpt-3.5-turbo');
  expect(runtimeModels()[0].pricingVersion).toBe('operator-1');
});
it.each([
  { models: [] },
  { models: [{ ...LEGACY_MODELS[0], inputPricePerMillion: -1 }] },
  { models: [...LEGACY_MODELS, LEGACY_MODELS[0]] },
  { models: [...LEGACY_MODELS, { ...LEGACY_MODELS[0], id: 'second-openai-low' }] },
  { models: [...LEGACY_MODELS, { ...LEGACY_MODELS[0], id: 'x', provider: 'mistral' }] },
  { models: [...LEGACY_MODELS, { ...LEGACY_MODELS[0], id: 'x', provider: 'anthropic', thinking: 'never' }] },
  { models: [...LEGACY_MODELS, { ...LEGACY_MODELS[0], id: 'x', provider: 'anthropic', reasoningHeadroomTokens: -5 }] },
])('rejects invalid registries', ({ models }) => {
  expect(() => parseRegistry(JSON.stringify(models))).toThrow();
});
