import multipart from '@fastify/multipart';
import Fastify from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import type { Db } from '../db.js';
import type { Logger } from '../logger.js';
import { extractors } from '../extractors/index.js';
import { processBatch } from '../pipeline/process.js';
import { resolve } from '../pipeline/resolve.js';
import type { UploadedFile } from '../pipeline/types.js';

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата в формате ГГГГ-ММ-ДД');
const IdParam = z.object({ id: z.coerce.number().int().positive() });

export async function buildApp(logger: Logger, db: Db) {
  const app = Fastify({ loggerInstance: logger });
  // Oversized files are read with a small headroom and rejected by ingest with a clear message.
  await app.register(multipart, { limits: { fileSize: config.upload.maxFileBytes + 1, files: 100 } });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof z.ZodError) return reply.status(400).send({ error: err.issues.map((i) => i.message).join('; ') });
    req.log.error({ err }, 'request failed');
    return reply.status(500).send({ error: 'Внутренняя ошибка' });
  });

  app.get('/api/health', async () => ({ ok: true }));
  app.get('/api/config', async () => ({ check_date: config.checkDate, fields: extractors.map((e) => ({ field: e.field, label: e.label })) }));

  app.post('/api/upload', async (req) => {
    const files: UploadedFile[] = [];
    for await (const part of req.files()) {
      const buffer = await part.toBuffer().catch(() => Buffer.alloc(config.upload.maxFileBytes + 1));
      files.push({ filename: part.filename, buffer });
    }
    return processBatch(files, { db, logger });
  });

  app.get('/api/contracts', async (req) => {
    const { check_date } = z.object({ check_date: IsoDate.default(config.checkDate) }).parse(req.query);
    const res = resolve(db, check_date);
    req.log.info({ stage: 'resolve', check_date, decisions: res.decisions }, 'resolved');
    return res;
  });

  app.get('/api/documents', async () =>
    db.prepare(`select id, filename, doc_type, doc_no, contract_no, sign_status, signed_date, effective_date,
      classified_by, needs_review, review_reason from documents order by contract_no, doc_type, id`).all());

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
