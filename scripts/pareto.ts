import { readFileSync,mkdirSync,writeFileSync } from 'node:fs';
import { paretoData,paretoSvg } from '../eval/pareto';
const [input,out='eval/reports']=process.argv.slice(2);
if(!input) throw new Error('Usage: eval:pareto RUN.json [DIRECTORY]');
const data=paretoData(JSON.parse(readFileSync(input,'utf8')));const svg=paretoSvg(data);
if(!svg) console.log('No complete paired live benchmark data; no chart generated.');
else {mkdirSync(out,{recursive:true});writeFileSync(`${out}/pareto.json`,JSON.stringify(data,null,2)+'\n');writeFileSync(`${out}/pareto.svg`,svg);console.log(out);}
