// The chat UI's endpoint: a thin wrapper that runs a `chat` task as the demo tenant
// and returns the response shape the UI already uses.
import { enqueueVerification } from '@/lib/verification';
import { protect } from '@/lib/access';
import { randomUUID } from 'node:crypto';
import type { NextApiRequest, NextApiResponse } from 'next';
import { runGateway } from '@/lib/gateway';
import { DEMO_TENANT, findTenantByName } from '@/lib/tenants';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const requestId = randomUUID();
  res.setHeader('X-Request-Id', requestId);
  if (!protect(req, res, 'demo')) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed', request_id: requestId });
  let tenant;
  try { tenant = await findTenantByName(DEMO_TENANT); } catch { tenant = null; }
  if (!tenant?.active) return res.status(503).json({ error: 'demo_tenant_unavailable', request_id: requestId });
  // No response cache here: the UI shows the live budget, which a cache hit does not read.
  const result = await runGateway({ task_type: 'chat', input: req.body?.query, cache: false }, tenant, requestId);
  for (const [name, value] of Object.entries(result.headers)) res.setHeader(name, value);
  if (result.status !== 200) return res.status(result.status).json(result.body);
  const m = result.body.metadata as Record<string, unknown> & { tokens: { total: number } };
  if (typeof result.body.answer === 'string') {
    try { await enqueueVerification(req.body.query, result.body.answer, result.run, req.body.verify_consent === true); }
    catch { console.error('verification_enqueue_failed', { request_id: requestId }); }
  }
  return res.status(200).json({
    answer: result.body.answer,
    metadata: {
      request_id: requestId, model_used: m.model, model_tier: m.tier, difficulty_score: m.difficulty_score,
      tokens_used: m.tokens.total, cost: m.cost_usd, accounting_status: m.accounting_status,
      remaining_budget: m.tenant_budget_remaining, budget_limit: m.tenant_budget,
    },
  });
}

export const config = { api: { bodyParser: { sizeLimit: '20kb' } } };
