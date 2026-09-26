import { expect, it, vi } from 'vitest';
import data from '@/eval/datasets/starter-v1.json';
import { validateDataset } from '@/eval/schema';
import { scoreDeterministic, validateJudge, validShape } from '@/eval/scoring';
import { judgeCase } from '@/eval/judge';
const cases = validateDataset(data).cases;
it('scores classification and respects exact line structure', () => {
  expect(scoreDeterministic(cases[2],' Positive ').quality).toBe(1);
  expect(scoreDeterministic(cases[1],'alpha beta').quality).toBe(0);
});
it('scores extraction without losing false/zero', () => {
  expect(scoreDeterministic(cases[11],'{"count":0,"active":false}').quality).toBe(1);
  expect(scoreDeterministic(cases[11],'{"count":0}').quality).toBe(0.5);
});
it('validates structured types, values and additional keys', () => {
  expect(scoreDeterministic(cases[9],'{"name":"Ada","age":36}').quality).toBe(1);
  expect(scoreDeterministic(cases[9],'{"name":"Ada","age":"36"}').quality).toBe(0);
  expect(scoreDeterministic(cases[9],'not JSON').quality).toBe(0);
  expect(validShape({ x: 1 },{ type: 'object', additionalProperties: false })).toBe(false);
});
it('leaves unsupported code and rubric cases unscored', () => {
  expect(scoreDeterministic(cases[5],'arbitrary code').quality).toBeNull();
  expect(scoreDeterministic(cases[4],'summary').status).toBe('needs_judge');
});
it.each([-1,2,NaN,'1'])('rejects invalid judge score %s', score => { expect(() => validateJudge({ score, reason: 'x' })).toThrow(); });
it('validates structured judge output', () => { expect(validateJudge({score:0.8,reason:'specific finding'}).score).toBe(0.8); });
it('judge is blocked without opt-in before constructing a client', async () => {
  vi.stubEnv('ROUTEWISE_LIVE_EVAL',''); await expect(judgeCase(cases[4],'text')).rejects.toThrow('requires'); vi.unstubAllEnvs();
});
