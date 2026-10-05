// Wires the request lifecycle to Postgres and the provider for one tenant.
import { getTenantAdmission, settleTenantUsage } from '@/lib/budget-tracker';
import { callModel } from '@/lib/model-client';
import { getModel, modelCost } from '@/lib/model-registry';
import { executeGenerate, type GenerateDependencies, type GenerateResult, type RateLimitResult } from '@/lib/request-run';
import { routeTask } from '@/lib/routing-policy';
import { supabaseAdmin } from '@/lib/supabase';
import type { Tenant } from '@/lib/tenants';

export function gatewayDependencies(tenant: Tenant): GenerateDependencies {
  return {
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
    route: (request, budgetPercentage) =>
      routeTask(request.task_type, request.input, { budgetPercentage, allowedTiers: tenant.allowed_tiers }),
    price: (model, input, output) => modelCost(getModel(model), input, output),
    call: callModel,
    settle: (cost, model, tier) => settleTenantUsage(tenant.id, cost, model, tier),
    async persist(run) {
      const { error } = await supabaseAdmin.from('request_runs').insert(run);
      if (error) throw new Error('Telemetry failed');
    },
  };
}

export function runGateway(body: unknown, tenant: Tenant, requestId: string): Promise<GenerateResult> {
  return executeGenerate(body, tenant.id, gatewayDependencies(tenant), requestId);
}
