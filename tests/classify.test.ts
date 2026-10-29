import { describe, expect, it } from 'vitest';
import { classify } from '../src/pipeline/classify.js';
import { segment } from '../src/pipeline/segment.js';
import { loadDir, runAll } from './helpers.js';

type Row = Record<string, unknown>;
const pick = (db: ReturnType<typeof runAll>['db']) =>
  db.prepare('select filename, doc_type, doc_no, contract_no, sign_status, signed_date, effective_date, needs_review from documents order by contract_no, doc_type, doc_no').all() as Row[];

describe('classify test files', () => {
  it('classifies all 6 files', () => {
    const { db } = runAll();
    const rows = Object.fromEntries(pick(db).map((r) => [r.filename, r]));
    expect(rows['01_contract.txt']).toMatchObject({ doc_type: 'contract', contract_no: 'STN-101', sign_status: 'signed_both', signed_date: '2026-02-05', needs_review: 0 });
    expect(rows['02_amendment_signed.txt']).toMatchObject({ doc_type: 'amendment', doc_no: '1', contract_no: 'STN-101', sign_status: 'signed_both', effective_date: '2026-03-01', needs_review: 0 });
    expect(rows['03_contract.txt']).toMatchObject({ doc_type: 'contract', contract_no: 'STN-102', sign_status: 'signed_both' });
    expect(rows['04_contract.txt']).toMatchObject({ doc_type: 'contract', contract_no: 'STN-103', sign_status: 'signed_both' });
    expect(rows['05_supplier_email.txt']).toMatchObject({ doc_type: 'letter', contract_no: 'STN-102', needs_review: 0 });
    expect(rows['06_amendment_draft.txt']).toMatchObject({ doc_type: 'draft', doc_no: '2', contract_no: 'STN-101', sign_status: 'unsigned', effective_date: null });
  });

  it('ignores file names and upload order', () => {
    const files = loadDir();
    const swapped = files.map((f, i) => ({ filename: files[files.length - 1 - i]!.filename, buffer: f.buffer })).reverse();
    const strip = (rows: Row[]) => rows.map(({ filename: _, ...rest }) => rest);
    expect(strip(pick(runAll(swapped).db))).toEqual(strip(pick(runAll(files).db)));
  });
});

describe('classify edge cases', () => {
  const cls = (text: string) => classify(segment(text));

  it('unknown title → needs_review', () => {
    expect(cls('Акт сверки\nДоговор STN-1')).toMatchObject({ doc_type: 'unknown', contract_no: 'STN-1', needs_review: true });
  });

  it('contradictory status → needs_review, no guess', () => {
    const r = cls('ДОПОЛНИТЕЛЬНОЕ СОГЛАШЕНИЕ № 3 К ДОГОВОРУ STN-1\nСтатус: проект, подписано обеими сторонами 01.03.2026.');
    expect(r).toMatchObject({ sign_status: 'unknown', needs_review: true });
  });

  it('several contracts mentioned → needs_review', () => {
    expect(cls('ПИСЬМО\nПо договорам STN-1 и STN-2')).toMatchObject({ contract_no: null, needs_review: true });
  });

  it('signed amendment without effective date → needs_review', () => {
    expect(cls('ДОПОЛНИТЕЛЬНОЕ СОГЛАШЕНИЕ № 3 К ДОГОВОРУ STN-1\nСтатус: подписано обеими сторонами 01.03.2026.')).toMatchObject({ needs_review: true });
  });
});
