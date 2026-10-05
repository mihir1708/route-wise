import { expect, it, vi } from 'vitest';
import { backoffDelay, CircuitBreaker } from '@/lib/resilience';
import { callWithFallback, type Attempt } from '@/lib/provider-chain';
import { classifyProviderError, ProviderError } from '@/lib/providers';
import type { ModelConfig } from '@/lib/model-registry';

const policy = { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000 };

it('backs off exponentially with full jitter, capped', () => {
  expect(backoffDelay(1, policy, null, () => 0.999)).toBe(99);
  expect(backoffDelay(3, policy, null, () => 0.999)).toBe(399);
  expect(backoffDelay(10, policy, null, () => 0.999)).toBe(999);
  expect(backoffDelay(1, policy, null, () => 0)).toBe(0);
});

it('treats Retry-After as a floor, and gives up on waits beyond the cap', () => {
  expect(backoffDelay(1, policy, 500, () => 0)).toBe(500);
  expect(backoffDelay(1, policy, 5000, () => 0)).toBeNull();
});

it('opens after the threshold, half-opens after the cooldown with one probe, and closes on success', () => {
  let now = 0; const b = new CircuitBreaker(2, 1000, () => now);
  b.failure('m'); expect(b.state('m')).toBe('closed');
  b.failure('m'); expect(b.state('m')).toBe('open'); expect(b.tryAcquire('m')).toBe(false);
  now = 1000; expect(b.state('m')).toBe('half_open');
  expect(b.tryAcquire('m')).toBe(true); expect(b.tryAcquire('m')).toBe(false); // one probe at a time
  b.success('m'); expect(b.state('m')).toBe('closed'); expect(b.tryAcquire('m')).toBe(true);
});

it('reopens when the probe fails, and a non-health error just frees the probe', () => {
  let now = 0; const b = new CircuitBreaker(1, 1000, () => now);
  b.failure('m'); now = 1000; expect(b.tryAcquire('m')).toBe(true);
  b.failure('m'); expect(b.state('m')).toBe('open');
  now = 2000; expect(b.tryAcquire('m')).toBe(true); b.release('m'); expect(b.tryAcquire('m')).toBe(true);
});

it('classifies SDK errors from both providers by name and status', () => {
  const err = (status: number, headers: Record<string, string> = {}) => Object.assign(new Error('x'), { status, headers: new Headers(headers) });
  expect(classifyProviderError(err(429, { 'retry-after': '2' }))).toMatchObject({ kind: 'rate_limited', retryAfterMs: 2000, retryable: true });
  expect(classifyProviderError(err(429, { 'retry-after-ms': '150' })).retryAfterMs).toBe(150);
  expect(classifyProviderError(err(529)).kind).toBe('overloaded');
  expect(classifyProviderError(err(502)).kind).toBe('server');
  expect(classifyProviderError(err(401))).toMatchObject({ kind: 'auth', retryable: false });
  expect(classifyProviderError(err(400))).toMatchObject({ kind: 'bad_request', retryable: false });
  expect(classifyProviderError(Object.assign(new Error('t'), { name: 'APIConnectionTimeoutError' })).kind).toBe('timeout');
  expect(classifyProviderError(Object.assign(new Error('n'), { name: 'APIConnectionError' })).kind).toBe('network');
  expect(classifyProviderError(new TypeError('boom')).kind).toBe('unknown');
  expect(new ProviderError('refused').retryable).toBe(false);
});

it('records every attempt without text and raises when the chain is exhausted', async () => {
  const model = (id: string, provider: ModelConfig['provider']): ModelConfig => ({
    id, provider, tier: 'low', inputPricePerMillion: 1, outputPricePerMillion: 1, enabled: true, temperature: null, maxOutputTokens: 100, pricingVersion: 't',
  });
  const attempts: Attempt[] = [];
  const call = vi.fn().mockRejectedValue(Object.assign(new Error('private'), { status: 500 }));
  await expect(callWithFallback([model('a', 'openai'), model('b', 'anthropic')], 'u', { system: 's', maxOutputTokens: 10 },
    { call, breaker: new CircuitBreaker(), sleep: async () => {}, retryPolicy: { ...policy, maxAttempts: 2 } }, attempts)).rejects.toThrow('all_providers_failed:server');
  expect(attempts.map(a => `${a.attempt}:${a.model}:${a.outcome}`)).toEqual(['1:a:error', '2:a:error', '3:b:error', '4:b:error']);
  expect(JSON.stringify(attempts)).not.toContain('private');
});
