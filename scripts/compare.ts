import { readFileSync } from 'node:fs';
import { compareRuns, regressionGate } from '../eval/compare';
const [before,after,baseline]=process.argv.slice(2);
if(!before||!after) throw new Error('Usage: eval:compare BEFORE AFTER [ACCEPTED_BASELINE.json]');
const a=JSON.parse(readFileSync(before,'utf8')); const b=JSON.parse(readFileSync(after,'utf8'));
const result=baseline?regressionGate(a,b,JSON.parse(readFileSync(baseline,'utf8'))):compareRuns(a,b);
console.log(JSON.stringify(result,null,2)); if('passed' in result && !result.passed) process.exitCode=1;
