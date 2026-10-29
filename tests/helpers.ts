import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { silentLogger } from '../src/logger.js';
import { processBatch } from '../src/pipeline/process.js';
import type { UploadedFile } from '../src/pipeline/types.js';

export const TEST_DIR = join(import.meta.dirname, '..', 'Test Files');

export function loadDir(dir: string = TEST_DIR): UploadedFile[] {
  return readdirSync(dir).sort().map((filename) => ({ filename, buffer: readFileSync(join(dir, filename)) }));
}

export function freshCtx() {
  return { db: openDb(':memory:'), logger: silentLogger };
}

export function runAll(files: UploadedFile[] = loadDir()) {
  const ctx = freshCtx();
  const out = processBatch(files, ctx);
  return { ...ctx, ...out };
}
