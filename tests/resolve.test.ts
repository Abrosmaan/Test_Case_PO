import { mkdtempSync, readFileSync, writeFileSync, readdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { deliveryBefore, findContract } from '../src/pipeline/questions.js';
import { resolve } from '../src/pipeline/resolve.js';
import { loadDir, runAll, TEST_DIR } from './helpers.js';

const CHECK = '2026-03-10';

function table(files = loadDir(), date = CHECK) {
  const res = resolve(runAll(files).db, date);
  return {
    res,
    rows: res.contracts.map((c) => ({
      no: c.contract_no,
      supplier: c.fields.supplier.display,
      amount: `${c.fields.total_amount.display} [${c.fields.total_amount.status_label}]`,
      date: `${c.fields.delivery_date.display} [${c.fields.delivery_date.status_label}]`,
      proposals: c.proposals.map((p) => `${p.source.doc_label}: ${p.display}`),
    })),
  };
}

describe('reference table §5 on 10.03.2026', () => {
  const { res, rows } = table();

  it('matches the reference', () => {
    expect(rows).toEqual([
      { no: 'STN-101', supplier: 'ООО «Вектор Прибор»', amount: '1 380 000 ₽ [изменено ДС №1]', date: '30.04.2026 [изменено ДС №1]', proposals: ['Проект ДС №2: 1 450 000 ₽', 'Проект ДС №2: 10.05.2026'] },
      { no: 'STN-102', supplier: 'ООО «Контур Электро»', amount: '840 000 ₽ [действует]', date: '20.03.2026 [действует]', proposals: ['Письмо: 27.03.2026'] },
      { no: 'STN-103', supplier: 'ООО «ПромСнаб Сервис»', amount: 'нет данных [нет данных]', date: '30.04.2026 [действует]', proposals: [] },
    ]);
    expect(res.unlinked).toEqual([]);
  });

  it('STN-103 amount has the reason from the text', () => {
    expect(findContract(res, 'STN-103')!.fields.total_amount.reason).toMatch(/приложени/i);
  });

  it('STN-101 change chain: contract → amendment 1', () => {
    expect(findContract(res, 'STN-101')!.fields.delivery_date.chain.map((s) => s.display)).toEqual(['15.04.2026', '30.04.2026']);
  });

  it('4 questions', () => {
    expect(findContract(res, 'STN-101')!.fields.delivery_date.display).toBe('30.04.2026');
    expect(findContract(res, 'STN-102')!.fields.total_amount.display).toBe('840 000 ₽');
    expect(findContract(res, 'STN-103')!.fields.total_amount.status).toBe('no_data');
    const early = deliveryBefore(res, '2026-04-01');
    expect(early.map((x) => [x.contract.contract_no, x.contract.fields.delivery_date.display, x.pending.map((p) => p.display)]))
      .toEqual([['STN-102', '20.03.2026', ['27.03.2026']]]);
  });

  it('every source quote is exact', () => {
    const docs = new Map(loadDir().map((f) => [f.filename, f.buffer.toString('utf-8')]));
    for (const c of res.contracts) for (const f of Object.values(c.fields)) {
      if (f.source) expect(docs.get(f.source.filename)!.slice(f.source.start, f.source.end)).toBe(f.source.quote);
    }
  });
});

describe('traps', () => {
  it('renamed files and reverse order give the same result', () => {
    const files = loadDir();
    const scrambled = files.map((f, i) => ({ filename: `doc_${(i * 7) % 11}.txt`, buffer: f.buffer })).reverse();
    expect(table(scrambled).rows).toEqual(table(files).rows);
  });

  it('check date before 01.03.2026 → amendment 1 not applied', () => {
    const c = findContract(table(loadDir(), '2026-02-28').res, 'STN-101')!;
    expect([c.fields.total_amount.display, c.fields.delivery_date.display]).toEqual(['1 200 000 ₽', '15.04.2026']);
    expect(c.proposals.map((p) => p.display)).toEqual(expect.arrayContaining(['1 380 000 ₽', '30.04.2026']));
  });

  it('letter alone does not change STN-102', () => {
    const files = loadDir().filter((f) => /0[35]_/.test(f.filename));
    expect(table(files).rows[0]!.date).toBe('20.03.2026 [действует]');
  });

  it('amendment without its contract is listed as unlinked', () => {
    const files = loadDir().filter((f) => f.filename.startsWith('02_'));
    const { res } = table(files);
    expect(res.contracts).toEqual([]);
    expect(res.unlinked[0]).toMatchObject({ contract_no: 'STN-101', reason: 'договор STN-101 не загружен' });
  });
});

describe('mutation (meeting scenario)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-'));
  for (const f of readdirSync(TEST_DIR)) copyFileSync(join(TEST_DIR, f), join(dir, f));
  const src = readFileSync(join(dir, '03_contract.txt'), 'utf-8');
  writeFileSync(join(dir, '03_contract.txt'), src.replace('840 000 (восемьсот сорок тысяч)', '910 000 (девятьсот десять тысяч)').replace('не позднее 20.03.2026', 'не позднее 25.03.2026'));
  writeFileSync(join(dir, 'new.txt'), src
    .replaceAll('STN-102', 'STN-104').replace('Контур Электро', 'Новый Поставщик')
    .replace('840 000', '555 000').replace('20.03.2026', '05.05.2026'));

  it('changed fields change the result, new contract appears', () => {
    const { rows } = table(loadDir(dir));
    expect(rows.find((r) => r.no === 'STN-102')).toMatchObject({ amount: '910 000 ₽ [действует]', date: '25.03.2026 [действует]' });
    expect(rows.find((r) => r.no === 'STN-104')).toEqual({
      no: 'STN-104', supplier: 'ООО «Новый Поставщик»', amount: '555 000 ₽ [действует]', date: '05.05.2026 [действует]', proposals: [],
    });
  });
});
