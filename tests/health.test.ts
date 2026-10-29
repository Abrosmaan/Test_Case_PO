import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { silentLogger } from '../src/logger.js';
import { buildApp } from '../src/server/app.js';

describe('server', () => {
  it('responds to health check', async () => {
    const app = await buildApp(silentLogger, openDb(':memory:'));
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.json()).toEqual({ ok: true });
    await app.close();
  });
});

describe('api', () => {
  it('upload → contracts → document → trace', async () => {
    const { loadDir } = await import('./helpers.js');
    const app = await buildApp(silentLogger, openDb(':memory:'));
    const boundary = '----x';
    const body = Buffer.concat([
      ...loadDir().flatMap((f) => [
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${f.filename}"\r\nContent-Type: text/plain\r\n\r\n`),
        f.buffer, Buffer.from('\r\n'),
      ]),
      Buffer.from(`--${boundary}--\r\n`),
    ]);
    const up = await app.inject({ method: 'POST', url: '/api/upload', payload: body, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } });
    expect(up.json().results.every((r: { status: string }) => r.status === 'ok')).toBe(true);

    const res = (await app.inject({ url: '/api/contracts?check_date=2026-03-10' })).json();
    const stn101 = res.contracts.find((c: { contract_no: string }) => c.contract_no === 'STN-101');
    expect(stn101.fields.delivery_date.display).toBe('30.04.2026');

    const docId = stn101.fields.delivery_date.source.document_id;
    const doc = (await app.inject({ url: `/api/documents/${docId}` })).json();
    const { start, end, quote } = stn101.fields.delivery_date.source;
    expect(doc.text.slice(start, end)).toBe(quote);

    const trace = (await app.inject({ url: `/api/debug/trace/${docId}` })).json();
    expect(trace.some((t: { rule_id: string }) => t.rule_id === 'classify.effective_date')).toBe(true);

    expect((await app.inject({ url: '/api/contracts?check_date=bad' })).statusCode).toBe(400);
    expect((await app.inject({ url: '/api/documents/999' })).statusCode).toBe(404);
    await app.close();
  });
});
