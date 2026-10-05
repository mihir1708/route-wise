import { afterEach, describe, expect, it, vi } from 'vitest';
import { allowRate, authenticate, protect, publicDemo } from '@/lib/access';
import type { IncomingMessage, ServerResponse } from 'node:http';
afterEach(() => vi.unstubAllEnvs());
const password = 'a'.repeat(32);
const header = (role = 'demo', secret = password) => `Basic ${Buffer.from(`${role}:${secret}`).toString('base64')}`;
it('fails closed and never accepts short passwords', () => {
  vi.stubEnv('ROUTEWISE_DEMO_PASSWORD', 'short'); expect(authenticate(header('demo','short'))).toBeNull();
  expect(authenticate(undefined)).toBeNull(); expect(authenticate('Bearer arbitrary')).toBeNull();
});
it('accepts configured credentials, rejects wrong ones', () => {
  vi.stubEnv('ROUTEWISE_DEMO_PASSWORD', password);
  expect(authenticate(header())).toBe('demo'); expect(authenticate(header('demo','wrong'))).toBeNull();
});
it('rate buckets have fixed keys and reset after a minute', () => {
  expect(allowRate('demo', 1, 0)).toBe(true); expect(allowRate('demo', 1, 1)).toBe(false);
  expect(allowRate('demo', 1, 60001)).toBe(true);
});
it.each([['demo', 'GET', undefined, 403], ['admin', 'POST', 'https://evil.test', 403], ['admin', 'GET', undefined, 200]] as const)(
  'protects roles and origins %s %s', (role, method, origin, status) => {
    vi.stubEnv('ROUTEWISE_ADMIN_PASSWORD', password); vi.stubEnv('ROUTEWISE_DEMO_PASSWORD', password);
    const req = { headers: { authorization: header(role), origin, host: 'localhost:3000' }, method } as IncomingMessage;
    const res = { statusCode: 200, setHeader: vi.fn(), end: vi.fn() } as unknown as ServerResponse;
    protect(req, res, 'admin', false); expect(res.statusCode).toBe(status);
  },
);
describe('public demo', () => {
  const call = (required: 'demo' | 'admin', ip: string, authorization?: string) => {
    const req = { headers: { authorization, host: 'localhost:3000', 'x-forwarded-for': `${ip}, 10.0.0.1` }, method: 'POST', socket: {} } as unknown as IncomingMessage;
    const res = { statusCode: 200, setHeader: vi.fn(), end: vi.fn() } as unknown as ServerResponse;
    return { ok: protect(req, res, required), status: res.statusCode };
  };
  it('stays password-protected unless switched on', () => {
    vi.stubEnv('ROUTEWISE_ADMIN_PASSWORD', password);
    expect(publicDemo()).toBe(false);
    expect(call('demo', '203.0.113.1').status).toBe(401);
  });
  it('lets visitors use the demo, five requests a minute each, but never the admin pages', () => {
    vi.stubEnv('ROUTEWISE_ADMIN_PASSWORD', password); vi.stubEnv('ROUTEWISE_DEMO_PASSWORD', 'b'.repeat(32)); vi.stubEnv('ROUTEWISE_PUBLIC_DEMO', '1');
    for (let i = 0; i < 5; i++) expect(call('demo', '203.0.113.2').ok).toBe(true);
    expect(call('demo', '203.0.113.2').status).toBe(429);
    expect(call('demo', '203.0.113.3').ok).toBe(true);
    expect(call('admin', '203.0.113.4').status).toBe(401);
    expect(call('admin', '203.0.113.4', header('demo', 'b'.repeat(32))).status).toBe(403);
  });
  it('still needs the admin password configured', () => {
    vi.stubEnv('ROUTEWISE_PUBLIC_DEMO', '1'); vi.stubEnv('ROUTEWISE_ADMIN_PASSWORD', '');
    expect(call('demo', '203.0.113.5').status).toBe(503);
  });
  it('fails closed when too many visitors arrive in one minute, then recovers', async () => {
    vi.resetModules();
    const { allowRate: fresh } = await import('@/lib/access');
    for (let i = 0; i < 10000; i++) fresh(`visitor:${i}`, 5, 0);
    expect(fresh('visitor:new', 5, 1)).toBe(false);
    expect(fresh('visitor:0', 5, 2)).toBe(true);
    expect(fresh('visitor:new', 5, 60001)).toBe(true);
  });
});
