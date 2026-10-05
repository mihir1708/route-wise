export const TASK_TYPES = ['extraction','formatting','classification','factual_qa','summarization','coding','reasoning','comparison','multi_constraint','structured_output'] as const;
export type TaskType = typeof TASK_TYPES[number];
export type ScoringMethod = 'exact' | 'fields' | 'json' | 'format' | 'fixture' | 'rubric';
export interface JsonShape {
  type: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
  required?: string[]; properties?: Record<string, JsonShape>; items?: JsonShape;
  additionalProperties?: boolean; enum?: unknown[];
}
export interface EvalCase {
  id: string; prompt: string; task_type: TaskType; intended_difficulty: 'low' | 'mid' | 'high';
  scoring_method: ScoringMethod; reference_answer?: unknown;
  expected_properties?: { lines?: number; contains?: string[]; schema?: JsonShape; fixture?: string };
  rubric?: string; reviewed: boolean; source?: string; notes?: string;
  reviewer?: string; reviewed_at?: string;
}
export interface Dataset { version: string; cases: EvalCase[] }
export function validateDataset(value: unknown): Dataset {
  const data = value as Dataset;
  if (!data || typeof data.version !== 'string' || !data.version.trim() || !Array.isArray(data.cases) || !data.cases.length) throw new Error('Invalid dataset');
  const ids = new Set<string>();
  for (const c of data.cases) {
    if (!c || typeof c.id !== 'string' || !c.id || ids.has(c.id) || typeof c.prompt !== 'string' || !c.prompt.trim() ||
      !TASK_TYPES.includes(c.task_type) || !['low','mid','high'].includes(c.intended_difficulty) ||
      !['exact','fields','json','format','fixture','rubric'].includes(c.scoring_method) || typeof c.reviewed !== 'boolean') throw new Error('Invalid evaluation case');
    if (c.reviewed && (!c.reviewer?.trim() || !c.reviewed_at || !Number.isFinite(Date.parse(c.reviewed_at)))) throw new Error('Reviewed cases require human provenance');
    if (['exact','fields'].includes(c.scoring_method) && c.reference_answer === undefined) throw new Error('Reference required');
    if (c.scoring_method === 'rubric' && !c.rubric?.trim()) throw new Error('Rubric required');
    if (c.scoring_method === 'json' && !c.expected_properties?.schema) throw new Error('JSON schema required');
    if (c.scoring_method === 'format' && !c.expected_properties?.lines && !c.expected_properties?.contains?.length) throw new Error('Format properties required');
    if (c.scoring_method === 'fixture' && !c.expected_properties?.fixture) throw new Error('Named safe fixture required');
    ids.add(c.id);
  }
  return data;
}
