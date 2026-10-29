import { describe, expect, it } from 'vitest';
import { penaltyRate } from '../src/extractors/penalty_rate.js';
import { buildSegments } from '../src/extractors/segments.js';
import { findContract } from '../src/pipeline/questions.js';
import { resolve } from '../src/pipeline/resolve.js';
import { segment } from '../src/pipeline/segment.js';
import { loadDir, runAll } from './helpers.js';

const CHECK = '2026-03-10';
const run = (text: string) => penaltyRate.extract(buildSegments('contract', segment(text)));

describe('penalty_rate (meeting scenario: add a field)', () => {
  const res = resolve(runAll().db, CHECK);
  const f = (no: string) => findContract(res, no)!.fields.penalty_rate;

  it('reference files', () => {
    expect([f('STN-101').display, f('STN-101').status_label]).toEqual(['0,1% в день (не более 10%)', 'действует']);
    expect(f('STN-102').display).toBe('0,05% в день (не более 5%)');
    expect([f('STN-103').status, f('STN-103').reason]).toEqual(['no_data', '4.1. Ставка неустойки в тексте договора не установлена.']);
  });

  it('"размер неустойки без изменений" in amendment 1 does not change it', () => {
    expect(findContract(res, 'STN-101')!.proposals.filter((p) => p.field === 'penalty_rate')).toEqual([]);
  });

  it('cap before the rate is not taken as the rate', () => {
    expect(run('4.1. Пеня, но не более 5% цены, составляет 0,2% за каждый день.').facts[0]).toMatchObject({ value: '0.2', display: '0,2% в день (не более 5%)' });
  });

  it('signed amendment with new wording of 4.1 changes it; mutated contract changes it', () => {
    const files = loadDir();
    const contract = files.find((x) => x.filename === '01_contract.txt')!;
    const mutated = { filename: '01_contract.txt', buffer: Buffer.from(contract.buffer.toString('utf-8').replace('0,1%', '0,3%')) };
    const amendment = {
      filename: 'ds3.txt',
      buffer: Buffer.from('ДОПОЛНИТЕЛЬНОЕ СОГЛАШЕНИЕ № 3 К ДОГОВОРУ STN-101\nСтатус: подписано обеими сторонами 02.03.2026.\n'
        + '1. Пункт 4.1 договора изложить в следующей редакции: «Неустойка за просрочку поставки составляет 0,2% за каждый день»\n'
        + '2. Настоящее соглашение вступает в силу 02.03.2026.'),
    };
    const rest = files.filter((x) => x !== contract);

    const m = findContract(resolve(runAll([mutated, ...rest]).db, CHECK), 'STN-101')!.fields.penalty_rate;
    expect(m.display).toBe('0,3% в день (не более 10%)');

    const a = findContract(resolve(runAll([...files, amendment]).db, CHECK), 'STN-101')!.fields.penalty_rate;
    expect([a.display, a.status_label]).toEqual(['0,2% в день', 'изменено ДС №3']);
  });
});

describe('reprocessAll', () => {
  it('re-extracts stored documents with the current extractors', async () => {
    const { reprocessAll } = await import('../src/pipeline/process.js');
    const ctx = runAll();
    ctx.db.exec("delete from facts where field = 'penalty_rate'"); // as if stored before the extractor existed
    expect(findContract(resolve(ctx.db, CHECK), 'STN-101')!.fields.penalty_rate.status).toBe('no_data');
    reprocessAll(ctx);
    expect(findContract(resolve(ctx.db, CHECK), 'STN-101')!.fields.penalty_rate.display).toBe('0,1% в день (не более 10%)');
  });
});
