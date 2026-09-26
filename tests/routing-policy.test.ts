import { expect, it } from 'vitest';
import { heuristicV1 } from '@/lib/routing-policy';
import { estimateDifficulty, selectModel } from '@/lib/difficulty-estimator';
import { LEGACY_MODELS } from '@/lib/model-registry';
it.each(['hello', 'hello?', 'calculate zz zz zz?', 'explain zz zz zz?', 'x '.repeat(150), 'zz zz and zz?'])(
  'versioned v1 matches the legacy router for %s at every boundary', async query => {
    for (const budget of [0,79.999,80,85,89.999,90,100]) {
      const difficulty = await estimateDifficulty(query);
      const decision = await heuristicV1.route(query, { budgetPercentage: budget, models: LEGACY_MODELS });
      expect(decision.model).toBe(selectModel(difficulty,budget));
      expect(decision.difficulty).toBe(difficulty); expect(decision.policyVersion).toBe('heuristic-v1'); expect(decision.reasons.length).toBeGreaterThan(0);
    }
  },
);
