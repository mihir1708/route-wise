import { expect, it } from 'vitest';
import { analyzeFailures } from '@/eval/failures';
import { runEvaluation } from '@/eval/runner';
import { validateDataset } from '@/eval/schema';
import data from '@/eval/datasets/starter-v1.json';
it('does not invent failure categories for unmeasured cases', async () => {
  const ds = validateDataset(data); const run = await runEvaluation(ds,{ strategies:['heuristic-v1','high-only'],dryRun:true,call:async()=>{throw new Error('no');} });
  expect(analyzeFailures(run,ds).cases).toEqual([]);
});
it('uses only positive paired quality gaps (synthetic unit-test records)', async () => {
  const ds = validateDataset(data); const run = await runEvaluation(ds,{ strategies:['heuristic-v1','high-only'],limit:1,dryRun:true,call:async()=>{throw new Error('no');} });
  run.mode = 'live'; run.records.forEach(r => { r.status='completed'; r.quality = r.strategy==='high-only' ? 1 : 0.5; });
  expect(analyzeFailures(run,ds).cases[0].quality_gap).toBe(0.5);
  run.records[0].quality=1; expect(analyzeFailures(run,ds).cases).toEqual([]);
});
