import { expect, it } from 'vitest';
import { routingFeatures, createHeuristicV2, type V2Config } from '@/lib/heuristic-v2';
const config: V2Config = { version:'heuristic-v2-unit-fixture',evidenceRunId:'unit-fixture',rationale:'Synthetic unit test, not a tuned production policy',bias:0.2,weights:{length:0,constraints:0,multipart:0,code:0.7,structured:0,reasoning:0},highThreshold:0.8,midThreshold:0.5 };
it('extracts structural features without a short-prompt early exit', () => {
  expect(routingFeatures('Prove x')).toMatchObject({reasoning:1});
  expect(routingFeatures('```js\nfunction add(a,b) { return a+b; }\n```')).toMatchObject({code:1});
  expect(routingFeatures('Return exactly JSON only')).toMatchObject({structured:1,constraints:0.4});
});
it('refuses activation without measured evidence', () => { expect(() => createHeuristicV2(config,{run_id:'x',evidence:'no_live_measurements',cases:[]})).toThrow('requires'); });
it('is deterministic and explains features with supplied unit-test evidence', async () => {
  const policy = createHeuristicV2(config,{run_id:'unit-fixture',evidence:'paired_live_scores',cases:[{synthetic_unit_fixture:true}]});
  const first = await policy.route('function add(a,b) {}',{budgetPercentage:0});
  expect(first).toEqual(await policy.route('function add(a,b) {}',{budgetPercentage:0}));
  expect(first.tier).toBe('high'); expect(first.reasons.some(r=>r.includes('code=1'))).toBe(true);
});
