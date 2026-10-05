import { readdirSync, readFileSync } from 'node:fs';
const files = readdirSync('migrations').filter(f=>/^\d+_.+\.sql$/.test(f)).sort();
const bootstrap = readFileSync('supabase-schema.sql','utf8');
for (const file of files) {
  const sql = readFileSync(`migrations/${file}`,'utf8').trim();
  if (!sql.includes('BEGIN;') || !sql.endsWith('COMMIT;')) throw new Error(`${file} must be transactional`);
  if (!file.startsWith('001_') && !bootstrap.includes(sql)) throw new Error(`Bootstrap missing ${file}`);
}
if (!bootstrap.includes('total_cost DECIMAL(14,6) DEFAULT 0')) throw new Error('Bootstrap precision regression');
console.log(`Checked ${files.length} migrations and bootstrap parity (static only)`);
