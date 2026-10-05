// Optional real PostgreSQL verification. Requires a disposable, EMPTY database.
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
if (process.env.ROUTEWISE_DB_TEST_DISPOSABLE !== '1' || !process.env.ROUTEWISE_TEST_DATABASE_URL) throw new Error('Explicit disposable database opt-in required');
function sql(text, connectionString = process.env.ROUTEWISE_TEST_DATABASE_URL) {
  return new Promise((resolve,reject)=>{
    const container=process.env.ROUTEWISE_TEST_CONTAINER;
    const args=['-X','-d',connectionString,'-v','ON_ERROR_STOP=1','-q'];
    const child=spawn(container?'docker':'psql',container?['exec','-i',container,'psql',...args]:args,{env:process.env,stdio:['pipe','pipe','pipe']});
    let error='';child.stderr.on('data',chunk=>error+=chunk);child.stdout.resume();child.on('error',reject);
    child.on('close',code=>code===0?resolve():reject(new Error(error)));child.stdin.end(text);
  });
}
await sql(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
DO $$ BEGIN
  IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
  IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role BYPASSRLS; END IF;
END $$;`);
const bootstrap=readFileSync('supabase-schema.sql','utf8');
const legacy=bootstrap.split('-- T03')[0];
// Bootstrap's appended functions start at migration 002's BEGIN block.
const migration002=readFileSync('migrations/002_atomic_accounting.sql','utf8');
const base=legacy.slice(0,legacy.indexOf(migration002)).replace('total_cost DECIMAL(14,6)','total_cost DECIMAL(10,2)');
if (!base.includes('CREATE TABLE IF NOT EXISTS budget_tracking')) throw new Error('Cannot identify bootstrap base');
await sql(base+"\nINSERT INTO budget_tracking(month,total_cost,budget_limit) VALUES('2099-02',12.34,321);");
for (const file of readdirSync('migrations').filter(f=>/^\d+_.+\.sql$/.test(f)).sort()) await sql(readFileSync(`migrations/${file}`,'utf8'));
await sql(readFileSync('migrations/verify_001_budget_total_cost_precision.sql','utf8'));
await Promise.all(Array.from({length:10},()=>sql("SELECT public.increment_budget_usage('2099-01',0.001,'gpt-3.5-turbo',321,'low') FROM generate_series(1,10);")));
await sql(`DO $$ BEGIN
 IF NOT EXISTS(SELECT FROM budget_tracking WHERE month='2099-01' AND total_cost=0.1 AND total_requests=100 AND budget_limit=321) THEN RAISE EXCEPTION 'Concurrent increments lost'; END IF;
 IF NOT EXISTS(SELECT FROM model_usage WHERE month='2099-01' AND total_cost=0.1 AND total_requests=100) THEN RAISE EXCEPTION 'Model increments lost'; END IF;
 IF NOT EXISTS(SELECT FROM budget_tracking WHERE month='2099-02' AND total_cost=12.34 AND budget_limit=321) THEN RAISE EXCEPTION 'Migration changed balance'; END IF;
 PERFORM ensure_budget_month('2099-02',999);
 IF NOT EXISTS(SELECT FROM budget_tracking WHERE month='2099-02' AND budget_limit=321) THEN RAISE EXCEPTION 'Limit overwritten'; END IF;
END $$;`);
await sql(readFileSync('tests/sql/v2-integration.sql','utf8'));
await sql(readFileSync('tests/sql/gateway-integration.sql','utf8'));
await sql(readFileSync('tests/sql/reliability-integration.sql','utf8'));
// Concurrent tenants: 30 parallel requests against a 10 RPM limit admit exactly 10.
await sql(`INSERT INTO tenants(id,name,monthly_budget,rpm_limit,tpm_limit) VALUES ('00000000-0000-4000-8000-0000000000b1','concurrency',5,10,100000);`);
await Promise.all(Array.from({length:30},()=>sql("SELECT public.take_rate_limit('00000000-0000-4000-8000-0000000000b1',10);")));
await Promise.all(Array.from({length:10},()=>sql("SELECT public.settle_request('00000000-0000-4000-8000-0000000000b1','2099-05',0.001,'fixture-model',321,'low') FROM generate_series(1,10);")));
await sql(`DO $$ BEGIN
 IF (SELECT sum(requests) FROM rate_limit_windows WHERE tenant_id='00000000-0000-4000-8000-0000000000b1') NOT BETWEEN 10 AND 20 THEN RAISE EXCEPTION 'Concurrent rate limit admitted too many'; END IF;
 IF NOT EXISTS(SELECT FROM rate_limit_windows WHERE tenant_id='00000000-0000-4000-8000-0000000000b1' AND requests=10) THEN RAISE EXCEPTION 'Rate limit window did not fill to its limit'; END IF;
 IF NOT EXISTS(SELECT FROM tenant_usage WHERE tenant_id='00000000-0000-4000-8000-0000000000b1' AND month='2099-05' AND total_cost=0.1 AND total_requests=100) THEN RAISE EXCEPTION 'Concurrent tenant charges lost'; END IF;
 IF NOT EXISTS(SELECT FROM budget_tracking WHERE month='2099-05' AND total_cost=0.1 AND total_requests=100) THEN RAISE EXCEPTION 'Concurrent global charges lost'; END IF;
END $$;`);
const freshName=`routewise_bootstrap_${Date.now()}`;
await sql(`CREATE DATABASE ${freshName}`);
const fresh=new URL(process.env.ROUTEWISE_TEST_DATABASE_URL);fresh.pathname=`/${freshName}`;
await sql('CREATE EXTENSION IF NOT EXISTS "uuid-ossp";'+bootstrap,fresh.toString());
await sql(readFileSync('tests/sql/v2-integration.sql','utf8'),fresh.toString());
await sql(readFileSync('tests/sql/gateway-integration.sql','utf8'),fresh.toString());
await sql(readFileSync('tests/sql/reliability-integration.sql','utf8'),fresh.toString());
console.log('Real PostgreSQL migrations, precision, concurrent increments, fresh bootstrap, access, analytics, job claims, retention, tenant budgets, rate limits, response cache and attempts passed');
