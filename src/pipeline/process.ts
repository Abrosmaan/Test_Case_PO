import { randomUUID } from 'node:crypto';
import type { Db } from '../db.js';
import type { Logger } from '../logger.js';
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

  return { filename: file.filename, status: 'ok', document_id: documentId };
}
