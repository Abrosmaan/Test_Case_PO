// Regressions for cases where the prototype used to show a confident but wrong value.
import { describe, expect, it } from 'vitest';
import { ingest } from '../src/pipeline/ingest.js';
import { normalizeContractNo } from '../src/pipeline/classify.js';
import { findContract } from '../src/pipeline/questions.js';
import { resolve } from '../src/pipeline/resolve.js';
import { runAll } from './helpers.js';

const CHECK = '2026-03-10';
const T = (filename: string, text: string) => ({ filename, buffer: Buffer.from(text) });
const contract = (no: string, opts: { status?: string; amount?: string; date?: string; title?: string } = {}) =>
  `${opts.title ?? `ДОГОВОР ПОСТАВКИ № ${no}`}\nСтатус: ${opts.status ?? 'подписан обеими сторонами 01.02.2026.'}\n`
  + `1.1. Поставщик: ООО «Тест».\n2.1. Общая стоимость поставки составляет ${opts.amount ?? '500 000 рублей'}.\n`
  + `3.1. Поставщик обязуется поставить товар не позднее ${opts.date ?? '15.04.2026'}.`;
const ds = (n: number, no: string, body: string, tail = '\n2. Настоящее соглашение вступает в силу 03.03.2026.') =>
  `ДОПОЛНИТЕЛЬНОЕ СОГЛАШЕНИЕ № ${n} К ДОГОВОРУ ${no}\nСтатус: подписано обеими сторонами 03.03.2026.\n1. ${body}${tail}`;
const run = (...files: ReturnType<typeof T>[]) => resolve(runAll(files).db, CHECK);

describe('amounts', () => {
  it('dot as thousands separator: 1.200.000,00 руб. → 1 200 000 ₽, not 0 ₽', () => {
    const c = findContract(run(T('a.txt', contract('STN-1', { amount: '1.200.000,00 руб. (один миллион двести тысяч рублей 00 копеек)' }))), 'STN-1')!;
    expect(c.fields.total_amount).toMatchObject({ value: '1200000', status: 'active' });
  });

  it('broken number «1 200 00 0 рублей» → needs review, never a tail like 0 ₽', () => {
    const c = findContract(run(T('a.txt', contract('STN-1', { amount: '1 200 00 0 (один миллион двести тысяч) рублей' }))), 'STN-1')!;
    expect(c.fields.total_amount).toMatchObject({ value: null, status: 'needs_review' });
    expect(c.fields.total_amount.reason).toContain('1 200 00 0');
  });

  it('no roubles at all («по спецификации») stays an honest «нет данных»', () => {
    const c = findContract(run(T('a.txt', contract('STN-1', { amount: 'по спецификации в приложении № 1' }))), 'STN-1')!;
    expect(c.fields.total_amount.status).toBe('no_data');
  });
});

describe('contract numbers', () => {
  it('«STN-7O9» (letter O) is not cut to «STN-7»; kept as written and flagged', () => {
    const res = run(T('a.txt', contract('STN-7O9')));
    expect(res.contracts.map((c) => c.contract_no)).toEqual(['STN-7O9']);
    expect(res.contracts[0]!.review_reasons.join()).toMatch(/не соответствует шаблону/);
  });

  it('«STN 705» → STN-705 with a review flag, not «STN»', () => {
    const res = run(T('a.txt', contract('STN 705')));
    expect(res.contracts.map((c) => [c.contract_no, c.needs_review])).toEqual([['STN-705', true]]);
  });

  it('Cyrillic Т in an amendment links it to STN-704, but the change is not applied silently', () => {
    const res = run(T('c.txt', contract('STN-704', { amount: '2 900 000 рублей' })),
      T('d.txt', ds(1, 'SТN-704', 'Пункт 2.1 договора изложить в следующей редакции: «Общая стоимость поставки составляет 3 050 000 рублей»')));
    expect(res.contracts.map((c) => c.contract_no)).toEqual(['STN-704']);
    const c = res.contracts[0]!;
    expect(c.fields.total_amount).toMatchObject({ status: 'needs_review', display: '2 900 000 ₽' });
    expect(c.proposals.map((p) => p.display)).toEqual(['3 050 000 ₽']);
  });

  it('homoglyph normalisation only touches mixed-script numbers', () => {
    expect(normalizeContractNo('SТN-704')).toBe('STN-704');
    expect(normalizeContractNo('ДП-12')).toBe('ДП-12');
    expect(normalizeContractNo('STN-704')).toBe('STN-704');
  });

  it('two contracts in one file → flagged, values do not pass as certain', () => {
    const res = run(T('a.txt', `${contract('STN-602')}\n\n────\n\n${contract('STN-603', { amount: '275 000 рублей', date: '19.04.2026' })}`));
    const c = res.contracts[0]!;
    expect(c.review_reasons.join()).toMatch(/несколько договоров: STN-602, STN-603/);
    expect([c.fields.total_amount.status, c.fields.delivery_date.status]).toEqual(['needs_review', 'needs_review']);
  });
});

describe('contract and amendment status', () => {
  it('unsigned contract → its values are draft values, needs review', () => {
    const c = findContract(run(T('a.txt', contract('STN-1', { status: 'проект, не подписан сторонами.' }))), 'STN-1')!;
    expect([c.fields.total_amount.status, c.fields.delivery_date.status]).toEqual(['needs_review', 'needs_review']);
    expect(c.fields.total_amount.display).toBe('500 000 ₽');
  });

  it('signed amendment without an effective date → the field it changes needs review', () => {
    const c = findContract(run(T('c.txt', contract('STN-1')),
      T('d.txt', ds(1, 'STN-1', 'Пункт 2.1 договора изложить в следующей редакции: «Общая стоимость поставки составляет 600 000 рублей»', ''))), 'STN-1')!;
    expect(c.fields.total_amount).toMatchObject({ status: 'needs_review', display: '500 000 ₽' });
    expect(c.fields.delivery_date.status).toBe('active');
  });

  it('«ПРОЕКТ» in the title but «подписано» in the status → the field it changes needs review', () => {
    const draft = ds(1, 'STN-1', 'Пункт 2.1 договора изложить в следующей редакции: «Общая стоимость поставки составляет 640 000 рублей»')
      .replace('ДОПОЛНИТЕЛЬНОЕ СОГЛАШЕНИЕ', 'ПРОЕКТ ДОПОЛНИТЕЛЬНОГО СОГЛАШЕНИЯ');
    const c = findContract(run(T('c.txt', contract('STN-1')), T('d.txt', draft)), 'STN-1')!;
    expect(c.fields.total_amount.status).toBe('needs_review');
  });

  it('two amendments in force on the same day with different values → needs review, not «the last file»', () => {
    const rewrite = (sum: string) => `Пункт 2.1 договора изложить в следующей редакции: «Общая стоимость поставки составляет ${sum} рублей»`;
    const c = findContract(run(T('c.txt', contract('STN-1')), T('d1.txt', ds(1, 'STN-1', rewrite('810 000'))), T('d2.txt', ds(2, 'STN-1', rewrite('830 000')))), 'STN-1')!;
    expect(c.fields.total_amount.status).toBe('needs_review');
    expect(c.fields.total_amount.reason).toMatch(/в один день.*810 000 ₽ и 830 000 ₽/);
  });

  it('«В пункте 3.1 слова «15.04.2026» заменить словами «22.04.2026»» → delivery date needs review', () => {
    const c = findContract(run(T('c.txt', contract('STN-1')), T('d.txt', ds(1, 'STN-1', 'В пункте 3.1 договора слова «15.04.2026» заменить словами «22.04.2026».'))), 'STN-1')!;
    expect(c.fields.delivery_date).toMatchObject({ status: 'needs_review', display: '15.04.2026' });
    expect(c.fields.total_amount.status).toBe('active');
  });
});

describe('ingest', () => {
  it('PNG renamed to .txt (no NUL bytes in the header) is rejected', () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('"'.repeat(64))]);
    expect(ingest('image.txt', png)).toMatchObject({ ok: false, rule_id: 'ingest.binary' });
  });

  it('tabs and form feeds in a real text file are fine', () => {
    expect(ingest('a.txt', Buffer.from('ДОГОВОР\tПОСТАВКИ\n\f2.1. Текст'))).toMatchObject({ ok: true });
  });
});
