import { readFileSync } from 'node:fs';
import { analyzeFailures } from '../eval/failures';
import { validateDataset } from '../eval/schema';
const [run,dataset] = process.argv.slice(2);
if (!run || !dataset) throw new Error('Usage: eval:failures RUN DATASET');
console.log(JSON.stringify(analyzeFailures(JSON.parse(readFileSync(run,'utf8')),validateDataset(JSON.parse(readFileSync(dataset,'utf8')))),null,2));
