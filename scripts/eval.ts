import { createHeuristicV2 } from '../lib/heuristic-v2';
import { analyzeFailures } from '../eval/failures';
import { scoreRun } from '../eval/judge';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateDataset } from '../eval/schema';
import { runEvaluation, type Strategy } from '../eval/runner';
import { callModel } from '../lib/model-client';
const args = process.argv.slice(2);
const options: Record<string,string> = {};
for (let i = 0; i < args.length; i++) {
  const key = args[i];
  if (key === '--dry-run' || key === '--judge') { options[key] = 'true'; continue; }
  if (!['--dataset','--strategy','--limit','--out','--v2-config','--evidence-run'].includes(key) || !args[i+1]) throw new Error(`Invalid argument ${key}`);
  options[key] = args[++i];
}
const datasetName = options['--dataset'] ?? 'starter-v1';
const path = datasetName.endsWith('.json') ? resolve(datasetName) : resolve('eval/datasets', `${datasetName}.json`);
const dataset = validateDataset(JSON.parse(readFileSync(path, 'utf8')));
async function main() {
  const policyV2 = options['--v2-config'] ? createHeuristicV2(
    JSON.parse(readFileSync(options['--v2-config'],'utf8')),
    analyzeFailures(JSON.parse(readFileSync(options['--evidence-run'],'utf8')),dataset),
  ) : undefined;
  const run = await runEvaluation(dataset, {
    policyV2,
    strategies: (options['--strategy'] ?? 'low-only,high-only,heuristic-v1').split(',') as Strategy[],
    limit: Number(options['--limit'] ?? 20), dryRun: options['--dry-run'] === 'true', call: callModel,
  });
  await scoreRun(run, dataset, options['--judge'] === 'true');
  const out = resolve(options['--out'] ?? 'eval/runs'); mkdirSync(out, { recursive: true });
  const file = `${out}/${run.run_id}.json`; writeFileSync(file, JSON.stringify(run,null,2)+'\n');
  console.log(JSON.stringify({ file, mode: run.mode, records: run.records.length, reviewed_cases: run.reviewed_cases }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
