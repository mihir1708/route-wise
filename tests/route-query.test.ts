import { beforeEach, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
const mocks = vi.hoisted(() => ({ protect: vi.fn(), runGateway: vi.fn(), findTenantByName: vi.fn() }));
vi.mock('@/lib/access', () => ({ protect: mocks.protect }));
vi.mock('@/lib/gateway', () => ({ runGateway: mocks.runGateway }));
vi.mock('@/lib/tenants', () => ({ DEMO_TENANT: 'demo', findTenantByName: mocks.findTenantByName }));
import handler from '@/pages/api/route-query';
import { DEMO_MAX_INPUT_CHARS, DEMO_TASKS } from '@/lib/demo';
import { TASK_TYPES } from '@/prompts';

const demo = { id: 't-demo', name: 'demo', active: true };
const call = async (body: unknown, method = 'POST') => {
  const res = { setHeader: vi.fn(), status: vi.fn().mockReturnThis(), json: vi.fn() };
  await handler({ method, body } as NextApiRequest, res as unknown as NextApiResponse);
  return res;
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.protect.mockReturnValue(true);
  mocks.findTenantByName.mockResolvedValue(demo);
  mocks.runGateway.mockResolvedValue({ status: 200, headers: {}, body: { answer: '{}', metadata: { tier: 'low' } } });
});

it('runs the chosen task as the demo tenant and returns the gateway body', async () => {
  const res = await call({ task_type: 'classify', input: 'Card reader offline' });
  expect(mocks.runGateway).toHaveBeenCalledWith({ task_type: 'classify', input: 'Card reader offline' }, demo, expect.any(String));
  expect(res.status).toHaveBeenCalledWith(200);
  expect(res.json).toHaveBeenCalledWith({ answer: '{}', metadata: { tier: 'low' } });
});

it('passes gateway rejections through with their status and headers', async () => {
  mocks.runGateway.mockResolvedValue({ status: 429, headers: { 'Retry-After': '30' }, body: { error: 'rpm_exceeded' } });
  const res = await call({ input: 'hello' });
  expect(mocks.runGateway.mock.calls[0][0].task_type).toBe('chat');
  expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '30');
  expect(res.status).toHaveBeenCalledWith(429);
});

it.each([
  [{ task_type: 'delete_everything', input: 'x' }, 400],
  [{ task_type: 'chat', input: '  ' }, 400],
  [{ task_type: 'chat', input: 'x'.repeat(DEMO_MAX_INPUT_CHARS + 1) }, 413],
])('rejects bad input before spending anything: %#', async (body, status) => {
  const res = await call(body);
  expect(res.status).toHaveBeenCalledWith(status);
  expect(mocks.runGateway).not.toHaveBeenCalled();
});

it('refuses when access is denied or the demo tenant is missing', async () => {
  mocks.protect.mockReturnValue(false);
  await call({ input: 'x' });
  mocks.protect.mockReturnValue(true);
  mocks.findTenantByName.mockResolvedValue({ ...demo, active: false });
  const res = await call({ input: 'x' });
  expect(res.status).toHaveBeenCalledWith(503);
  expect(mocks.runGateway).not.toHaveBeenCalled();
});

it('ships one sample per task, each within the demo limit', () => {
  expect(DEMO_TASKS.map(t => t.task).sort()).toEqual([...TASK_TYPES].sort());
  expect(DEMO_TASKS.every(t => t.sample.length <= DEMO_MAX_INPUT_CHARS)).toBe(true);
});
