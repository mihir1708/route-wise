// Tenant API keys: "rw_<8 hex>_<32 base64url>". Only the SHA-256 hash is stored;
// the keys are 192-bit random, so a plain hash is enough (no password stretching).
import { createHash, randomBytes } from 'node:crypto';
import type { ModelTier } from '@/lib/model-registry';
import { supabaseAdmin } from '@/lib/supabase';

export interface Tenant {
  id: string;
  name: string;
  monthly_budget: number;
  rpm_limit: number;
  tpm_limit: number;
  allowed_tiers: ModelTier[];
  active: boolean;
}

/** Created by migration 009; the chat UI runs as this tenant. */
export const DEMO_TENANT = 'demo';

const KEY_PATTERN = /^rw_[0-9a-f]{8}_[A-Za-z0-9_-]{32}$/;

export function generateApiKey(): { key: string; prefix: string; hash: string } {
  const prefix = `rw_${randomBytes(4).toString('hex')}`;
  const key = `${prefix}_${randomBytes(24).toString('base64url')}`;
  return { key, prefix, hash: hashApiKey(key) };
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/** The key from an `Authorization: Bearer rw_...` header, or null if malformed. */
export function parseBearer(header: string | undefined): string | null {
  if (!header?.startsWith('Bearer ') || header.length > 256) return null;
  const key = header.slice(7).trim();
  return KEY_PATTERN.test(key) ? key : null;
}

const COLUMNS = 'id,name,monthly_budget,rpm_limit,tpm_limit,allowed_tiers,active';

function toTenant(row: Record<string, unknown>): Tenant {
  return {
    id: String(row.id), name: String(row.name), active: row.active === true,
    monthly_budget: Number(row.monthly_budget), rpm_limit: Number(row.rpm_limit), tpm_limit: Number(row.tpm_limit),
    allowed_tiers: (row.allowed_tiers as ModelTier[]) ?? [],
  };
}

export async function findTenantByKeyHash(hash: string): Promise<Tenant | null> {
  const { data, error } = await supabaseAdmin.from('tenants').select(COLUMNS).eq('api_key_hash', hash).maybeSingle();
  if (error) throw new Error('Tenant lookup failed');
  return data ? toTenant(data) : null;
}

export async function findTenantByName(name: string): Promise<Tenant | null> {
  const { data, error } = await supabaseAdmin.from('tenants').select(COLUMNS).eq('name', name).maybeSingle();
  if (error) throw new Error('Tenant lookup failed');
  return data ? toTenant(data) : null;
}

export async function authenticateTenant(
  header: string | undefined,
  lookup: (hash: string) => Promise<Tenant | null> = findTenantByKeyHash,
): Promise<Tenant | null> {
  const key = parseBearer(header);
  if (!key) return null;
  const tenant = await lookup(hashApiKey(key));
  return tenant?.active ? tenant : null;
}
