import { describe, expect, it } from 'vitest';
import { extractors } from '../src/extractors/index.js';
import { buildSegments } from '../src/extractors/segments.js';
import { segment } from '../src/pipeline/segment.js';
import { runAll } from './helpers.js';

interface FactRow { filename: string; field: string; kind: string; value: string | null; quote: string; start: number; end: number; replaces_clause: string | null; text: string }

function facts() {
  const { db } = runAll();
  return db.prepare(`select d.filename, d.text, f.field, f.kind, f.value, f.quote, f.start, f."end", f.replaces_clause
    from facts f join documents d on d.id = f.document_id`).all() as unknown as FactRow[];
}
const values = (rows: FactRow[], file: string, field: string) =>
  rows.filter((r) => r.filename === file && r.field === field && r.kind !== 'rejected').map((r) => (r.kind === 'fact' ? r.value : 'no_data'));

describe('extractors on test files', () => {
  const rows = facts();

  it('every fact quote is an exact substring of the source', () => {
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.text.slice(r.start, r.end)).toBe(r.quote);
  });

  it('contract values', () => {
    expect(values(rows, '01_contract.txt', 'supplier')).toEqual(['ООО «Вектор Прибор»']);
    expect(values(rows, '01_contract.txt', 'total_amount')).toEqual(['1200000']);
    expect(values(rows, '01_contract.txt', 'delivery_date')).toEqual(['2026-04-15']);
    expect(values(rows, '03_contract.txt', 'supplier')).toEqual(['ООО «Контур Электро»']);
  });

  it('trap: advance 252 000 is not the total of STN-102', () => {
    expect(values(rows, '03_contract.txt', 'total_amount')).toEqual(['840000']);
  });

  it('trap: payment deadline 10.04.2026 is not the delivery date of STN-102', () => {
    expect(values(rows, '03_contract.txt', 'delivery_date')).toEqual(['2026-03-20']);
  });

  it('trap: limit 600 000 is not the total of STN-103 → no_data with reason', () => {
    expect(values(rows, '04_contract.txt', 'total_amount')).toEqual(['no_data']);
    expect(values(rows, '04_contract.txt', 'delivery_date')).toEqual(['2026-04-30']);
  });

  it('amendment: new wording of clauses, marked as replacement', () => {
    const a = rows.filter((r) => r.filename === '02_amendment_signed.txt');
    expect(a.map((r) => [r.field, r.value, r.replaces_clause])).toEqual(
      expect.arrayContaining([['total_amount', '1380000', '2.1'], ['delivery_date', '2026-04-30', '3.1']]),
    );
    expect(a.find((r) => r.field === 'supplier')).toBeUndefined();
  });

  it('proposals in draft and letter', () => {
    expect(values(rows, '06_amendment_draft.txt', 'total_amount')).toEqual(['1450000']);
    expect(values(rows, '06_amendment_draft.txt', 'delivery_date')).toEqual(['2026-05-10']);
    expect(values(rows, '05_supplier_email.txt', 'delivery_date')).toEqual(['2026-03-27']);
  });
});

describe('extractors on synthetic text', () => {
  const run = (text: string) => {
    const ps = segment(text);
    const segs = buildSegments('contract', ps);
    return Object.fromEntries(extractors.map((e) => [e.field, e.extract(segs)]));
  };

  it('reports rejected candidates with reasons', () => {
    const r = run('2.2. Авансовый платеж составляет 100 000 рублей.\n3.2. Оплата производится не позднее 01.01.2027.');
    expect(r.total_amount!.rejected[0]).toMatchObject({ candidate: '100 000 ₽', rule_id: 'amount.stop_word' });
    expect(r.total_amount!.facts).toEqual([]);
  });

  it('parses amounts with kopecks and ₽ sign', () => {
    const r = run('2.1. Общая стоимость договора составляет 12 345,50 ₽.');
    expect(r.total_amount!.facts[0]).toMatchObject({ value: '12345.5', display: '12 345,50 ₽' });
  });
});
