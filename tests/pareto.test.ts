import { expect,it } from 'vitest';
import { paretoData,paretoSvg } from '@/eval/pareto';
import { runEvaluation } from '@/eval/runner';
import { validateDataset } from '@/eval/schema';
import data from '@/eval/datasets/starter-v1.json';
it('does not plot fake dry-run points',async()=>{
 const run=await runEvaluation(validateDataset(data),{strategies:['low-only','high-only'],dryRun:true,call:async()=>{throw Error('no');}});
 const points=paretoData(run);expect(points.points).toEqual([]);expect(paretoSvg(points)).toBeNull();
});
it('computes ratios and frontier only for complete paired synthetic unit records',async()=>{
 const run=await runEvaluation(validateDataset(data),{strategies:['low-only','high-only'],limit:1,dryRun:true,call:async()=>{throw Error('no');}});
 run.mode='live';run.records.forEach(r=>{r.status='completed';r.quality=1;r.estimated_cost=r.strategy==='low-only'?0.001:0.01;});
 const points=paretoData(run).points;expect(points[0].quality_parity).toBe(1);expect(points[0].cost_reduction).toBeCloseTo(0.9);expect(points[1].pareto_optimal).toBe(false);
 run.records[0].quality=null;expect(paretoData(run).points).toHaveLength(1);
});
