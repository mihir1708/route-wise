import { expect, it } from 'vitest';
import { compareHuman, type HumanReview } from '@/eval/human-review';
const row: HumanReview = { eval_run_id:'test',eval_case_id:'test',strategy:'test',prompt:'',response:'',automated_score:0.8,human_score:null,human_notes:'',reviewer:'',reviewed_at:'' };
it('never treats an empty review as zero or completed', () => {
  expect(compareHuman([row])).toMatchObject({paired_count:0,mean_absolute_disagreement:null});
});
it('requires explicit human provenance', () => { expect(() => compareHuman([{...row,human_score:0.5}])).toThrow(); });
it('calculates disagreement for supplied test fixtures only', () => {
  const result = compareHuman([{...row,human_score:0.5,reviewer:'unit-test fixture',reviewed_at:'2026-01-01'}]);
  expect(result.mean_absolute_disagreement).toBeCloseTo(0.3);
});
