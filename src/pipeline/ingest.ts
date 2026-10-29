import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import iconv from 'iconv-lite';
import { config } from '../config.js';

export type IngestResult =
  | { ok: true; text: string; encoding: 'utf-8' | 'cp1251'; sha256: string }
  | { ok: false; rule_id: string; reason: string };

/** Validates and decodes an uploaded file. Never throws. */
export function ingest(filename: string, buffer: Buffer): IngestResult {
  const ext = extname(filename).toLowerCase();
  if (!(config.upload.allowedExtensions as readonly string[]).includes(ext)) {
    return { ok: false, rule_id: 'ingest.ext', reason: `Формат ${ext || 'без расширения'} не поддерживается: загрузите файл .txt` };
  }
  if (buffer.length > config.upload.maxFileBytes) {
    return { ok: false, rule_id: 'ingest.size', reason: `Файл больше ${Math.round(config.upload.maxFileBytes / 1024)} КБ` };
  }

  let text: string;
  let encoding: 'utf-8' | 'cp1251';
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    encoding = 'utf-8';
  } catch {
    text = iconv.decode(buffer, 'win1251');
    encoding = 'cp1251';
  }
  // NUL or other control characters (PNG «\x1a», UTF-16 zero bytes…): a binary file renamed to .txt.
  if (/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/.test(text)) {
    return { ok: false, rule_id: 'ingest.binary', reason: 'Файл не является текстовым' };
  }

  // Stored text is the single source for offsets: BOM removed, line endings normalised.
  text = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  if (text.trim() === '') {
    return { ok: false, rule_id: 'ingest.empty', reason: 'Файл пустой' };
  }

  const sha256 = createHash('sha256').update(text).digest('hex');
  return { ok: true, text, encoding, sha256 };
}
