// Wires the request lifecycle to Postgres and the providers for one tenant.
import { getTenantAdmission, settleTenantUsage } from '@/lib/budget-tracker';
import { runtimeModels, type ModelTier } from '@/lib/model-registry';
import { callProvider } from '@/lib/providers';
import { executeGenerate, type CachedAnswer, type GenerateDependencies, type GenerateResult, type RateLimitResult } from '@/lib/request-run';
import { sharedBreaker } from '@/lib/resilience';
import { routeTask } from '@/lib/routing-policy';
import { supabaseAdmin } from '@/lib/supabase';
import type { Tenant } from '@/lib/tenants';

/** Response cache lifetime in seconds; 0 turns the cache off. */
export function cacheTtlSeconds(env = process.env): number {
  const raw = env.ROUTEWISE_CACHE_TTL_S;
  if (raw === undefined || raw === '') return 86400;
  const ttl = Number(raw);
  if (!Number.isSafeInteger(ttl) || ttl < 0 || ttl > 30 * 86400) throw new Error('ROUTEWISE_CACHE_TTL_S must be 0..2592000');
  return ttl;
}

export function gatewayDependencies(tenant: Tenant): GenerateDependencies {
  const models = runtimeModels();
  const ttl = cacheTtlSeconds();
  const deps: GenerateDependencies = {
    models,
    allowedTiers: tenant.allowed_tiers,
    async takeRateLimit(tokens) {
      const { data, error } = await supabaseAdmin.rpc('take_rate_limit', { p_tenant: tenant.id, p_tokens: tokens });
      if (error || !data) throw new Error('Rate limit check failed');
      return data as RateLimitResult;
    },
    async adjustTokens(windowStart, delta) {
      const { error } = await supabaseAdmin.rpc('adjust_rate_tokens', { p_tenant: tenant.id, p_window: windowStart, p_delta: delta });
      if (error) throw new Error('Rate token adjustment failed');
    },
    admit: () => getTenantAdmission(tenant.id),
    route: (request, context) => routeTask(request.task_type, request.input, {
      budgetPercentage: context.budgetPercentage, allowedTiers: tenant.allowed_tiers, models,
      priority: request.priority, latencyTargetMs: request.latency_target_ms, maxCostUsd: request.max_cost_usd,
      worstCase: context.worstCase,
    }),
    call: callProvider,
    breaker: sharedBreaker,
    settle: (cost, model, tier) => settleTenantUsage(tenant.id, cost, model, tier),
    async persist(run, attempts) {
      const { error } = await supabaseAdmin.from('request_runs').insert(run);
      if (error) throw new Error('Telemetry failed');
      if (!attempts.length) return;
      const rows = attempts.map(a => ({ ...a, request_id: run.request_id }));
      const { error: attemptsError } = await supabaseAdmin.from('request_attempts').insert(rows);
      if (attemptsError) throw new Error('Attempt telemetry failed');
    },
  };
  if (ttl > 0) {
    deps.cacheGet = async key => {
      const { data, error } = await supabaseAdmin.rpc('cache_lookup', { p_tenant: tenant.id, p_key: key });
      if (error) throw new Error('Cache lookup failed');
      const row = data as { answer?: unknown; model?: unknown; tier?: unknown } | null;
      return row && typeof row.answer === 'string' && typeof row.model === 'string' && typeof row.tier === 'string'
        ? { answer: row.answer, model: row.model, tier: row.tier as ModelTier } : null;
    };
    deps.cachePut = async (key, entry: CachedAnswer) => {
      const { error } = await supabaseAdmin.rpc('cache_store', {
        p_tenant: tenant.id, p_key: key, p_answer: entry.answer, p_model: entry.model, p_tier: entry.tier, p_ttl_s: ttl,
      });
      if (error) throw new Error('Cache store failed');
    };
  }
  return deps;
}

export function runGateway(body: unknown, tenant: Tenant, requestId: string): Promise<GenerateResult> {
  return executeGenerate(body, tenant.id, gatewayDependencies(tenant), requestId);
}
