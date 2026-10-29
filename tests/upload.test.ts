import { describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { openDb } from '../src/db.js';
import { silentLogger } from '../src/logger.js';
import { buildApp } from '../src/server/app.js';

const boundary = '----batch';
function multipart(files: { name: string; body: Buffer }[]) {
  return Buffer.concat([
    ...files.flatMap((f) => [
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${f.name}"\r\nContent-Type: text/plain\r\n\r\n`),
      f.body, Buffer.from('\r\n'),
    ]),
    Buffer.from(`--${boundary}--\r\n`),
  ]);
}
const contract = (i: number) => Buffer.from(`ДОГОВОР ПОСТАВКИ № BAT-${i}\nСтатус: подписан обеими сторонами 01.02.2026.\n1.1. Поставщик: ООО «П${i}».\n`
  + `2.1. Общая стоимость поставки составляет ${1000 + i} рублей.\n3.1. Поставщик обязуется поставить товар не позднее 01.05.2026.`);

async function post(files: { name: string; body: Buffer }[]) {
  const app = await buildApp(silentLogger, openDb(':memory:'));
  const res = await app.inject({ method: 'POST', url: '/api/upload', payload: multipart(files), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } });
  const contracts = res.statusCode === 200 ? (await app.inject({ url: '/api/contracts' })).json().contracts.length : null;
  await app.close();
  return { status: res.statusCode, body: res.json(), contracts };
}

describe('large batch upload', () => {
  it('80 files with one oversized: the big one is rejected with a reason, the other 79 are processed', async () => {
    const files = Array.from({ length: 80 }, (_, i) => ({ name: `c${i}.txt`, body: contract(i) }));
    files[40] = { name: 'huge.txt', body: Buffer.alloc(2 * 1024 * 1024, 0x41) };
    const r = await post(files);
    expect(r.status).toBe(200);
    expect(r.body.results).toHaveLength(80);
    expect(r.body.results.filter((x: { status: string }) => x.status === 'ok')).toHaveLength(79);
    expect(r.body.results[40]).toMatchObject({ filename: 'huge.txt', status: 'rejected', reason: expect.stringMatching(/больше 1024 КБ/) });
    expect(r.contracts).toBe(79);
  });

  it('several oversized files in a row do not break the batch', async () => {
    const big = Buffer.alloc(config.upload.maxFileBytes + 10, 0x41);
    const r = await post([{ name: 'a.txt', body: big }, { name: 'b.txt', body: contract(1) }, { name: 'c.txt', body: big }]);
    expect(r.status).toBe(200);
    expect(r.body.results.map((x: { status: string }) => x.status)).toEqual(['rejected', 'ok', 'rejected']);
  });

  it('more files than the limit → clear 413 message, not an internal error', async () => {
    const files = Array.from({ length: config.upload.maxFiles + 1 }, (_, i) => ({ name: `c${i}.txt`, body: contract(i) }));
    const r = await post(files);
    expect(r.status).toBe(413);
    expect(r.body.error).toMatch(new RegExp(`не больше ${config.upload.maxFiles} файлов`));
  });
});
