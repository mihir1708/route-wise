// Get usage stats for the admin dashboard

import type { NextApiRequest, NextApiResponse } from 'next';
import { UsageStats } from '@/types';
import { supabaseAdmin } from '@/lib/supabase';
import { getCurrentMonthUsage } from '@/lib/budget-tracker';
import { logger } from '@/utils/logger';
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<UsageStats | { error: string }>
) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const budgetStatus = await getCurrentMonthUsage();

    // Get recent logs
    const { data: recentLogs, error: logsError } = await supabaseAdmin
      .from('router_logs')
      .select('*')
      .order('timestamp', { ascending: false })
      .limit(20);

    if (logsError) {
      logger.error('Error fetching recent logs', logsError);
      throw new Error('Failed to fetch logs');
    }

    // Get cost history for last 30 days
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const { data: dailyCostsData, error: costsError } = await supabaseAdmin
      .from('router_logs')
      .select('timestamp, cost_usd')
      .gte('timestamp', thirtyDaysAgo.toISOString())
      .order('timestamp', { ascending: true });

    if (costsError) {
      logger.error('Error fetching daily costs', costsError);
      throw new Error('Failed to fetch daily costs');
    }

    // Group costs by day
    const dailyCostsMap: { [key: string]: number } = {};
    dailyCostsData?.forEach((log: any) => {
      const date = new Date(log.timestamp).toISOString().split('T')[0];
      dailyCostsMap[date] = (dailyCostsMap[date] || 0) + parseFloat(log.cost_usd);
    });

    const dailyCosts = Object.entries(dailyCostsMap).map(([date, cost]) => ({
      date,
      cost
    }));

    const modelDistribution: { [key: string]: number } = {
      'gpt-3.5-turbo': budgetStatus.cheap_model_count,
      'gpt-4': budgetStatus.expert_model_count
    };
    const stats: UsageStats = {
      total_requests: budgetStatus.total_requests,
      total_cost: budgetStatus.total_cost,
      budget_remaining: budgetStatus.budget_limit - budgetStatus.total_cost,
      model_distribution: modelDistribution,
      recent_logs: recentLogs || [],
      daily_costs: dailyCosts
    };

    return res.status(200).json(stats);

  } catch (error: any) {
    logger.error('Error fetching stats', error);
    return res.status(500).json({
      error: error.message || 'Failed to fetch statistics'
    });
  }
}
