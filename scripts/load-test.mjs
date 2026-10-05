// Load test of the gateway's Postgres path: the database calls one /api/generate request makes.
// Requires a disposable server: it creates its own database there, measures it with pgbench, then drops it.
//   ROUTEWISE_DB_TEST_DISPOSABLE=1 ROUTEWISE_TEST_DATABASE_URL=postgresql://... npm run load-test -- --clients 32 --seconds 20
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.env.ROUTEWISE_DB_TEST_DISPOSABLE !== '1' || !process.env.ROUTEWISE_TEST_DATABASE_URL) throw new Error('Explicit disposable database opt-in required');
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, a, i, all) => (a.startsWith('--') ? [...pairs, [a.slice(2), all[i + 1]]] : pairs), []));
const int = (name, fallback) => {
  const n = args[name] === undefined ? fallback : Number(args[name]);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`--${name} must be a positive integer`);
  return n;
};
const CLIENTS = int('clients', 32);
const THREADS = Math.min(CLIENTS, int('threads', 4));
const SECONDS = int('seconds', 20);
const TENANTS = int('tenants', 64);
const RPM_LIMIT = 100;
const MONTH = '2099-07';
const COST = '0.000123'; // per request, so the expected total is exact in numeric(14,6)

function run(command, commandArgs, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    child.stdout.on('data', c => out += c); child.stderr.on('data', c => err += c);
    child.on('error', reject);
    child.on('close', code => (code === 0 ? resolve(out) : reject(new Error(`${command} failed: ${err || out}`))));
    child.stdin.end(input ?? '');
  });
}
const sql = (text, db) => run('psql', ['-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-d', db], text);

const server = new URL(process.env.ROUTEWISE_TEST_DATABASE_URL);
const dbName = `routewise_load_${Date.now()}`;
const db = new URL(server); db.pathname = `/${dbName}`;
const tenantId = n => `md5('load-${n}')::uuid`;

/** One gateway request's database calls, each its own round trip as through the Supabase API. Cache off. */
const SETTLE = `SELECT public.settle_request(md5('load-' || :t)::uuid, '${MONTH}', ${COST}, 'load-model', 1000000, 'mid');`;
/** Diagnostic only: settles the tenant's month but skips the global month and model rows every request shares. */
const SETTLE_TENANT_ONLY = `INSERT INTO public.tenant_usage(tenant_id, month, total_cost, total_requests) VALUES (md5('load-' || :t)::uuid, '${MONTH}', ${COST}, 1)
  ON CONFLICT (tenant_id, month) DO UPDATE SET total_cost = public.tenant_usage.total_cost + EXCLUDED.total_cost, total_requests = public.tenant_usage.total_requests + 1;`;
const request = settle => `\\set t random(0, :tenants - 1)
SELECT (public.take_rate_limit(md5('load-' || :t)::uuid, 1200))->>'window_start' AS win \\gset
SELECT public.tenant_admission(md5('load-' || :t)::uuid, '${MONTH}', 1000000);
${settle}
SELECT public.adjust_rate_tokens(md5('load-' || :t)::uuid, :win, -400);
INSERT INTO public.request_runs(request_id, latency_ms, provider_succeeded, application_succeeded, tenant_id, task_type, cost_usd, attempt_count)
  VALUES (gen_random_uuid(), 1500, true, true, md5('load-' || :t)::uuid, 'summarize', ${COST}, 1) RETURNING request_id AS rid \\gset
INSERT INTO public.request_attempts(request_id, attempt, model, provider, tier, outcome, latency_ms)
  VALUES (:rid, 1, 'load-model', 'openai', 'mid', 'ok', 1500);
`;
/** Only the rate limiter, against one tenant whose limit is far below the offered load. */
const RATE_ONLY = `SELECT public.take_rate_limit(md5('load-limited')::uuid, 10);\n`;

function percentile(sorted, p) { return sorted[Math.min(sorted.length - 1, Math.ceil(p / 100 * sorted.length) - 1)]; }

async function pgbench(name, script, tenants, dir) {
  const file = join(dir, `${name}.sql`); writeFileSync(file, script);
  const prefix = join(dir, name);
  const out = await run('pgbench', ['-n', '-M', 'extended', '-c', String(CLIENTS), '-j', String(THREADS), '-T', String(SECONDS),
    '-D', `tenants=${tenants}`, '-f', file, '-l', `--log-prefix=${prefix}`, db.toString()]);
  const processed = Number(/number of transactions actually processed: (\d+)/.exec(out)?.[1]);
  const failed = Number(/number of failed transactions: (\d+)/.exec(out)?.[1] ?? 0);
  const tps = Number(/tps = ([\d.]+) \(without initial connection time\)/.exec(out)?.[1]);
  const latencies = readdirSync(dir).filter(f => f.startsWith(`${name}.`) && f !== `${name}.sql`)
    .flatMap(f => readFileSync(join(dir, f), 'utf8').trim().split('\n').filter(Boolean).map(line => Number(line.split(' ')[2]) / 1000))
    .sort((a, b) => a - b);
  if (!Number.isSafeInteger(processed) || !Number.isFinite(tps) || latencies.length !== processed) throw new Error(`Could not read pgbench output for ${name}:\n${out}`);
  return { processed, failed, tps, p50: percentile(latencies, 50), p95: percentile(latencies, 95), p99: percentile(latencies, 99) };
}

async function check(label, query, expected) {
  const actual = (await sql(query, db.toString())).trim();
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}`);
}

const dir = mkdtempSync(join(tmpdir(), 'routewise-load-'));
await sql(`CREATE DATABASE ${dbName}`, server.toString());
try {
  await sql(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
DO $$ BEGIN
  IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
  IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role BYPASSRLS; END IF;
END $$;` + readFileSync('supabase-schema.sql', 'utf8'), db.toString());
  const rows = Array.from({ length: TENANTS }, (_, n) => `(${tenantId(n)}, 'load-${n}', 99999999, 2000000000, 2000000000)`);
  await sql(`INSERT INTO tenants(id, name, monthly_budget, rpm_limit, tpm_limit) VALUES ${rows.join(',')},
    (md5('load-limited')::uuid, 'load-limited', 1, ${RPM_LIMIT}, 2000000000);`, db.toString());

  const scenarios = [];
  const runs = [['one-tenant', 1, SETTLE], ['many-tenants', TENANTS, SETTLE], ['many-tenants, no global row (diagnostic)', TENANTS, SETTLE_TENANT_ONLY]];
  for (const [name, tenants, settle] of runs) {
    await sql(`TRUNCATE request_attempts, verification_jobs, request_runs, rate_limit_windows, tenant_usage; DELETE FROM model_usage WHERE month='${MONTH}'; DELETE FROM budget_tracking WHERE month='${MONTH}';`, db.toString());
    const r = await pgbench(name.split(',')[0] + (settle === SETTLE ? '' : '-diagnostic'), request(settle), tenants, dir);
    const n = String(r.processed);
    // Every completed request must be charged, counted and logged exactly once.
    await check(`${name}: tenant requests`, `SELECT sum(total_requests) FROM tenant_usage WHERE month='${MONTH}'`, n);
    await check(`${name}: tenant cost`, `SELECT sum(total_cost) = ${n} * ${COST} FROM tenant_usage WHERE month='${MONTH}'`, 't');
    if (settle === SETTLE) {
      await check(`${name}: global requests`, `SELECT total_requests FROM budget_tracking WHERE month='${MONTH}'`, n);
      await check(`${name}: global cost`, `SELECT total_cost = ${n} * ${COST} FROM budget_tracking WHERE month='${MONTH}'`, 't');
    }
    await check(`${name}: rate-limit requests`, `SELECT sum(requests) FROM rate_limit_windows`, n);
    await check(`${name}: rate-limit tokens`, `SELECT sum(tokens) = ${n} * 800 FROM rate_limit_windows`, 't');
    await check(`${name}: telemetry rows`, `SELECT (SELECT count(*) FROM request_runs) || '/' || (SELECT count(*) FROM request_attempts)`, `${n}/${n}`);
    scenarios.push({ name, tenants, ...r });
  }

  const limited = await pgbench('rate-limit', RATE_ONLY, 1, dir);
  // No one-minute window may admit more than the limit, and a full window must reach it exactly.
  await check('rate limit never exceeded', `SELECT bool_and(requests <= ${RPM_LIMIT}) AND bool_or(requests = ${RPM_LIMIT}) FROM rate_limit_windows WHERE tenant_id = md5('load-limited')::uuid`, 't');
  const admitted = Number((await sql(`SELECT sum(requests) FROM rate_limit_windows WHERE tenant_id = md5('load-limited')::uuid`, db.toString())).trim());

  const version = (await sql('SHOW server_version', db.toString())).trim();
  const ms = x => `${x.toFixed(1)} ms`;
  const lines = [
    '# RouteWise load test: Postgres request path',
    '',
    `${new Date().toISOString().slice(0, 10)}, PostgreSQL ${version} and pgbench on the same ${cpus().length}-core machine, ${CLIENTS} concurrent clients on ${THREADS} threads, ${SECONDS} s per scenario.`,
    '',
    'Each transaction is the database work of one gateway request with the cache off, as separate round trips: take the rate limit, read tenant and global budgets, settle the cost to both in one transaction, return unused tokens, and write the request and attempt telemetry. Provider calls and HTTP are not included.',
    '',
    '| Scenario | Tenants | Requests | Requests/s | p50 | p95 | p99 | Failed |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...scenarios.map(s => `| ${s.name} | ${s.tenants} | ${s.processed} | ${Math.round(s.tps)} | ${ms(s.p50)} | ${ms(s.p95)} | ${ms(s.p99)} | ${s.failed} |`),
    '',
    `After each scenario, every request was charged, counted and logged exactly once: tenant spend (and global spend, where it is updated) equals requests × $${COST}, rate-limit windows hold every request and token, and there is one telemetry row per request and attempt.`,
    '',
    'The diagnostic scenario is not a gateway path. It does the same work but skips the global month and model rows that every request updates, to show how much those shared rows cost.',
    '',
    `Rate limiting: ${limited.processed} attempts against a ${RPM_LIMIT}-per-minute limit admitted ${admitted}, and no one-minute window went over the limit.`,
    '',
  ];
  const markdown = lines.join('\n');
  mkdirSync('load-test/results', { recursive: true });
  const stem = `load-test/results/${new Date().toISOString().replace(/[:.]/g, '-')}`;
  writeFileSync(`${stem}.md`, markdown);
  writeFileSync(`${stem}.json`, `${JSON.stringify({ postgres: version, cores: cpus().length, clients: CLIENTS, threads: THREADS, seconds: SECONDS, scenarios, rate_limit: { ...limited, limit: RPM_LIMIT, admitted } }, null, 2)}\n`);
  console.log(`${markdown}\nWrote ${stem}.md and ${stem}.json`);
} finally {
  rmSync(dir, { recursive: true, force: true });
  await sql(`DROP DATABASE IF EXISTS ${dbName}`, server.toString());
}
