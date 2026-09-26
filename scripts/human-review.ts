import { readFileSync, writeFileSync } from 'node:fs';
import { exportReview, compareHuman } from '../eval/human-review';
import { validateDataset } from '../eval/schema';
const [command,input,datasetPath,out,limit] = process.argv.slice(2);
if (!input) throw new Error('Usage: review export RUN DATASET OUTPUT [LIMIT] | review compare REVIEWS');
const data = JSON.parse(readFileSync(input,'utf8'));
if (command === 'export') {
  if (!datasetPath || !out) throw new Error('Dataset and output path required');
  writeFileSync(out, JSON.stringify(exportReview(data,validateDataset(JSON.parse(readFileSync(datasetPath,'utf8'))), Number(limit ?? 20)),null,2)+'\n');
} else if (command === 'compare') console.log(JSON.stringify(compareHuman(data),null,2));
else throw new Error('Unknown review command');
