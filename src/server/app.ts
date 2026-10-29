import multipart from '@fastify/multipart';
import Fastify from 'fastify';
import { config } from '../config.js';
import type { Db } from '../db.js';
import type { Logger } from '../logger.js';
import { processBatch } from '../pipeline/process.js';
import type { UploadedFile } from '../pipeline/types.js';

export async function buildApp(logger: Logger, db: Db) {
  const app = Fastify({ loggerInstance: logger });
  // Oversized files are read with a small headroom and rejected by ingest with a clear message.
  await app.register(multipart, { limits: { fileSize: config.upload.maxFileBytes + 1, files: 100 } });

  app.get('/api/health', async () => ({ ok: true }));

  app.post('/api/upload', async (req) => {
    const files: UploadedFile[] = [];
    for await (const part of req.files()) {
      const buffer = await part.toBuffer().catch(() => Buffer.alloc(config.upload.maxFileBytes + 1));
      files.push({ filename: part.filename, buffer });
    }
    return processBatch(files, { db, logger });
  });

  return app;
}
