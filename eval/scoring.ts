import { isDeepStrictEqual } from 'node:util';
import type { EvalCase, JsonShape } from './schema';
export interface Score { quality: number | null; status: string; reason: string }
const normalize = (v: unknown): unknown => typeof v === 'string' ? v.trim().toLowerCase().replace(/[\t ]+/g,' ').replace(/\r\n/g,'\n') : v;
function json(text: string): unknown { return JSON.parse(text); }
export function validShape(value: unknown, schema: JsonShape, depth = 0): boolean {
  if (!schema || depth > 32) return false;
  if (schema.enum && !schema.enum.some(item => isDeepStrictEqual(item,value))) return false;
  if (schema.type === 'null') return value === null;
  if (schema.type === 'array') return Array.isArray(value) && (!schema.items || value.every(v => validShape(v,schema.items!,depth+1)));
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const object = value as Record<string,unknown>;
    if (schema.required?.some(key => !Object.hasOwn(object,key))) return false;
    if (schema.additionalProperties === false && Object.keys(object).some(key => !Object.hasOwn(schema.properties ?? {},key))) return false;
    return Object.entries(schema.properties ?? {}).every(([key,shape]) => !Object.hasOwn(object,key) || validShape(object[key],shape,depth+1));
  }
  if (schema.type === 'integer') return Number.isSafeInteger(value);
  if (schema.type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === schema.type;
}
function fieldScore(actual: unknown, reference: unknown): number {
  if (!reference || typeof reference !== 'object' || Array.isArray(reference)) return Number(isDeepStrictEqual(normalize(actual),normalize(reference)));
  if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return 0;
  const entries = Object.entries(reference);
  if (!entries.length) return Number(isDeepStrictEqual(actual,reference));
  return entries.reduce((sum,[key,value]) => sum + Number(isDeepStrictEqual(normalize((actual as Record<string,unknown>)[key]),normalize(value))),0) / entries.length;
}
export function scoreDeterministic(c: EvalCase, response: string, fixtures: Record<string,(answer: string) => number> = {}): Score {
  try {
    let quality: number;
    switch (c.scoring_method) {
      case 'exact': quality = Number(isDeepStrictEqual(normalize(response),normalize(c.reference_answer))); break;
      case 'fields': quality = fieldScore(json(response),c.reference_answer); break;
      case 'json': {
        const answer = json(response);
        quality = validShape(answer,c.expected_properties!.schema!) ? (c.reference_answer === undefined ? 1 : fieldScore(answer,c.reference_answer)) : 0;
        break;
      }
      case 'format': {
        const checks: boolean[] = [];
        if (c.expected_properties?.lines !== undefined) checks.push(response.trim().split(/\r?\n/).length === c.expected_properties.lines);
        for (const fragment of c.expected_properties?.contains ?? []) checks.push(response.includes(fragment));
        quality = checks.length ? checks.filter(Boolean).length / checks.length : 0; break;
      }
      case 'fixture': {
        const fixture = fixtures[c.expected_properties!.fixture!];
        if (!fixture) return { quality: null, status: 'needs_safe_fixture', reason: 'No approved executable fixture; generated code is never eval-ed' };
        quality = fixture(response); break;
      }
      case 'rubric': return { quality: null, status: 'needs_judge', reason: 'Rubric scoring requires an explicitly opted-in judge' };
    }
    if (!Number.isFinite(quality) || quality < 0 || quality > 1) throw new Error('Invalid fixture score');
    return { quality, status: 'scored', reason: `deterministic:${c.scoring_method}` };
  } catch { return { quality: 0, status: 'scored', reason: 'invalid_output' }; }
}
export function validateJudge(value: unknown): { score: number; reason: string } {
  const v = value as { score: number; reason: string };
  if (!v || typeof v.score !== 'number' || !Number.isFinite(v.score) || v.score < 0 || v.score > 1 ||
    typeof v.reason !== 'string' || !v.reason.trim() || Object.keys(v).some(k => !['score','reason'].includes(k))) throw new Error('Invalid judge output');
  return v;
}
