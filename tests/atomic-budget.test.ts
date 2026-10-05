import { beforeEach, expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ supabaseAdmin: db }));
import { addUsage, getCurrentMonthUsage } from '@/lib/budget-tracker';
beforeEach(() => { db.rpc.mockReset(); db.rpc.mockResolvedValue({ data: { total_cost: 0.1, budget_limit: 100 }, error: null }); });
it('sends concurrent increments without an application read/modify/write', async () => {
  await Promise.all(Array.from({ length: 100 }, () => addUsage(0.001, 'gpt-3.5-turbo')));
  expect(db.rpc).toHaveBeenCalledTimes(100);
  for (const [name, args] of db.rpc.mock.calls) {
    expect(name).toBe('increment_budget_usage');
    expect(args.p_cost).toBe(0.001);
  }
});
it('uses conflict-safe monthly initialization', async () => {
  await getCurrentMonthUsage();
  expect(db.rpc).toHaveBeenCalledWith('ensure_budget_month', expect.objectContaining({ p_limit: 100 }));
});
it('surfaces settlement errors', async () => {
  db.rpc.mockResolvedValue({ error: { message: 'database unavailable' } });
  await expect(addUsage(0.001, 'gpt-4')).rejects.toThrow('Failed to update');
});
it('normalizes a composite RPC row returned as an array',async()=>{
  db.rpc.mockResolvedValue({data:[{month:'2026-09',total_cost:0.001,budget_limit:100}],error:null});
  expect((await getCurrentMonthUsage()).total_cost).toBe(0.001);
});
