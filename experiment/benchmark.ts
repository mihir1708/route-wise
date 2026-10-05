// The routing experiment's benchmark: support tickets with an expected answer or a rubric each.
import { createHash } from 'node:crypto';
import { MAX_INPUT_CHARS, type Priority } from '@/lib/request-run';
import type { JsonSchema } from '@/lib/output-validation';
import { getPrompt, TASK_TYPES, type TaskType } from '@/prompts';

export const TASK_CLASSES = ['simple', 'standard', 'complex'] as const;
export type TaskClass = typeof TASK_CLASSES[number];
export const ITEMS_PER_CLASS = 15;

/** One acceptable value, or a list of acceptable values (null means "not stated"). */
export type ExpectedValue = string | null | (string | null)[];

export interface BenchmarkItem {
  id: string;
  class: TaskClass;
  task_type: Exclude<TaskType, 'chat'>;
  priority: Priority;
  input: string;
  /** classify and extract: the expected value of every output field. */
  expected?: Record<string, ExpectedValue>;
  /** summarize, draft_reply and troubleshoot: what the judge checks the answer against. */
  rubric?: string[];
  /** Per-item limits; going over either one fails the item. */
  max_cost_usd: number;
  latency_target_ms: number;
  notes?: string;
  reviewed: boolean;
  reviewer?: string;
  reviewed_at?: string;
}

export interface Benchmark { version: string; description?: string; items: BenchmarkItem[] }

const STRUCTURED: readonly TaskType[] = ['classify', 'extract'];
export const isStructured = (item: Pick<BenchmarkItem, 'task_type'>) => STRUCTURED.includes(item.task_type);

/** SHA-256 of the benchmark file's exact bytes; the pre-registration pins it. */
export function benchmarkHash(raw: string | Buffer): string {
  return createHash('sha256').update(raw).digest('hex');
}

function checkExpected(item: BenchmarkItem): void {
  const schema = getPrompt(item.task_type)?.schema;
  if (!schema || schema.type !== 'object') throw new Error(`${item.id}: task has no output schema`);
  const expected = item.expected;
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) throw new Error(`${item.id}: expected values required`);
  const keys = Object.keys(expected).sort();
  if (keys.join() !== [...schema.required].sort().join()) throw new Error(`${item.id}: expected must have exactly ${schema.required.join(', ')}`);
  for (const key of keys) {
    const values = Array.isArray(expected[key]) ? expected[key] as (string | null)[] : [expected[key] as string | null];
    const field = schema.properties[key] as Exclude<JsonSchema, { type: 'object' }>;
    if (!values.length || values.some(v => v !== null && (typeof v !== 'string' || !v.trim()))) throw new Error(`${item.id}: invalid expected ${key}`);
    if (field.enum && values.some(v => !field.enum!.includes(v))) throw new Error(`${item.id}: expected ${key} is not an allowed value`);
    const types = Array.isArray(field.type) ? field.type : [field.type];
    if (values.some(v => !types.includes(v === null ? 'null' : 'string'))) throw new Error(`${item.id}: expected ${key} has the wrong type`);
  }
}

export function validateBenchmark(value: unknown): Benchmark {
  const b = value as Benchmark;
  if (!b || typeof b.version !== 'string' || !b.version.trim() || !Array.isArray(b.items)) throw new Error('Invalid benchmark');
  const ids = new Set<string>();
  for (const item of b.items) {
    if (!item || typeof item.id !== 'string' || !/^[a-z]+-\d{2}$/.test(item.id) || ids.has(item.id)) throw new Error(`Invalid or duplicate id: ${item?.id}`);
    ids.add(item.id);
    if (!TASK_CLASSES.includes(item.class)) throw new Error(`${item.id}: invalid class`);
    if (!TASK_TYPES.includes(item.task_type) || (item.task_type as TaskType) === 'chat') throw new Error(`${item.id}: invalid task type`);
    if (!['low', 'normal', 'high'].includes(item.priority)) throw new Error(`${item.id}: invalid priority`);
    if (typeof item.input !== 'string' || !item.input.trim() || item.input.length > MAX_INPUT_CHARS) throw new Error(`${item.id}: invalid input`);
    if (!(typeof item.max_cost_usd === 'number' && item.max_cost_usd > 0 && item.max_cost_usd <= 10)) throw new Error(`${item.id}: invalid max_cost_usd`);
    if (!(Number.isSafeInteger(item.latency_target_ms) && item.latency_target_ms >= 500 && item.latency_target_ms <= 120000)) throw new Error(`${item.id}: invalid latency_target_ms`);
    if (isStructured(item)) {
      checkExpected(item);
      if (item.rubric !== undefined) throw new Error(`${item.id}: structured items are scored by exact match, not a rubric`);
    } else {
      if (!Array.isArray(item.rubric) || !item.rubric.length || item.rubric.some(r => typeof r !== 'string' || !r.trim())) throw new Error(`${item.id}: rubric required`);
      if (item.expected !== undefined) throw new Error(`${item.id}: text items are scored by rubric, not expected values`);
    }
    if (typeof item.reviewed !== 'boolean') throw new Error(`${item.id}: reviewed must be true or false`);
    if (item.reviewed && (!item.reviewer?.trim() || !item.reviewed_at || !Number.isFinite(Date.parse(item.reviewed_at)))) {
      throw new Error(`${item.id}: a reviewed item needs reviewer and reviewed_at`);
    }
  }
  for (const cls of TASK_CLASSES) {
    const n = b.items.filter(i => i.class === cls).length;
    if (n !== ITEMS_PER_CLASS) throw new Error(`Expected ${ITEMS_PER_CLASS} ${cls} items, found ${n}`);
  }
  return b;
}
