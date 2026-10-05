// Frozen pre-T03 accounting implementation for T02 characterization only.
// Tracks API spending and enforces monthly budget limits

import { supabaseAdmin } from '@/lib/supabase';
import { BudgetStatus, ModelName } from '@/types';
import { logger } from '@/utils/logger';

// Get current month in YYYY-MM format
function getCurrentMonth(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

// Get budget limit from env vars or default to $100
function getBudgetLimit(): number {
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

  // Try to get existing record
  const { data, error } = await supabaseAdmin
    .from('budget_tracking')
    .select('*')
    .eq('month', currentMonth)
    .single();

  if (error && error.code !== 'PGRST116') {
    // PGRST116 just means no rows found
    logger.error('Error fetching budget status', error);
    throw new Error('Failed to fetch budget status');
  }

  // Create new record if this is the first request of the month
  if (!data) {
    const { data: newData, error: insertError } = await supabaseAdmin
      .from('budget_tracking')
      .insert({
        month: currentMonth,
        total_cost: 0,
        total_requests: 0,
        cheap_model_count: 0,
        mid_model_count: 0,
        expert_model_count: 0,
        budget_limit: budgetLimit
      })
      .select()
      .single();

    if (insertError || !newData) {
      logger.error('Error creating budget record', insertError);
      throw new Error('Failed to create budget record');
    }

    return newData as BudgetStatus;
  }

  return data as BudgetStatus;
}

// Add a request's cost to this month's budget
export async function addUsage(cost: number, model: ModelName): Promise<void> {
  const currentMonth = getCurrentMonth();
  const usage = await getCurrentMonthUsage();

  // Figure out which model counter to increment
  let modelCountField = 'cheap_model_count';
  if (model === 'gpt-4') {
    modelCountField = 'expert_model_count';
  }

  // Update the totals
  const { error } = await supabaseAdmin
    .from('budget_tracking')
    .update({
      total_cost: usage.total_cost + cost,
      total_requests: usage.total_requests + 1,
      [modelCountField]: (usage as any)[modelCountField] + 1
    })
    .eq('month', currentMonth);

  if (error) {
    logger.error('Error updating budget tracking', error);
    throw new Error('Failed to update budget tracking');
  }

  // Log warnings if we're getting close to budget limit
  const newTotal = usage.total_cost + cost;
  const percentage = (newTotal / usage.budget_limit) * 100;
  const alertThreshold = getAlertThreshold();

  if (percentage >= alertThreshold && usage.total_cost / usage.budget_limit * 100 < alertThreshold) {
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
