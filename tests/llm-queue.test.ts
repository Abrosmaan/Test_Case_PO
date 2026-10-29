import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import type { LlmProvider } from '../src/llm/providers.js';
import { silentLogger } from '../src/logger.js';
import { buildApp } from '../src/server/app.js';

const boundary = '----q';
const multipart = (files: { name: string; text: string }[]) => Buffer.concat([
  ...files.map((f) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${f.name}"\r\nContent-Type: text/plain\r\n\r\n${f.text}\r\n`)),
  Buffer.from(`--${boundary}--\r\n`),
]);
const UNKNOWN = (no: string) => `Соглашение о поставке № ${no}\nПоставщик: ООО «Ромашка».`;
const answer = (no: string) => JSON.stringify({ doc_type: 'contract', contract_no: no, quote: `Соглашение о поставке № ${no}` });

/** A model that answers only when the test says so. */
function gatedProvider() {
  const waiting: (() => void)[] = [];
  const p: LlmProvider & { calls: number; release: () => void } = {
    name: 'fake', model: 'slow', calls: 0,
    async complete(prompt) {
      p.calls++;
      await new Promise<void>((r) => waiting.push(r));
      return answer(/№ (\S+)/.exec(prompt.split('\n').find((l) => l.startsWith('Соглашение'))!)![1]!);
    },
    release: () => { while (waiting.length) waiting.shift()!(); },
  };
  return p;
}

async function setup(llm: LlmProvider | null) {
  const db = openDb(':memory:');
  const app = await buildApp(silentLogger, db, llm);
  const upload = async (files: { name: string; text: string }[]) =>
    (await app.inject({ method: 'POST', url: '/api/upload', payload: multipart(files), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } })).json();
  const status = async () => (await app.inject({ url: '/api/llm/status' })).json();
  const until = async (cond: () => Promise<boolean>) => { for (let i = 0; i < 200 && !(await cond()); i++) await new Promise((r) => setTimeout(r, 5)); };
  return { app, db, upload, status, until };
}

describe('LLM runs in the background', () => {
  it('upload returns before the model answers; the document is "pending" until then', async () => {
    const llm = gatedProvider();
    const { app, db, upload, status, until } = await setup(llm);

    const res = await upload([{ name: 'odd.txt', text: UNKNOWN('STN-105') }]);
    expect(res).toMatchObject({ llm_pending: 1, results: [{ status: 'ok' }] });
    await until(async () => llm.calls === 1);
    expect(await status()).toEqual({ enabled: true, pending: 1, running: true });
    expect(db.prepare('select llm_status, classified_by from documents').get()).toEqual({ llm_status: 'pending', classified_by: 'rules' });
    const contracts = (await app.inject({ url: '/api/contracts' })).json();
    expect(contracts.unlinked[0].reason).toMatch(/^LLM проверяет документ/);

    llm.release();
    await until(async () => (await status()).running === false);
    expect(await status()).toEqual({ enabled: true, pending: 0, running: false });
    expect(db.prepare('select llm_status, classified_by, contract_no from documents').get()).toEqual({ llm_status: 'ok', classified_by: 'llm', contract_no: 'STN-105' });
    await app.close();
  });

  it('a second upload while the model is busy is processed right after', async () => {
    const llm = gatedProvider();
    const { app, db, upload, status, until } = await setup(llm);
    await upload([{ name: 'a.txt', text: UNKNOWN('STN-105') }]);
    await until(async () => llm.calls === 1);
    expect((await upload([{ name: 'b.txt', text: UNKNOWN('STN-106') }])).llm_pending).toBe(2);

    for (let i = 0; i < 2; i++) { await until(async () => llm.calls === i + 1); llm.release(); }
    await until(async () => (await status()).running === false);
    expect(db.prepare("select filename, llm_status from documents order by id").all()).toEqual([
      { filename: 'a.txt', llm_status: 'ok' }, { filename: 'b.txt', llm_status: 'ok' },
    ]);
    await app.close();
  });

  it('«Удалить все» while the model is thinking: the late answer is dropped, nothing breaks', async () => {
    const llm = gatedProvider();
    const { app, db, upload, status, until } = await setup(llm);
    await upload([{ name: 'odd.txt', text: UNKNOWN('STN-105') }]);
    await until(async () => llm.calls === 1);
    await app.inject({ method: 'DELETE', url: '/api/documents' });
    llm.release();
    await until(async () => (await status()).running === false);
    expect(db.prepare('select count(*) as n from documents').get()).toEqual({ n: 0 });
    expect(db.prepare("select count(*) as n from trace where stage = 'llm'").get()).toEqual({ n: 0 });
    await app.close();
  });

  it('recognised documents never wait for the LLM', async () => {
    const llm = gatedProvider();
    const { app, upload } = await setup(llm);
    const res = await upload([{ name: 'c.txt', text: 'ДОГОВОР ПОСТАВКИ № STN-1\nСтатус: подписан обеими сторонами 01.02.2026.' }]);
    expect(res.llm_pending).toBe(0);
    expect(llm.calls).toBe(0);
    await app.close();
  });

  it('without an LLM: no queue, documents are marked at once', async () => {
    const { app, db, upload, status } = await setup(null);
    expect((await upload([{ name: 'odd.txt', text: UNKNOWN('STN-105') }])).llm_pending).toBe(0);
    expect(await status()).toEqual({ enabled: false, pending: 0, running: false });
    expect(db.prepare('select llm_status from documents').get()).toEqual({ llm_status: 'disabled' });
    await app.close();
  });
});
