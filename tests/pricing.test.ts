import { describe, expect, it } from 'vitest';
import { calculateCost, estimateCost, PRICING } from '@/utils/pricing';
import type { ModelName } from '@/types';

describe('current pricing', () => {
  it('preserves the configured USD rates per 1,000 tokens', () => {
    expect(PRICING).toEqual({
      'gpt-3.5-turbo': { prompt: 0.0015, completion: 0.002 },
      'gpt-4': { prompt: 0.03, completion: 0.06 },
    });
  });

  it.each([
    ['gpt-3.5-turbo', 0, 0, 0], ['gpt-4', 0, 0, 0],
    ['gpt-3.5-turbo', 1000, 0, 0.0015], ['gpt-3.5-turbo', 0, 1000, 0.002],
    ['gpt-4', 1000, 0, 0.03], ['gpt-4', 0, 1000, 0.06],
    ['gpt-3.5-turbo', 1234, 567, 0.002985], ['gpt-4', 1234, 567, 0.07104],
    ['gpt-3.5-turbo', 1, 1, 0.0000035], ['gpt-4', 1, 1, 0.00009],
  ] as const)('%s with %i input / %i output tokens costs %s', (model, input, output, cost) => {
    expect(calculateCost(model, input, output)).toBeCloseTo(cost, 12);
  });

  it('rejects an unknown model at runtime', () => {
    expect(() => calculateCost('unknown' as ModelName, 1, 1)).toThrow('Unknown model: unknown');
    expect(() => estimateCost('unknown' as ModelName, 4)).toThrow('Unknown model: unknown');
  });

  it.each([
    [0, 0, 0], [1, 0.0000055, 0.00015], [3, 0.0000055, 0.00015],
    [4, 0.0000055, 0.00015], [5, 0.000011, 0.0003],
    [8, 0.000011, 0.0003], [9, 0.0000165, 0.00045],
    [4000, 0.0055, 0.15],
  ])('estimates length %i using rounded-up input and twice as many output tokens', (length, cheap, expert) => {
    expect(estimateCost('gpt-3.5-turbo', length)).toBeCloseTo(cheap, 12);
    expect(estimateCost('gpt-4', length)).toBeCloseTo(expert, 12);
  });
});
