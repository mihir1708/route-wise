import type { EvalRun } from './runner';
import { reportRun } from './report';
const delta = (a: number | null,b: number | null) => a === null || b === null ? null : b-a;
export function compareRuns(before: EvalRun, after: EvalRun) {
  if (before.dataset_version !== after.dataset_version) throw new Error('Compare the same dataset version');
  if (before.mode !== 'live' || after.mode !== 'live') return { evidence:'no_paired_live_runs',strategies:[] };
  const keys = (run: EvalRun) => run.records.map(r=>`${r.strategy}:${r.eval_case_id}`).sort().join('\n');
  if (keys(before) !== keys(after)) throw new Error('Runs must contain identical case/strategy sets');
  const a=reportRun(before); const b=reportRun(after);
  return { evidence:'paired_live_runs',before:before.run_id,after:after.run_id,
    configuration_changed:JSON.stringify(before.runtime_models)!==JSON.stringify(after.runtime_models),
    strategies:a.strategies.map(old=>{
      const next=b.strategies.find(r=>r.strategy===old.strategy)!;
      const scored = (run:EvalRun) => run.records.filter(r=>r.strategy===old.strategy && r.quality!==null).map(r=>r.eval_case_id).sort().join('\n');
      const comparableQuality = scored(before) === scored(after);
      const distribution: Record<string,number> = {};
      for (const key of new Set([...Object.keys(old.model_tier_distribution),...Object.keys(next.model_tier_distribution)])) distribution[key]=(next.model_tier_distribution[key]??0)-(old.model_tier_distribution[key]??0);
      const gaps = (run:EvalRun) => {
        const rows=run.records.filter(r=>r.strategy===old.strategy && r.quality!==null);
        const paired=rows.flatMap(r=>{const high=run.records.find(h=>h.strategy==='high-only'&&h.eval_case_id===r.eval_case_id&&h.quality!==null);return high?[Number(high.quality!>r.quality!)]:[];});
        return paired.length===rows.length && paired.length ? paired.reduce((s,n)=>s+n,0)/paired.length : null;
      };
      return {strategy:old.strategy,quality_delta:comparableQuality?delta(old.mean_quality,next.mean_quality):null,
        cost_delta:delta(old.total_cost,next.total_cost),p50_latency_delta:delta(old.p50_latency_ms,next.p50_latency_ms),
        p95_latency_delta:delta(old.p95_latency_ms,next.p95_latency_ms),routing_failure_delta:comparableQuality?delta(gaps(before),gaps(after)):null,
        model_distribution_delta:distribution,comparable_quality_coverage:comparableQuality};
    }) };
}
export interface AcceptedBaseline { run_id: string; accepted_by: string; accepted_at: string; max_quality_drop: number; max_cost_increase_fraction: number }
export function regressionGate(before: EvalRun, after: EvalRun, baseline: AcceptedBaseline) {
  if (baseline.run_id!==before.run_id || !baseline.accepted_by?.trim() || !Number.isFinite(Date.parse(baseline.accepted_at)) ||
    ![baseline.max_quality_drop,baseline.max_cost_increase_fraction].every(n=>Number.isFinite(n)&&n>=0)) throw new Error('Explicit accepted baseline and thresholds required');
  const comparison=compareRuns(before,after);
  if (comparison.evidence!=='paired_live_runs' || !comparison.strategies.length) throw new Error('Measured runs required for benchmark gate');
  const failures:string[]=[]; const prior=reportRun(before);
  for (const row of comparison.strategies) {
    const cost=prior.strategies.find(s=>s.strategy===row.strategy)!.total_cost;
    if (row.quality_delta===null || row.cost_delta===null || cost===null) failures.push(`${row.strategy}: incomplete evidence`);
    else {
      if(row.quality_delta < -baseline.max_quality_drop) failures.push(`${row.strategy}: quality regression`);
      if(row.cost_delta > cost*baseline.max_cost_increase_fraction) failures.push(`${row.strategy}: cost regression`);
    }
  }
  return {passed:failures.length===0,failures,comparison};
}
