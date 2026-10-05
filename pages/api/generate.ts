// The gateway endpoint: POST /api/generate with `Authorization: Bearer rw_...`.
import { randomUUID } from 'node:crypto';
import type { NextApiRequest, NextApiResponse } from 'next';
import { runGateway } from '@/lib/gateway';
import { authenticateTenant } from '@/lib/tenants';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const requestId = randomUUID();
  res.setHeader('X-Request-Id', requestId);
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed', request_id: requestId });
  }
  let tenant;
  try { tenant = await authenticateTenant(req.headers.authorization); }
  catch { return res.status(503).json({ error: 'auth_unavailable', request_id: requestId }); }
  if (!tenant) {
    res.setHeader('WWW-Authenticate', 'Bearer realm="RouteWise"');
    return res.status(401).json({ error: 'invalid_api_key', request_id: requestId });
  }
  const result = await runGateway(req.body, tenant, requestId);
  for (const [name, value] of Object.entries(result.headers)) res.setHeader(name, value);
  return res.status(result.status).json(result.body);
}

export const config = { api: { bodyParser: { sizeLimit: '20kb' } } };
