import { enqueueVerification } from '@/lib/verification';
import { heuristicV1 } from '@/lib/routing-policy';
import { protect } from '@/lib/access';
import { randomUUID } from 'node:crypto';
import type { NextApiRequest, NextApiResponse } from 'next';
import { getCurrentMonthUsage, addUsage } from '@/lib/budget-tracker';
import { callModel } from '@/lib/model-client';
import { calculateCost } from '@/utils/pricing';
import { supabaseAdmin } from '@/lib/supabase';
import { executeQuery } from '@/lib/request-run';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const requestId = randomUUID();
  res.setHeader('X-Request-Id', requestId);
  if (!protect(req, res, 'demo')) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed', request_id: requestId });
  const result = await executeQuery(req.body?.query, {
    admit: async () => {
      const usage = await getCurrentMonthUsage();
      return { limit: usage.budget_limit, percentage: usage.total_cost / usage.budget_limit * 100, remaining: usage.budget_limit - usage.total_cost };
    },
    route: (query, percentage) => heuristicV1.route(query, { budgetPercentage: percentage }),
    call: callModel, price: calculateCost, settle: addUsage,
    persist: async run => {
      const { error } = await supabaseAdmin.from('request_runs').insert(run);
      if (error) throw new Error('Telemetry failed');
    },
  }, requestId);
  if (result.run.application_succeeded && typeof result.body.answer === 'string') {
    try { await enqueueVerification(req.body.query, result.body.answer, result.run, req.body.verify_consent === true); }
    catch { console.error('verification_enqueue_failed', { request_id: requestId }); }
  }
  return res.status(result.status).json(result.body);
}

export const config = { api: { bodyParser: { sizeLimit: '20kb' } } };
