// Retry backoff and a per-model circuit breaker.

export interface RetryPolicy {
  /** Tries per model, including the first. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}
export const DEFAULT_RETRY_POLICY: RetryPolicy = { maxAttempts: 2, baseDelayMs: 250, maxDelayMs: 2000 };

/**
 * Delay before retry number `retry` (1-based): "full jitter" exponential backoff, so many
 * clients retrying at once spread out. A provider's Retry-After is a floor; when it is longer
 * than the policy allows, returns null and the caller moves on to the fallback instead of waiting.
 */
export function backoffDelay(retry: number, policy: RetryPolicy, retryAfterMs: number | null = null, random = Math.random): number | null {
  if (retryAfterMs !== null && retryAfterMs > policy.maxDelayMs) return null;
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (retry - 1));
  return Math.max(retryAfterMs ?? 0, Math.floor(random() * ceiling));
}

export type CircuitState = 'closed' | 'open' | 'half_open';
interface Circuit { failures: number; openedAt: number | null; probing: boolean }

/**
 * Stops sending traffic to a model after `threshold` consecutive transient failures, for
 * `cooldownMs`; then lets one probe through. A success closes it, a failure reopens it.
 * State is per server instance: on serverless hosting each instance learns independently.
 */
export class CircuitBreaker {
  private circuits = new Map<string, Circuit>();
  constructor(readonly threshold = 5, readonly cooldownMs = 30000, private now: () => number = Date.now) {}

  private circuit(key: string): Circuit {
    let c = this.circuits.get(key);
    if (!c) { c = { failures: 0, openedAt: null, probing: false }; this.circuits.set(key, c); }
    return c;
  }

  state(key: string): CircuitState {
    const c = this.circuit(key);
    if (c.openedAt === null) return 'closed';
    return this.now() - c.openedAt >= this.cooldownMs ? 'half_open' : 'open';
  }

  /** Whether a call may go out now. In half-open state only one probe is allowed at a time. */
  tryAcquire(key: string): boolean {
    const state = this.state(key);
    if (state === 'closed') return true;
    if (state === 'open') return false;
    const c = this.circuit(key);
    if (c.probing) return false;
    c.probing = true;
    return true;
  }

  success(key: string): void { this.circuits.set(key, { failures: 0, openedAt: null, probing: false }); }

  failure(key: string): void {
    const c = this.circuit(key);
    c.failures += 1; c.probing = false;
    if (c.openedAt !== null || c.failures >= this.threshold) c.openedAt = this.now();
  }

  /** A call that ended without saying anything about provider health (e.g. a bad request). */
  release(key: string): void { this.circuit(key).probing = false; }
}

export const sharedBreaker = new CircuitBreaker();
export const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
