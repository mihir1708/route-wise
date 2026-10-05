// Admin dashboard windows and the rates it charts from gateway_dashboard's counts.
import type { DashboardStats } from '@/types';

export const DASHBOARD_DAYS = [7, 30] as const;

/** The last `days` whole UTC days, today included: [start, end). Telemetry is kept 30 days. */
export function dashboardWindow(days: number, now = new Date()): { start: Date; end: Date } {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return { start: new Date(end.getTime() - days * 86400000), end };
}

/** Share of a total, or null when there is nothing to divide by. */
export function rate(count: number, total: number): number | null {
  return total > 0 ? count / total : null;
}

/** Each rate uses the requests it can apply to: fallbacks and escalations only happen on provider calls. */
export function dashboardRates(s: DashboardStats['summary']) {
  return {
    success: rate(s.succeeded, s.requests),
    cacheHit: rate(s.cache_hits, s.requests),
    fallback: rate(s.fallbacks, s.provider_requests),
    escalation: rate(s.escalations, s.provider_requests),
    rateLimited: rate(s.rate_limited, s.requests),
    costPerSuccess: s.succeeded > 0 ? Number(s.cost_usd) / s.succeeded : null,
  };
}
