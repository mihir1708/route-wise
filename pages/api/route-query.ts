// The demo page's endpoint: runs one gateway task as the demo tenant, whose monthly budget and
// rate limits cap what visitors can spend. Answers have the same body as /api/generate.
import { randomUUID } from 'node:crypto';
import type { NextApiRequest, NextApiResponse } from 'next';
import { protect } from '@/lib/access';
import { DEMO_MAX_INPUT_CHARS } from '@/lib/demo';
import { runGateway } from '@/lib/gateway';
import { DEMO_TENANT, findTenantByName } from '@/lib/tenants';
import { TASK_TYPES, type TaskType } from '@/prompts';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const requestId = randomUUID();
  res.setHeader('X-Request-Id', requestId);
  if (!protect(req, res, 'demo')) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed', request_id: requestId });
  const task = req.body?.task_type ?? 'chat';
  const input = req.body?.input;
  if (!TASK_TYPES.includes(task as TaskType)) return res.status(400).json({ error: 'invalid_task_type', request_id: requestId });
  if (typeof input !== 'string' || !input.trim()) return res.status(400).json({ error: 'invalid_input', request_id: requestId });
  if (input.length > DEMO_MAX_INPUT_CHARS) return res.status(413).json({ error: 'input_too_large', request_id: requestId });
  let tenant;
  try { tenant = await findTenantByName(DEMO_TENANT); } catch { tenant = null; }
  if (!tenant?.active) return res.status(503).json({ error: 'demo_tenant_unavailable', request_id: requestId });
  const result = await runGateway({ task_type: task, input }, tenant, requestId);
  for (const [name, value] of Object.entries(result.headers)) res.setHeader(name, value);
  return res.status(result.status).json(result.body);
}

export const config = { api: { bodyParser: { sizeLimit: '20kb' } } };
