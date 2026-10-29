// Compares the pipeline with an expectations file (Test Cases/expected.json by default).
// Usage: npm run cases [-- <cases dir> <expected.json>]
// Exit code 1 if anything is silently wrong: a value where another value, «нет данных» or «требует проверки»
// was expected, or a contract row that must not appear. Being more cautious than expected is reported, not failed.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '../db.js';
import { silentLogger } from '../logger.js';
import { processBatch } from '../pipeline/process.js';
import { resolve, type ResolvedField } from '../pipeline/resolve.js';

interface ExpDoc { file: string; case: string; ingest: string; doc_type?: string; contract_no?: string | null; sign_status?: string }
interface ExpContract { contract_no: string; amount: number | string; delivery_date: string; note?: string }
interface Expected { check_date: string; batches: Record<string, { documents: ExpDoc[]; contracts?: ExpContract[]; must_not_appear?: string[] }> }

const [dir = 'Test Cases/cases', expFile = 'Test Cases/expected.json'] = process.argv.slice(2);
const exp = JSON.parse(readFileSync(expFile, 'utf8')) as Expected;
const files = readdirSync(dir).sort().map((f) => ({ filename: f, buffer: readFileSync(join(dir, f)) }));
const db = openDb(':memory:');
const { results } = processBatch(files, { db, logger: silentLogger });
const res = resolve(db, exp.check_date);
const byFile = new Map(results.map((r) => [r.filename, r]));
const docRow = (f: string) => db.prepare('select doc_type, contract_no, sign_status, needs_review from documents where filename = ?').get(f) as
  { doc_type: string; contract_no: string | null; sign_status: string; needs_review: number } | undefined;

const ourValue = (f: ResolvedField) => (f.status === 'needs_review' ? 'needs_review' : f.status === 'no_data' ? 'no_data' : f.value);
const cautious = (v: string | null) => v === 'needs_review' || v === 'no_data' || v === null;

const wrong: string[] = [];
const careful: string[] = [];
const docs: string[] = [];
let ok = 0;
let total = 0;

for (const [batch, b] of Object.entries(exp.batches)) {
  for (const d of b.documents) {
    const r = byFile.get(d.file);
    const ingest = !r ? 'missing' : r.status === 'ok' ? 'accepted' : r.status;
    const row = docRow(d.file);
    const okIngest = d.ingest === ingest || (d.ingest === 'rejected_or_needs_review' && (ingest === 'rejected' || row?.needs_review === 1));
    if (!okIngest) docs.push(`${d.file}: приём — ожидается ${d.ingest}, получено ${ingest}  [${d.case}]`);
    if (row && d.ingest === 'accepted') {
      for (const k of ['doc_type', 'contract_no', 'sign_status'] as const) {
        const e = d[k];
        if (e === undefined || e === '' || e === row[k]) continue;
        // «needs_review» and null («cannot be determined reliably») are met by a document flagged for review;
        // a signing status of null («not applicable», e.g. a letter) is met by «unknown».
        if ((e === 'needs_review' || e === null) && row.needs_review === 1) continue;
        if (k === 'sign_status' && e === null && row[k] === 'unknown') continue;
        docs.push(`${d.file}: ${k} — ожидается ${e}, получено ${row[k]}  [${d.case}]`);
      }
    }
  }
  for (const c of b.contracts ?? []) {
    const ours = res.contracts.find((x) => x.contract_no === c.contract_no);
    for (const [field, key] of [['total_amount', 'amount'], ['delivery_date', 'delivery_date']] as const) {
      total++;
      const e = String(c[key]);
      const o = ours ? ourValue(ours.fields[field]) : null;
      if (e === o) { ok++; continue; }
      const line = `${c.contract_no} ${key}: ожидается ${e}, получено ${o ?? 'нет строки'}${ours ? ` («${ours.fields[field].display}»)` : ''}  [${batch}]`;
      if (cautious(o)) careful.push(line + (cautious(e) ? ' — оба осторожны, допустимо' : ''));
      else wrong.push(line);
    }
  }
  for (const item of b.must_not_appear ?? []) {
    const no = item.split(' ')[0]!;
    if (res.contracts.some((x) => x.contract_no === no)) wrong.push(`${no}: строка не должна появляться в таблице  [${batch}]`);
  }
}
const expectedRows = new Set(Object.values(exp.batches).flatMap((b) => (b.contracts ?? []).map((c) => c.contract_no)));
for (const c of res.contracts) if (!expectedRows.has(c.contract_no) && !c.needs_review) wrong.push(`${c.contract_no}: лишняя строка в таблице без пометки «требует проверки»`);

console.log(`Совпало значений: ${ok} из ${total}\n`);
console.log(`== Молча неверно (${wrong.length})`);
wrong.forEach((l) => console.log('  ' + l));
console.log(`\n== Осторожнее, чем ожидалось (${careful.length})`);
careful.forEach((l) => console.log('  ' + l));
console.log(`\n== Приём и классификация документов (${docs.length})`);
docs.forEach((l) => console.log('  ' + l));
process.exitCode = wrong.length ? 1 : 0;
