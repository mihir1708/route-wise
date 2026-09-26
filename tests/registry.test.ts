import { afterEach, expect, it, vi } from 'vitest';
import { LEGACY_MODELS, getModel, modelForTier, parseRegistry, runtimeModels } from '@/lib/model-registry';
afterEach(() => vi.unstubAllEnvs());
it('retains exact legacy prices and has no fictitious mid tier', () => {
  expect(getModel('gpt-4').inputPricePerMillion).toBe(30);
  expect(() => modelForTier('mid')).toThrow('No enabled');
});
it('supports explicitly versioned runtime identifiers without mutating history', () => {
  const models = LEGACY_MODELS.map(m => ({ ...m, id: `configured-${m.tier}`, pricingVersion: 'operator-1' }));
  vi.stubEnv('ROUTEWISE_MODELS_JSON', JSON.stringify(models));
  expect(modelForTier('low').id).toBe('configured-low'); expect(LEGACY_MODELS[0].id).toBe('gpt-3.5-turbo');
  expect(runtimeModels()[0].pricingVersion).toBe('operator-1');
});
it.each([{ models: [] }, { models: [{ ...LEGACY_MODELS[0], inputPricePerMillion: -1 }] }, { models: [...LEGACY_MODELS, LEGACY_MODELS[0]] }])('rejects invalid registries', ({ models }) => {
  expect(() => parseRegistry(JSON.stringify(models))).toThrow();
});
