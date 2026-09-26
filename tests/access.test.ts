import { afterEach, expect, it, vi } from 'vitest';
import { allowRate, authenticate, protect } from '@/lib/access';
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
