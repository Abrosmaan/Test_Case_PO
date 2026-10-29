import type { FactField, Fact, FieldName, NoData, Segment } from './types.js';

export function stopWordIn(text: string, words: readonly string[]): string | null {
  const lower = text.toLowerCase();
  return words.find((w) => lower.includes(w)) ?? null;
}

/** Quote = the whole segment, so `source.slice(start, end) === quote` always holds. */
export function fact(field: FactField, seg: Segment, value: string, display: string, rule_id: string): Fact {
  return {
    field, kind: 'fact', value, display, rule_id,
    quote: seg.text, start: seg.start, end: seg.start + seg.text.length,
    paragraph_id: seg.paragraph_id, replaces_clause: seg.replaces_clause,
  };
}

export function noData(field: FieldName, seg: Segment, reason: string, rule_id: string): NoData {
  return {
    field, kind: 'no_data', reason, rule_id,
    quote: seg.text, start: seg.start, end: seg.start + seg.text.length, paragraph_id: seg.paragraph_id,
  };
}

export function formatRub(n: number): string {
  const frac = Number.isInteger(n) ? 0 : 2;
  return `${n.toLocaleString('ru-RU', { minimumFractionDigits: frac, maximumFractionDigits: frac }).replace(/ | /g, ' ')} ₽`;
}
