// The pre-registered run the admin dashboard shows as its quality baseline. A test checks these
// figures against the committed results file, so they cannot drift from what was measured.
export const PUBLISHED_RUN = {
  file: 'experiment/results/2026-10-05T15-50-49-953Z-preregistered.json',
  date: '2026-10-05',
  benchmark: 'support-v1',
  items: 45,
  runs: 2,
  barPassed: false,
  configs: [
    { config: 'all-premium', successRate: 0.8444, costPerSuccessUsd: 0.013220 },
    { config: 'routed', successRate: 0.8111, costPerSuccessUsd: 0.007146 },
    { config: 'all-small', successRate: 0.8111, costPerSuccessUsd: 0.000411 },
  ],
} as const;
