// npm run tenant:create -- --name acme --budget 5 --rpm 30 --tpm 20000 [--tiers low,mid,high]
// Prints the API key once. Only its hash is stored, so a lost key means creating a new tenant.
import { supabaseAdmin } from '../lib/supabase';
import { generateApiKey } from '../lib/tenants';

function option(args: string[], name: string, fallback?: string): string {
  const i = args.indexOf(`--${name}`);
  const value = i >= 0 ? args[i + 1] : fallback;
  if (value === undefined) throw new Error(`Missing --${name}`);
  return value;
}

function positive(value: string, name: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--${name} must be a positive number`);
  return n;
}

async function main() {
  const args = process.argv.slice(2);
  const name = option(args, 'name');
  const tiers = option(args, 'tiers', 'low,mid,high').split(',');
  if (!tiers.length || tiers.some(t => !['low', 'mid', 'high'].includes(t))) throw new Error('--tiers must list low, mid and/or high');
  const { key, prefix, hash } = generateApiKey();
  const { error } = await supabaseAdmin.from('tenants').insert({
    name, api_key_hash: hash, key_prefix: prefix, allowed_tiers: tiers,
    monthly_budget: positive(option(args, 'budget'), 'budget'),
    rpm_limit: Math.floor(positive(option(args, 'rpm', '30'), 'rpm')),
    tpm_limit: Math.floor(positive(option(args, 'tpm', '20000'), 'tpm')),
  });
  if (error) throw new Error(`Could not create tenant: ${error.message}`);
  console.log(`Created tenant "${name}". API key (shown once, store it now):\n${key}`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
