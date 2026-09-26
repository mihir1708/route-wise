import { expect,it } from 'vitest';
import { compareRuns,regressionGate } from '@/eval/compare';
import { runEvaluation } from '@/eval/runner';
import { validateDataset } from '@/eval/schema';
import data from '@/eval/datasets/starter-v1.json';
it('refuses a fabricated benchmark gate from a dry run',async()=>{
 const run=await runEvaluation(validateDataset(data),{strategies:['low-only'],dryRun:true,call:async()=>{throw Error('no');}});
 expect(compareRuns(run,run).evidence).toBe('no_paired_live_runs');
 expect(()=>regressionGate(run,run,{run_id:run.run_id,accepted_by:'unit fixture',accepted_at:'2026-01-01',max_quality_drop:0,max_cost_increase_fraction:0})).toThrow('Measured');
});
it('detects a configured quality/cost regression on synthetic unit-test records',async()=>{
 const run=await runEvaluation(validateDataset(data),{strategies:['low-only'],limit:1,dryRun:true,call:async()=>{throw Error('no');}});
 run.mode='live';run.records[0]={...run.records[0],status:'completed',quality:1,estimated_cost:0.001,latency_ms:10};
 const next=structuredClone(run);next.records[0].quality=0.5;next.records[0].estimated_cost=0.002;
 const result=regressionGate(run,next,{run_id:run.run_id,accepted_by:'synthetic unit fixture',accepted_at:'2026-01-01',max_quality_drop:0.1,max_cost_increase_fraction:0.1});
 expect(result.passed).toBe(false);expect(result.failures).toHaveLength(2);
});
