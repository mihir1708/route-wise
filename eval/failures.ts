import type { EvalRun } from './runner';
import type { Dataset } from './schema';
export function analyzeFailures(run: EvalRun, dataset: Dataset) {
  if (run.dataset_version !== dataset.version) throw new Error('Dataset mismatch');
  if (run.mode !== 'live') return { run_id: run.run_id, evidence: 'no_live_measurements', cases: [] };
  const cases = run.records.filter(r => r.strategy.startsWith('heuristic-') && r.status === 'completed' && r.quality !== null).flatMap(r => {
    const high = run.records.find(h => h.eval_case_id === r.eval_case_id && h.strategy === 'high-only' && h.status === 'completed' && h.quality !== null);
    const c = dataset.cases.find(c => c.id === r.eval_case_id);
    if (!high || !c || high.quality! <= r.quality!) return [];
    const categories: string[] = [];
    // These are measured-case attributes, not proof of a causal explanation.
    if (c.prompt.length < 20) categories.push('short but difficult');
    if (c.task_type === 'coding') categories.push('coding misclassification candidate');
    if (c.task_type === 'multi_constraint') categories.push('multi-constraint under-routing candidate');
    if (['structured_output','formatting'].includes(c.task_type)) categories.push('formatting/structured-output mistake');
    return [{ eval_case_id: c.id, prompt: c.prompt, intended_difficulty: c.intended_difficulty,
      strategy: r.strategy, router_score: r.difficulty_score, selected_tier: r.selected_tier, selected_model: r.selected_model,
      high_tier_score: high.quality!, routed_model_score: r.quality!, quality_gap: high.quality!-r.quality!, route_reasons: r.route_reasons,
      categories, note: 'Likely failure based on paired scores; judge error and sampling variance remain possible.' }];
  });
  return { run_id: run.run_id, evidence: 'paired_live_scores', cases };
}
