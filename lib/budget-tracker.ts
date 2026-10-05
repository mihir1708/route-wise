import { getModel } from '@/lib/model-registry';
import type { ModelTier } from '@/lib/model-registry';
import type { Admission } from '@/lib/request-run';
// Tracks API spending and enforces monthly budget limits

import { supabaseAdmin } from './supabase';
import { BudgetStatus, ModelName } from '@/types';
import { logger } from '@/utils/logger';

// Get current month in YYYY-MM format
export function getCurrentMonth(): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

// Get budget limit from env vars or default to $100
export function getBudgetLimit(): number {
  const limit = process.env.MONTHLY_BUDGET_LIMIT;
  return limit ? parseFloat(limit) : 100.0;
}

// Get alert threshold from env vars or default to 80%
function getAlertThreshold(): number {
  const threshold = process.env.ALERT_THRESHOLD_PERCENT;
  return threshold ? parseFloat(threshold) : 80;
}

// Get this month's budget usage, create new record if needed
export async function getCurrentMonthUsage(): Promise<BudgetStatus> {
  const currentMonth = getCurrentMonth();
  const budgetLimit = getBudgetLimit();

  const { data, error } = await supabaseAdmin.rpc('ensure_budget_month', {
    p_month: currentMonth, p_limit: budgetLimit,
  });
  if (error || !data) throw new Error('Failed to fetch budget status');
  return (Array.isArray(data) ? data[0] : data) as BudgetStatus;
}

// Add a request's cost to this month's budget
export async function addUsage(cost: number, model: ModelName): Promise<void> {
  const currentMonth = getCurrentMonth();
  const { data, error } = await supabaseAdmin.rpc('increment_budget_usage', {
    p_month: currentMonth, p_cost: cost, p_model: model, p_tier: getModel(model).tier, p_limit: getBudgetLimit(),
  });
  if (error || !data) throw new Error('Failed to update budget tracking');
  const usage = (Array.isArray(data) ? data[0] : data) as BudgetStatus;

  // Log warnings if we're getting close to budget limit
  const newTotal = usage.total_cost;
  const percentage = (newTotal / usage.budget_limit) * 100;
  const alertThreshold = getAlertThreshold();

  if (percentage >= alertThreshold && (usage.total_cost - cost) / usage.budget_limit * 100 < alertThreshold) {
    logger.warn(`⚠️ BUDGET ALERT: ${percentage.toFixed(1)}% of monthly budget used!`, {
      total_cost: newTotal,
      budget_limit: usage.budget_limit,
      percentage: percentage.toFixed(2)
    });
  }

  if (percentage >= 100) {
    logger.error('🚨 BUDGET EXCEEDED: Monthly budget limit reached!', {
      total_cost: newTotal,
      budget_limit: usage.budget_limit
    });
  }
}

// Check if we still have budget available
export async function checkBudgetAvailable(): Promise<boolean> {
  const usage = await getCurrentMonthUsage();
  const percentage = (usage.total_cost / usage.budget_limit) * 100;
  
  return percentage < 100;
}

// Get percentage of budget used so far
export async function getBudgetPercentage(): Promise<number> {
  const usage = await getCurrentMonthUsage();
  return (usage.total_cost / usage.budget_limit) * 100;
}

// Get how much budget is left in dollars
export async function getRemainingBudget(): Promise<number> {
  const usage = await getCurrentMonthUsage();
  return Math.max(0, usage.budget_limit - usage.total_cost);
}

// Reset budget (for testing or new month)
export async function resetBudget(month?: string): Promise<void> {
  const targetMonth = month || getCurrentMonth();
  const budgetLimit = getBudgetLimit();

  const { error } = await supabaseAdmin
    .from('budget_tracking')
    .upsert({
      month: targetMonth,
      total_cost: 0,
      total_requests: 0,
      cheap_model_count: 0,
      mid_model_count: 0,
      expert_model_count: 0,
      budget_limit: budgetLimit
    });

  if (error) {
    logger.error('Error resetting budget', error);
    throw new Error('Failed to reset budget');
  }

  logger.info(`Budget reset for month: ${targetMonth}`);
}

// Tenant and global spend for this month, read in one round trip.
export async function getTenantAdmission(tenantId: string): Promise<Admission> {
  const { data, error } = await supabaseAdmin.rpc('tenant_admission', {
    p_tenant: tenantId, p_month: getCurrentMonth(), p_global_limit: getBudgetLimit(),
  });
  if (error || !data) throw new Error('Failed to fetch tenant budget');
  return {
    tenantSpent: Number(data.tenant_spent), tenantBudget: Number(data.tenant_budget),
    globalSpent: Number(data.global_spent), globalLimit: Number(data.global_limit),
  };
}

// Charges the tenant's month and the global month in one database transaction.
export async function settleTenantUsage(tenantId: string, cost: number, model: ModelName, tier: ModelTier): Promise<void> {
  const { data, error } = await supabaseAdmin.rpc('settle_request', {
    p_tenant: tenantId, p_month: getCurrentMonth(), p_cost: cost, p_model: model, p_limit: getBudgetLimit(), p_tier: tier,
  });
  if (error || !data) throw new Error('Failed to settle tenant usage');
}
