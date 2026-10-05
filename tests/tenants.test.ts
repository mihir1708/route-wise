import { expect, it, vi } from 'vitest';
import { authenticateTenant, generateApiKey, hashApiKey, parseBearer, type Tenant } from '@/lib/tenants';

const tenant = (active = true): Tenant => ({
  id: 't1', name: 'acme', monthly_budget: 5, rpm_limit: 30, tpm_limit: 20000, allowed_tiers: ['low', 'mid', 'high'], active,
});

it('generates unique, well-formed keys whose hash is what gets stored', () => {
  const a = generateApiKey(); const b = generateApiKey();
  expect(a.key).toMatch(/^rw_[0-9a-f]{8}_[A-Za-z0-9_-]{32}$/); expect(a.key.startsWith(`${a.prefix}_`)).toBe(true);
  expect(a.hash).toBe(hashApiKey(a.key)); expect(a.hash).toMatch(/^[0-9a-f]{64}$/); expect(a.key).not.toBe(b.key);
});

it('parses only well-formed bearer keys', () => {
  const { key } = generateApiKey();
  expect(parseBearer(`Bearer ${key}`)).toBe(key);
  expect(parseBearer(undefined)).toBeNull(); expect(parseBearer(key)).toBeNull();
  expect(parseBearer('Bearer rw_short')).toBeNull(); expect(parseBearer(`Basic ${key}`)).toBeNull();
});

it('looks tenants up by key hash and rejects unknown or inactive tenants', async () => {
  const { key, hash } = generateApiKey();
  const lookup = vi.fn().mockImplementation(async (h: string) => (h === hash ? tenant() : null));
  expect(await authenticateTenant(`Bearer ${key}`, lookup)).toMatchObject({ id: 't1' });
  expect(lookup).toHaveBeenCalledWith(hash);
  expect(await authenticateTenant(`Bearer ${generateApiKey().key}`, lookup)).toBeNull();
  expect(await authenticateTenant(`Bearer ${key}`, async () => tenant(false))).toBeNull();
  const never = vi.fn(); expect(await authenticateTenant('Bearer nope', never)).toBeNull(); expect(never).not.toHaveBeenCalled();
});
