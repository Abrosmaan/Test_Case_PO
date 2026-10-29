import multipart from '@fastify/multipart';
import Fastify from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import type { Db } from '../db.js';
import { llmFallback } from '../llm/fallback.js';
import type { LlmProvider } from '../llm/providers.js';
import { LlmQueue } from '../llm/queue.js';
import type { Logger } from '../logger.js';
import { extractors } from '../extractors/index.js';
import { processBatch } from '../pipeline/process.js';
import { resolve } from '../pipeline/resolve.js';
import type { UploadedFile } from '../pipeline/types.js';

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата в формате ГГГГ-ММ-ДД');
const IdParam = z.object({ id: z.coerce.number().int().positive() });

export async function buildApp(logger: Logger, db: Db, llm: LlmProvider | null = null) {
  const app = Fastify({ loggerInstance: logger });
  // The LLM works in the background; documents stored earlier (e.g. reprocessed on start) are picked up right away.
  const llmQueue = llm ? new LlmQueue({ db, logger }, llm) : null;
  if (llmQueue) llmQueue.schedule('startup');
  else await llmFallback({ db, logger }, null, 'startup'); // just marks them «LLM не настроен»
  app.addHook('onClose', async () => { await llmQueue?.idle(); });
  // An oversized file is cut at the limit (not thrown — that would fail the whole batch)
  // and then rejected by ingest with a clear message, like any other bad file.
  await app.register(multipart, {
    throwFileSizeLimit: false,
    limits: { fileSize: config.upload.maxFileBytes + 1, files: config.upload.maxFiles },
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof z.ZodError) return reply.status(400).send({ error: err.issues.map((i) => i.message).join('; ') });
    // Client-side problems (e.g. a broken multipart body) get their status and a readable text, not "internal error".
    const { code, statusCode, message } = err as { code?: string; statusCode?: number; message?: string };
    if (code === 'FST_FILES_LIMIT') {
      req.log.warn({ err }, 'too many files in one upload');
      return reply.status(413).send({ error: `За один раз можно загрузить не больше ${config.upload.maxFiles} файлов — разбейте загрузку на части` });
    }
    if (statusCode && statusCode < 500) {
      req.log.warn({ err }, 'bad request');
      return reply.status(statusCode).send({ error: `Не удалось обработать запрос: ${message ?? ''}` });
    }
    req.log.error({ err }, 'request failed');
    return reply.status(500).send({ error: 'Внутренняя ошибка' });
  });

  app.get('/api/health', async () => ({ ok: true }));
  app.get('/api/config', async () => ({ check_date: config.checkDate, llm: llm ? `${llm.name}/${llm.model}` : null, fields: extractors.map((e) => ({ field: e.field, label: e.label })) }));

  app.post('/api/upload', async (req) => {
    const files: UploadedFile[] = [];
    for await (const part of req.files()) {
      // Truncated at maxFileBytes + 1, so ingest sees it is too large and rejects just this file.
      files.push({ filename: part.filename, buffer: await part.toBuffer() });
    }
    const batch = processBatch(files, { db, logger });
    // Documents the rules did not recognise get an LLM suggestion (always "needs review") — in the background,
    // so the response does not wait for the model. Without an LLM they are just marked at once.
    if (llmQueue) return { ...batch, llm_pending: llmQueue.schedule(batch.batch_id) };
    await llmFallback({ db, logger }, null, batch.batch_id);
    return { ...batch, llm_pending: 0 };
  });

  app.get('/api/llm/status', async () => ({ enabled: llmQueue !== null, ...(llmQueue?.status() ?? { pending: 0, running: false }) }));

  app.get('/api/contracts', async (req) => {
    const { check_date } = z.object({ check_date: IsoDate.default(config.checkDate) }).parse(req.query);
    const res = resolve(db, check_date);
    req.log.info({ stage: 'resolve', check_date, decisions: res.decisions }, 'resolved');
    return res;
  });

  app.get('/api/documents', async () =>
    db.prepare(`select id, filename, doc_type, doc_no, contract_no, sign_status, signed_date, effective_date,
      classified_by, needs_review, review_reason, llm_status, llm_suggestion from documents order by contract_no, doc_type, id`).all());

  app.get('/api/documents/:id', async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const doc = db.prepare('select * from documents where id = ?').get(id);
    if (!doc) return reply.status(404).send({ error: 'Документ не найден' });
    const paragraphs = db.prepare('select id, clause_no, line_no, start, "end", text from paragraphs where document_id = ? order by start').all(id);
    return { ...doc, paragraphs };
  });

  app.get('/api/debug/trace/:id', async (req) => {
    const { id } = IdParam.parse(req.params);
    return (db.prepare('select batch_id, stage, rule_id, message, data, created_at from trace where document_id = ? order by id').all(id) as { data: string }[])
      .map((t) => ({ ...t, data: JSON.parse(t.data) }));
  });

  app.delete('/api/documents', async (req) => {
    db.exec('delete from trace; delete from facts; delete from paragraphs; delete from documents;');
    req.log.info('all documents removed');
    return { ok: true };
  });

  return app;
}
