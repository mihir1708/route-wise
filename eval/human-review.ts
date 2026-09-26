import { createHash } from 'node:crypto';
import type { EvalRun } from './runner';
import type { Dataset } from './schema';
export interface HumanReview {
  eval_run_id: string; eval_case_id: string; strategy: string; prompt: string; response: string;
  automated_score: number | null; human_score: number | null; human_notes: string;
  reviewer: string; reviewed_at: string;
}
export function exportReview(run: EvalRun, dataset: Dataset, limit = 20): HumanReview[] {
  if (run.dataset_version !== dataset.version) throw new Error('Dataset mismatch');
  if (!Number.isInteger(limit) || limit < 1) throw new Error('Invalid sample limit');
  return run.records.filter(r => r.status === 'completed' && r.response !== null)
    .map(r => ({ r, hash: createHash('sha256').update(`${run.run_id}:${r.eval_case_id}:${r.strategy}`).digest('hex') }))
    .sort((a,b) => a.hash.localeCompare(b.hash)).slice(0,limit).map(({r}) => ({
      eval_run_id: run.run_id, eval_case_id: r.eval_case_id, strategy: r.strategy,
      prompt: dataset.cases.find(c => c.id === r.eval_case_id)?.prompt ?? '', response: r.response!,
      automated_score: r.quality, human_score: null, human_notes: '', reviewer: '', reviewed_at: '',
    }));
}
export function compareHuman(rows: HumanReview[]) {
  const seen = new Set<string>();
  const compared: { eval_case_id: string; strategy: string; automated_score: number; human_score: number; absolute_disagreement: number }[] = [];
  for (const row of rows) {
    const key = `${row.eval_run_id}:${row.eval_case_id}:${row.strategy}`;
    if (seen.has(key)) throw new Error('Duplicate human review'); seen.add(key);
    if (row.human_score === null) continue;
    if (!Number.isFinite(row.human_score) || row.human_score < 0 || row.human_score > 1 || !row.reviewer?.trim() || !Number.isFinite(Date.parse(row.reviewed_at))) throw new Error('Invalid human review or missing provenance');
    if (row.automated_score === null) continue;
    if (!Number.isFinite(row.automated_score) || row.automated_score < 0 || row.automated_score > 1) throw new Error('Invalid automated score');
    compared.push({ eval_case_id: row.eval_case_id, strategy: row.strategy, automated_score: row.automated_score, human_score: row.human_score, absolute_disagreement: Math.abs(row.automated_score-row.human_score) });
  }
  return { compared, sample_count: rows.length, paired_count: compared.length,
    mean_absolute_disagreement: compared.length ? compared.reduce((s,r) => s+r.absolute_disagreement,0)/compared.length : null,
    within_0_1_fraction: compared.length ? compared.filter(r => r.absolute_disagreement <= 0.1).length/compared.length : null,
  };
}
