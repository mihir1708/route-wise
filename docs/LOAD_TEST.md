# Load test

## Running it: `npm run load-test`

`scripts/load-test.mjs` measures the Postgres side of a gateway request with
pgbench. One transaction is the database work of one `/api/generate` call with
the cache off, as separate round trips: take the rate limit, read the tenant and
global budgets, settle the cost, return unused tokens, and write request and
attempt telemetry. It needs `psql` and `pgbench` and a disposable server, the same
opt-in as `npm run test:postgres`. It creates its own database, checks that every
request was charged, counted and logged exactly once, then drops it.

```sh
ROUTEWISE_DB_TEST_DISPOSABLE=1 ROUTEWISE_TEST_DATABASE_URL=postgresql://... npm run load-test -- --clients 32 --seconds 20
```

Results from a 4-core machine running Postgres 16 and pgbench together, 32
concurrent clients, 20 s per scenario (one file per run in `load-test/results/`):

| Scenario | Before migration 011 | After migration 011 |
| --- | --- | --- |
| 64 tenants | 615 requests/s, p95 115 ms | 1,369 requests/s, p95 32 ms |
| 1 tenant | 468 requests/s, p95 158 ms | 452 requests/s, p95 164 ms |
| 64 tenants, no global row (diagnostic) | 1,423 requests/s, p95 32 ms | 1,505 requests/s, p95 30 ms |

The first run found the bottleneck. Every settled request updated the same global
month row and model row, so requests from all tenants queued on those row locks;
mid-run, 25 of 32 sessions were waiting on a row lock. Migration 011 spreads that
spend over 16 shard rows per month and adds them back up on read, so totals stay
exact. Across 64 tenants, throughput more than doubled and p95 fell from 115 ms to
32 ms, within 10% of the diagnostic ceiling that skips global accounting entirely
(not a real gateway path). One tenant's requests still queue on that tenant's own
usage and rate-limit rows, which is what keeps its limits exact.

No request was lost or double-counted in any run, and the rate limiter admitted
exactly 100 of 438,909 attempts against a 100-per-minute limit. These numbers
leave out HTTP, the Supabase API and provider calls, which take far longer than
the database work.
