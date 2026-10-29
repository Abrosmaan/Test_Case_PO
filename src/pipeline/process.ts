import { randomUUID } from 'node:crypto';
import type { Db } from '../db.js';
import type { Logger } from '../logger.js';
import { extractors } from '../extractors/index.js';
import { buildSegments } from '../extractors/segments.js';
import { detectTermination } from '../extractors/termination.js';
import { findInjection } from '../llm/classify.js';
import { classify } from './classify.js';
import { ingest } from './ingest.js';
import { segment } from './segment.js';
import { Tracer } from './trace.js';
import type { FileResult, UploadedFile } from './types.js';

export interface Ctx {
  db: Db;
  logger: Logger;
}

/** Processes a batch. A failure on one file never stops the others. */
export function processBatch(files: UploadedFile[], ctx: Ctx): { batch_id: string; results: FileResult[] } {
  const batch_id = randomUUID();
  ctx.logger.info({ batch_id, files: files.length }, 'batch started');
  const results = files.map((f) => {
    const tracer = new Tracer(ctx.db, ctx.logger, batch_id, f.filename);
    try {
      return processFile(f, tracer, ctx);
    } catch (err) {
      tracer.error('ingest', err);
      return { filename: f.filename, status: 'rejected', reason: 'Внутренняя ошибка обработки файла' } satisfies FileResult;
    }
  });
  ctx.logger.info({ batch_id, results: results.map((r) => ({ filename: r.filename, status: r.status })) }, 'batch done');
  return { batch_id, results };
}

function processFile(file: UploadedFile, tracer: Tracer, { db }: Ctx): FileResult {
  const res = tracer.time('ingest', () => ingest(file.filename, file.buffer));
  if (!res.ok) {
    tracer.record('ingest', res.rule_id, 'Файл отклонён', { reason: res.reason }, 'warn');
    return { filename: file.filename, status: 'rejected', reason: res.reason };
  }

  const existing = db.prepare('select id, filename from documents where sha256 = ?').get(res.sha256) as
    | { id: number; filename: string }
    | undefined;
  if (existing) {
    tracer.attach(existing.id);
    tracer.record('ingest', 'ingest.duplicate', 'Повторная загрузка того же содержимого — дубль не создан', { duplicate_of: existing.filename });
    return { filename: file.filename, status: 'duplicate', document_id: existing.id, duplicate_of: existing.filename };
  }

  const { lastInsertRowid } = db
    .prepare('insert into documents (filename, sha256, encoding, text) values (?, ?, ?, ?)')
    .run(file.filename, res.sha256, res.encoding, res.text);
  const documentId = Number(lastInsertRowid);
  tracer.attach(documentId);
  tracer.record('ingest', 'ingest.ok', 'Файл принят', { encoding: res.encoding, sha256: res.sha256, chars: res.text.length });
  tracer.record('ingest', null, 'Полный текст', { text: res.text }, 'debug');

  const paragraphs = tracer.time('segment', () => segment(res.text));
  const insert = db.prepare('insert into paragraphs (document_id, clause_no, line_no, start, "end", text) values (?, ?, ?, ?, ?, ?)');
  for (const p of paragraphs) {
    p.id = Number(insert.run(documentId, p.clause_no, p.line_no, p.start, p.end, p.text).lastInsertRowid);
  }
  tracer.record('segment', 'segment.lines', `Абзацев: ${paragraphs.length}`, {
    clauses: paragraphs.filter((p) => p.clause_no).map((p) => p.clause_no),
  });

  const cls = tracer.time('classify', () => classify(paragraphs));
  for (const e of cls.evidence) tracer.record('classify', e.rule_id, `${e.attr}: «${e.quote}»`, { line_no: e.line_no });
  for (const reason of cls.review_reasons) tracer.record('classify', 'classify.needs_review', reason, {}, 'warn');
  tracer.record('classify', null, `Итог: ${cls.doc_type} ${cls.doc_no ?? ''} → договор ${cls.contract_no ?? '?'}, ${cls.sign_status}`, {
    doc_type: cls.doc_type, contract_no: cls.contract_no, sign_status: cls.sign_status,
    signed_date: cls.signed_date, effective_date: cls.effective_date, needs_review: cls.needs_review,
  });
  db.prepare(`update documents set doc_type = ?, doc_no = ?, contract_no = ?, sign_status = ?, doc_date = ?, signed_date = ?,
      effective_date = ?, classified_by = 'rules', needs_review = ?, review_reason = ? where id = ?`)
    .run(cls.doc_type, cls.doc_no, cls.contract_no, cls.sign_status, cls.doc_date, cls.signed_date,
      cls.effective_date, cls.needs_review ? 1 : 0, cls.review_reasons.join('; ') || null, documentId);

  // A paragraph that talks to «the AI system» is not a contract term: nothing is extracted from it,
  // and the document is flagged — otherwise «итоговая стоимость — 99 000 000» would compete with the real clause.
  const segments = buildSegments(cls.doc_type, paragraphs).filter((seg) => {
    const injection = findInjection(seg.text);
    if (!injection) return true;
    tracer.record('extract', 'extract.injection_suspected', `Абзац похож на инструкцию для автоматической системы — значения из него не извлекаются: «${injection}»`, { quote: seg.text }, 'warn');
    db.prepare("update documents set needs_review = 1, review_reason = trim(coalesce(review_reason || '; ', '') || ?) where id = ?")
      .run(`в тексте есть инструкция для автоматической системы («${injection}») — значения из этого абзаца не извлекаются`, documentId);
    return false;
  });
  const insertFact = db.prepare(`insert into facts (document_id, paragraph_id, field, kind, value, display, quote, start, "end", rule_id, replaces_clause, reason)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  tracer.time('extract', () => {
    for (const ex of extractors) {
      const r = ex.extract(segments);
      for (const f of r.facts) {
        insertFact.run(documentId, f.paragraph_id, f.field, 'fact', f.value, f.display, f.quote, f.start, f.end, f.rule_id, f.replaces_clause, null);
        tracer.record('extract', f.rule_id, `${ex.label}: принято ${f.display}${f.replaces_clause ? ` (новая редакция п. ${f.replaces_clause})` : ''}`, { field: f.field, quote: f.quote });
      }
      for (const n of r.noData) {
        insertFact.run(documentId, n.paragraph_id, n.field, 'no_data', null, null, n.quote, n.start, n.end, n.rule_id, null, n.reason);
        tracer.record('extract', n.rule_id, `${ex.label}: нет данных`, { field: n.field, reason: n.reason });
      }
      for (const x of r.rejected) {
        tracer.record('extract', x.rule_id, `${ex.label}: отброшено ${x.candidate} — ${x.reason}`, { field: x.field, quote: x.quote });
        // Kept with its quote so the answer can say «252 000 ₽ — аванс, не сумма договора», not only the trace.
        const at = res.text.indexOf(x.quote);
        const para = paragraphs.find((p) => at >= p.start && at < p.end);
        insertFact.run(documentId, para?.id ?? null, x.field, 'rejected', x.candidate, x.candidate, x.quote, at, at + x.quote.length, x.rule_id, null, x.reason);
      }
    }
    // Termination is looked for in every paragraph of amendments, drafts and letters (not in replaced wording only).
    if (cls.doc_type !== 'contract') {
      for (const f of detectTermination(buildSegments('contract', paragraphs))) {
        insertFact.run(documentId, f.paragraph_id, f.field, 'fact', f.value, f.display, f.quote, f.start, f.end, f.rule_id, null, null);
        tracer.record('extract', f.rule_id, `Расторжение: ${f.display}`, { field: f.field, quote: f.quote });
      }
    }
  });

  return { filename: file.filename, status: 'ok', document_id: documentId };
}

/**
 * Re-runs the whole pipeline over stored documents, e.g. after a new extractor was added.
 * Same text → same result, so this is safe on every start. Document ids may change.
 */
export function reprocessAll(ctx: Ctx) {
  const docs = ctx.db.prepare('select filename, text from documents order by id').all() as { filename: string; text: string }[];
  if (docs.length === 0) return null;
  ctx.db.exec('delete from trace; delete from facts; delete from paragraphs; delete from documents;');
  ctx.logger.info({ documents: docs.length }, 'reprocessing stored documents');
  return processBatch(docs.map((d) => ({ filename: d.filename, buffer: Buffer.from(d.text, 'utf-8') })), ctx);
}
