import { expect, it } from 'vitest';
import { reportRun, percentile, csvCell } from '@/eval/report';
import { runEvaluation } from '@/eval/runner';
import { validateDataset } from '@/eval/schema';
import data from '@/eval/datasets/starter-v1.json';
it('does not report invented metrics from dry runs', async () => {
  const run = await runEvaluation(validateDataset(data), {strategies:['low-only'],dryRun:true,call:async()=>{throw new Error('must not call');}});
  expect(reportRun(run)).toMatchObject({evidence:'no_live_measurements',strategies:[]});
});
it('uses nearest-rank percentiles with empty data unavailable', () => {
  expect(percentile([],0.95)).toBeNull(); expect(percentile([1,2,3,4,5],0.95)).toBe(5);
});
it('escapes CSV including formula injection', () => { expect(csvCell('=cmd')).toBe('"\'=cmd"'); expect(csvCell('a"b')).toBe('"a""b"'); });
it('computes metrics for explicit synthetic unit-test records and exposes missing cost',async()=>{
 const run=await runEvaluation(validateDataset(data),{strategies:['low-only'],limit:2,dryRun:true,call:async()=>{throw Error('no');}});
 run.mode='live';run.records.forEach((r,i)=>{r.status='completed';r.quality=i;r.estimated_cost=0.001;r.latency_ms=(i+1)*10;});
 const stats=reportRun(run).strategies[0];expect(stats.mean_quality).toBe(0.5);expect(stats.total_cost).toBe(0.002);expect(stats.projected_cost_per_1000).toBe(1);expect(stats.p95_latency_ms).toBe(20);
 run.records[0].estimated_cost=null;expect(reportRun(run).strategies[0].total_cost).toBeNull();
});
