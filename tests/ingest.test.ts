import iconv from 'iconv-lite';
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { silentLogger } from '../src/logger.js';
import { ingest } from '../src/pipeline/ingest.js';
import { processBatch } from '../src/pipeline/process.js';
import { segment } from '../src/pipeline/segment.js';
import { buildApp } from '../src/server/app.js';
import { freshCtx, loadDir } from './helpers.js';

const SAMPLE = 'ДОГОВОР ПОСТАВКИ № X-1\n\n2.1. Общая стоимость 100 рублей.\r\n3. Пункт без подпункта.\n';

describe('ingest', () => {
  it('decodes UTF-8 and normalises line endings', () => {
    const r = ingest('a.txt', Buffer.from(SAMPLE, 'utf-8'));
    expect(r).toMatchObject({ ok: true, encoding: 'utf-8' });
    if (r.ok) expect(r.text).not.toContain('\r');
  });

  it('falls back to cp1251', () => {
    const r = ingest('a.txt', iconv.encode(SAMPLE, 'win1251'));
    expect(r).toMatchObject({ ok: true, encoding: 'cp1251' });
    if (r.ok) expect(r.text).toContain('ДОГОВОР ПОСТАВКИ');
  });

  it('strips UTF-8 BOM', () => {
    const r = ingest('a.txt', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(SAMPLE)]));
    expect(r.ok && r.text.startsWith('ДОГОВОР')).toBe(true);
  });

  it('rejects empty, non-TXT, binary and oversized files', () => {
    expect(ingest('a.txt', Buffer.from('  \n\n'))).toMatchObject({ ok: false, rule_id: 'ingest.empty' });
    expect(ingest('a.pdf', Buffer.from('%PDF'))).toMatchObject({ ok: false, rule_id: 'ingest.ext' });
    expect(ingest('a.docx', Buffer.from('PK'))).toMatchObject({ ok: false, rule_id: 'ingest.ext' });
    expect(ingest('a.txt', Buffer.from([0x41, 0x00, 0x42]))).toMatchObject({ ok: false, rule_id: 'ingest.binary' });
    expect(ingest('a.txt', Buffer.alloc(2 * 1024 * 1024, 0x41))).toMatchObject({ ok: false, rule_id: 'ingest.size' });
  });
});

describe('segment', () => {
  it('offsets cut exactly the paragraph text from the source', () => {
    for (const f of loadDir()) {
      const r = ingest(f.filename, f.buffer);
      if (!r.ok) throw new Error(f.filename);
      for (const p of segment(r.text)) expect(r.text.slice(p.start, p.end)).toBe(p.text);
    }
  });

  it('detects clause numbers', () => {
    const ps = segment(SAMPLE.replace(/\r/g, ''));
    expect(ps.map((p) => p.clause_no)).toEqual([null, '2.1', '3']);
    expect(ps.map((p) => p.line_no)).toEqual([1, 3, 4]);
  });
});

describe('batch', () => {
  it('does not duplicate the same content and keeps processing after a bad file', () => {
    const ctx = freshCtx();
    const files = loadDir();
    const first = processBatch([{ filename: 'bad.pdf', buffer: Buffer.from('x') }, ...files], ctx);
    expect(first.results[0]).toMatchObject({ status: 'rejected' });
    expect(first.results.slice(1).every((r) => r.status === 'ok')).toBe(true);

    const again = processBatch([{ filename: 'renamed.txt', buffer: files[0]!.buffer }], ctx);
    expect(again.results[0]).toMatchObject({ status: 'duplicate', duplicate_of: files[0]!.filename });
    const { n } = ctx.db.prepare('select count(*) as n from documents').get() as { n: number };
    expect(n).toBe(files.length);
  });

  it('accepts multipart upload over HTTP', async () => {
    const app = await buildApp(silentLogger, openDb(':memory:'));
    const boundary = '----x';
    const body = [
      `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="a.txt"\r\nContent-Type: text/plain\r\n\r\n${SAMPLE}\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="b.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF\r\n`,
      `--${boundary}--\r\n`,
    ].join('');
    const res = await app.inject({
      method: 'POST', url: '/api/upload', payload: body,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    });
    expect(res.json().results.map((r: { status: string }) => r.status)).toEqual(['ok', 'rejected']);
    await app.close();
  });
});
