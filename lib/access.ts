import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
export type AccessRole = 'demo' | 'admin';
const buckets = new Map<string, { start: number; count: number }>();
export function allowRate(key: AccessRole | 'attempt', limit: number, now = Date.now()): boolean {
  let bucket = buckets.get(key);
  if (!bucket || now - bucket.start >= 60000) { bucket = { start: now, count: 0 }; buckets.set(key, bucket); }
  return ++bucket.count <= limit;
}
function equal(a: string, b: string) {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}
export function authenticate(header: string | undefined): AccessRole | null {
  if (!header?.startsWith('Basic ') || header.length > 1024) return null;
  const value = Buffer.from(header.slice(6), 'base64').toString();
  const colon = value.indexOf(':');
  const role = value.slice(0, colon);
  const secret = role === 'admin' ? process.env.ROUTEWISE_ADMIN_PASSWORD : role === 'demo' ? process.env.ROUTEWISE_DEMO_PASSWORD : undefined;
  return secret && secret.length >= 32 && equal(value.slice(colon + 1), secret) ? role as AccessRole : null;
}
export function protect(req: IncomingMessage, res: ServerResponse, required: AccessRole, rateLimit = true): boolean {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Vary', 'Authorization');
  const reject = (status: number, message: string) => {
    res.statusCode = status; res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: message })); return false;
  };
  if (!process.env.ROUTEWISE_ADMIN_PASSWORD || process.env.ROUTEWISE_ADMIN_PASSWORD.length < 32) return reject(503, 'Access protection is not configured');
  if (rateLimit && !allowRate('attempt', 120)) { res.setHeader('Retry-After', '60'); return reject(429, 'Too many attempts'); }
  const role = authenticate(req.headers.authorization);
  if (!role) { res.setHeader('WWW-Authenticate', 'Basic realm="RouteWise", charset="UTF-8"'); return reject(401, 'Authentication required'); }
  if (required === 'admin' && role !== 'admin') return reject(403, 'Admin access required');
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const origin = req.headers.origin;
    let sameOrigin = !origin;
    try { if (origin) sameOrigin = process.env.APP_ORIGIN ? origin === process.env.APP_ORIGIN : new URL(origin).host === req.headers.host; } catch { sameOrigin = false; }
    if (!sameOrigin || req.headers['sec-fetch-site'] === 'cross-site') return reject(403, 'Cross-site request denied');
  }
  if (rateLimit && !allowRate(role, role === 'admin' ? 60 : 10)) { res.setHeader('Retry-After', '60'); return reject(429, 'Rate limit exceeded'); }
  return true;
}
