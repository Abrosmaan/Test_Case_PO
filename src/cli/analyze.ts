// Runs the pipeline over a folder without the UI and prints the table, the decisions and the trace.
// Usage: npm run analyze -- "Test Files" [--date 2026-03-10]
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { openDb } from '../db.js';
import { silentLogger } from '../logger.js';
import { processBatch } from '../pipeline/process.js';
import { resolve } from '../pipeline/resolve.js';

const args = process.argv.slice(2);
const dateIdx = args.indexOf('--date');
const checkDate = dateIdx >= 0 ? args[dateIdx + 1]! : config.checkDate;
const dir = args.find((a, i) => !a.startsWith('--') && !(dateIdx >= 0 && i === dateIdx + 1));
if (!dir) {
  console.error('Usage: npm run analyze -- <folder> [--date YYYY-MM-DD]');
  process.exit(1);
}

const files = readdirSync(dir).filter((f) => statSync(join(dir, f)).isFile()).sort()
  .map((filename) => ({ filename, buffer: readFileSync(join(dir, filename)) }));
const db = openDb(':memory:');
const { results } = processBatch(files, { db, logger: silentLogger });

console.log(`\n== Файлы (${results.length})`);
for (const r of results) console.log(`  ${r.status.padEnd(9)} ${r.filename}${r.status === 'rejected' ? ` — ${r.reason}` : r.status === 'duplicate' ? ` = ${r.duplicate_of}` : ''}`);

console.log('\n== Трасса по документам');
const traceRows = db.prepare(`select d.filename, t.stage, t.rule_id, t.message from trace t join documents d on d.id = t.document_id
  where t.message not like 'Полный текст%' order by t.document_id, t.id`).all() as { filename: string; stage: string; rule_id: string | null; message: string }[];
let last = '';
for (const t of traceRows) {
  if (t.filename !== last) console.log(`\n  [${(last = t.filename)}]`);
  console.log(`    ${t.stage.padEnd(8)} ${(t.rule_id ?? '').padEnd(32)} ${t.message}`);
}

const res = resolve(db, checkDate);
console.log(`\n== Решения по ДС, проектам и письмам на ${checkDate}`);
for (const d of res.decisions) console.log(`  ${d.contract_no} ${d.applied ? 'ПРИМЕНЁН  ' : 'не применён'} ${d.filename} — ${d.reason}`);

console.log(`\n== Таблица на ${checkDate}`);
for (const c of res.contracts) {
  console.log(`\n  ${c.contract_no}${c.needs_review ? `  ⚠ требует проверки: ${c.review_reasons.join('; ')}` : ''}`);
  for (const [field, f] of Object.entries(c.fields)) {
    const src = f.source ? `${f.source.filename}: «${f.source.quote}»` : '';
    console.log(`    ${field.padEnd(14)} ${f.display.padEnd(22)} [${f.status_label}] ${f.reason && f.status !== 'no_data' ? f.reason : ''}`);
    if (f.status === 'no_data' && f.reason) console.log(`    ${''.padEnd(14)} причина: ${f.reason}`);
    if (src) console.log(`    ${''.padEnd(14)} источник: ${src}`);
  }
  for (const p of c.proposals) console.log(`    предложение   ${p.field}: ${p.display} — ${p.source.doc_label} (${p.reason})`);
}
if (res.unlinked.length) {
  console.log('\n== Не связаны с загруженным договором');
  for (const u of res.unlinked) console.log(`  ${u.filename} — ${u.reason}`);
}
