import { expect, it } from 'vitest';
import fixtures from '@/eval/fixtures/ci-v1.json';
import data from '@/eval/datasets/starter-v1.json';
import { validateDataset } from '@/eval/schema';
import { heuristicV1 } from '@/lib/routing-policy';
import { LEGACY_MODELS } from '@/lib/model-registry';
import { scoreDeterministic } from '@/eval/scoring';
it.each(fixtures.cases)('routing fixture $id',async c=>{
  const result = await heuristicV1.route(c.prompt,{budgetPercentage:c.budget,models:LEGACY_MODELS});
  expect(result.difficulty).toBe(c.difficulty); expect(result.model).toBe(c.model);
});
it.each(fixtures.scoring_fixtures)('scoring fixture $case_id: $response',c=>{
  const testCase = validateDataset(data).cases.find(x=>x.id===c.case_id)!;
  expect(scoreDeterministic(testCase,c.response).quality).toBe(c.score);
});
