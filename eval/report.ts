import type { EvalRecord, EvalRun } from './runner';
const mean = (values: number[]) => values.length ? values.reduce((a,b) => a+b,0)/values.length : null;
export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a,b) => a-b); return sorted[Math.max(0,Math.ceil(p*sorted.length)-1)];
}
function groups(rows: EvalRecord[], key: 'task_type' | 'intended_difficulty') {
  return Object.fromEntries([...new Set(rows.map(r => r[key]))].map(name => {
    const group = rows.filter(r => r[key] === name); const scores = group.flatMap(r => r.quality === null ? [] : [r.quality]);
    return [name, { mean_quality: mean(scores), scored: scores.length, total: group.length }];
  }));
}
export function reportRun(run: EvalRun) {
  if (run.mode !== 'live') return { run_id: run.run_id, evidence: 'no_live_measurements', strategies: [] };
  const strategies = [...new Set(run.records.map(r => r.strategy))].map(strategy => {
    const rows = run.records.filter(r => r.strategy === strategy);
    const scores = rows.flatMap(r => r.quality === null ? [] : [r.quality]);
    const costs = rows.flatMap(r => r.estimated_cost === null ? [] : [r.estimated_cost]);
    const cost = costs.length === rows.length ? costs.reduce((a,b) => a+b,0) : null;
    const latency = rows.flatMap(r => r.latency_ms === null ? [] : [r.latency_ms]);
    const distribution: Record<string,number> = {};
    rows.forEach(r => { const key = `${r.selected_tier}:${r.selected_model}`; distribution[key] = (distribution[key] ?? 0)+1; });
    return { strategy, requests: rows.length, completed: rows.filter(r => r.status === 'completed').length,
      mean_quality: mean(scores), scored_requests: scores.length, quality_by_task: groups(rows,'task_type'),
      quality_by_difficulty: groups(rows,'intended_difficulty'), total_cost: cost,
      known_cost: costs.reduce((a,b) => a+b,0), unknown_cost_requests: rows.length-costs.length,
      average_cost: cost === null ? null : cost/rows.length,
      projected_cost_per_1000: cost === null ? null : cost/rows.length*1000,
      p50_latency_ms: percentile(latency,0.5), p95_latency_ms: percentile(latency,0.95), model_tier_distribution: distribution,
      judge_cost: rows.reduce((s,r) => s+(r.judge?.cost ?? 0),0), judge_unknown_cost_requests: rows.filter(r => r.judge?.cost === null || r.scoring_status === 'judge_unavailable').length,
    };
  });
  return { run_id: run.run_id, evidence: 'live_run', strategies };
}
export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`; // spreadsheet formula injection
  return `"${text.replace(/"/g,'""')}"`;
}
export function reportArtifacts(run: EvalRun) {
  const report = reportRun(run);
  const fields = ['strategy','requests','completed','mean_quality','scored_requests','total_cost','average_cost','projected_cost_per_1000','p50_latency_ms','p95_latency_ms'] as const;
  const csv = [fields.map(csvCell).join(','), ...report.strategies.map(row => fields.map(k => csvCell(row[k])).join(','))].join('\n')+'\n';
  const md = [`# Evaluation ${run.run_id}`, '', `Evidence: ${report.evidence}. Dataset: ${run.dataset_version}. Reviewed cases: ${run.reviewed_cases}.`,
    'Quality is the mean of scored cases only; compare coverage before comparing strategies. Cost excludes separately reported judge spend. Latencies include failed attempts. No confidence or superiority claim is implied.',
    ...report.strategies.flatMap(r => ['', `## ${r.strategy}`, ...fields.slice(1).map(k => `- ${k}: ${r[k] ?? 'unavailable'}`),
      `- quality_by_task: ${JSON.stringify(r.quality_by_task)}`, `- quality_by_difficulty: ${JSON.stringify(r.quality_by_difficulty)}`,
      `- model_tier_distribution: ${JSON.stringify(r.model_tier_distribution)}`, `- judge_cost: ${r.judge_cost}`, `- unknown_cost_requests: ${r.unknown_cost_requests}`]),
  ].join('\n')+'\n';
  return { report, csv, md };
}
