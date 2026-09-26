import type { EvalRun } from './runner';
import { reportRun } from './report';
export function paretoData(run: EvalRun) {
  const report=reportRun(run);
  const complete=report.strategies.filter(s=>s.requests>0 && s.completed===s.requests && s.scored_requests===s.requests && s.total_cost!==null && s.mean_quality!==null);
  const reference=complete.find(s=>s.strategy==='high-only');
  const keys=(strategy:string)=>run.records.filter(r=>r.strategy===strategy).map(r=>r.eval_case_id).sort().join('\n');
  const points=complete.filter(s=>reference && keys(s.strategy)===keys(reference.strategy)).map(s=>({
    strategy:s.strategy,cost:s.total_cost!,quality:s.mean_quality!,
    quality_parity:reference!.mean_quality!>0?s.mean_quality!/reference!.mean_quality!:null,
    cost_reduction:reference!.total_cost!>0?1-s.total_cost!/reference!.total_cost!:null,
  }));
  return {run_id:run.run_id,evidence:report.evidence,points:points.map(p=>({...p,
    pareto_optimal:!points.some(q=>q.cost<=p.cost && q.quality>=p.quality && (q.cost<p.cost || q.quality>p.quality)),
  })),note:'Requires complete paired scored cases including high-only. Ratios are descriptive, not proof of statistical parity.'};
}
const escape=(value:string)=>value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]!));
export function paretoSvg(data: ReturnType<typeof paretoData>): string | null {
  if(!data.points.length) return null;
  const max=Math.max(...data.points.map(p=>p.cost),0.000001);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500" viewBox="0 0 800 500"><rect width="800" height="500" fill="white"/><path d="M70 30V420H760" fill="none" stroke="black"/><text x="300" y="480">Total inference cost (USD)</text><text x="5" y="20">Quality (0–1)</text><text x="40" y="425">0</text><text x="40" y="45">1</text><text x="70" y="445">$0</text><text x="650" y="445">$${max.toFixed(6)}</text>${data.points.map(p=>{const x=70+p.cost/max*600;const y=420-p.quality*380;return `<circle cx="${x}" cy="${y}" r="6" fill="${p.pareto_optimal?'#2563eb':'#888'}"/><text x="${Math.min(x+10,620)}" y="${Math.max(y-10,20)}" font-size="12">${escape(p.strategy)}</text>`;}).join('')}</svg>`;
}
