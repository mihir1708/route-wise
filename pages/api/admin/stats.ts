import type { NextApiRequest, NextApiResponse } from 'next';
import { protect } from '@/lib/access';
import { supabaseAdmin } from '@/lib/supabase';
import { getCurrentMonth, getCurrentMonthUsage, getTenantAdmission } from '@/lib/budget-tracker';
import { DASHBOARD_DAYS, dashboardWindow } from '@/lib/dashboard';
import type { DashboardStats } from '@/types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!protect(req, res, 'admin')) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const days = req.query.days === undefined ? 7 : Number(req.query.days);
  if (!(DASHBOARD_DAYS as readonly number[]).includes(days)) return res.status(400).json({ error: 'days must be 7 or 30' });
  const tenant = typeof req.query.tenant === 'string' && req.query.tenant !== '' ? req.query.tenant : null;
  if (tenant !== null && !UUID.test(tenant)) return res.status(400).json({ error: 'Invalid tenant' });
  try {
    const { start, end } = dashboardWindow(days);
    const { data, error } = await supabaseAdmin.rpc('gateway_dashboard', {
      p_start: start.toISOString(), p_end: end.toISOString(), p_tenant: tenant,
    });
    if (error || !data) throw new Error('Stats unavailable');
    if (tenant && !data.tenants.some((t: { id: string }) => t.id === tenant)) return res.status(404).json({ error: 'Unknown tenant' });
    let budget: DashboardStats['budget'];
    if (tenant) {
      const a = await getTenantAdmission(tenant);
      budget = { scope: 'tenant', month: getCurrentMonth(), limit: a.tenantBudget, spent: a.tenantSpent };
    } else {
      const g = await getCurrentMonthUsage();
      budget = { scope: 'global', month: getCurrentMonth(), limit: Number(g.budget_limit), spent: Number(g.total_cost) };
    }
    const stats: DashboardStats = {
      ...data, days, tenant, window_start: start.toISOString(), window_end: end.toISOString(), budget,
    };
    return res.status(200).json(stats);
  } catch { return res.status(503).json({ error: 'Statistics unavailable' }); }
}
