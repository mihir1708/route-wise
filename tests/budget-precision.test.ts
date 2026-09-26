import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BudgetStatus } from '@/types';

const database = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ supabaseAdmin: database }));
vi.mock('@/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { addUsage } from './legacy/budget-tracker-v0';
import { calculateCost } from '@/utils/pricing';

describe('legacy T02 addUsage fractional-cent arithmetic (database mocked, no SQL rounding)', () => {
  let stored: BudgetStatus;
  let writes: number[];

  beforeEach(() => {
    writes = [];
    stored = {
      month: '2026-09', total_cost: 0, total_requests: 0,
      cheap_model_count: 0, mid_model_count: 0, expert_model_count: 0,
      budget_limit: 100, updated_at: '2026-09-01T00:00:00Z',
    };
    // Return snapshots on reads and retain unrounded update payloads. This
    // tests the real application calculations, NOT PostgreSQL NUMERIC behavior.
    database.from.mockImplementation((table: string) => {
      expect(table).toBe('budget_tracking');
      return {
        select: () => ({ eq: () => ({ single: async () => ({ data: { ...stored }, error: null }) }) }),
        update: (patch: Partial<BudgetStatus>) => ({
          eq: async () => {
            writes.push(patch.total_cost!);
            stored = { ...stored, ...patch };
            return { error: null };
          },
        }),
      };
    });
  });

  it.each([[1, 0.001], [10, 0.01], [100, 0.1]])(
    'retains %i sequential $0.001 charges as $%s', async (count, expected) => {
      // The current price for 500 GPT-3.5 output tokens is exactly $0.001.
      const cost = calculateCost('gpt-3.5-turbo', 0, 500);
      expect(cost).toBe(0.001);
      for (let i = 0; i < count; i++) {
        await addUsage(cost, 'gpt-3.5-turbo');
        expect(writes[i]).toBeCloseTo((i + 1) * 0.001, 12);
      }
      expect(stored.total_cost).toBeCloseTo(expected, 12);
      expect(stored.total_requests).toBe(count);
      expect(stored.cheap_model_count).toBe(count);
    },
  );

  it('retains mixed six-decimal charges for both models', async () => {
    const costs = [0.000001, 0.001234, 0.002985, 0.005779, 0.000002];
    const subtotals = [0.000001, 0.001235, 0.004220, 0.009999, 0.010001];
    for (const [i, cost] of costs.entries()) {
      await addUsage(cost, i % 2 === 0 ? 'gpt-3.5-turbo' : 'gpt-4');
      expect(writes[i]).toBeCloseTo(subtotals[i], 12);
    }
    expect(stored.total_cost).toBeCloseTo(0.010001, 12);
    expect(stored.cheap_model_count).toBe(3);
    expect(stored.expert_model_count).toBe(2);
  });

  it.each([
    [0.009998, 0.000001, 0.009999],
    [0.009999, 0.000001, 0.010000],
    [0.010000, 0.000001, 0.010001],
    [0.004999, 0.000001, 0.005000],
  ])('adds $%s + $%s without rounding to cents', async (initial, charge, expected) => {
    stored.total_cost = initial;
    await addUsage(charge, 'gpt-3.5-turbo');
    expect(writes).toHaveLength(1);
    expect(stored.total_cost).toBeCloseTo(expected, 12);
  });

  it('adds a fractional-cent charge to an existing cents-based balance', async () => {
    stored.total_cost = 12.34;
    await addUsage(0.000001, 'gpt-4');
    expect(stored.total_cost).toBeCloseTo(12.340001, 12);
  });
});
