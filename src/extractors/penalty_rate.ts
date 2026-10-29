import { config } from '../config.js';
import type { ExtractResult, Extractor } from './types.js';
import { fact, noData } from './util.js';

const C = config.extract.penaltyRate;
const TRIGGER = new RegExp(C.trigger, 'iu');
const PERCENT = new RegExp(C.percent, 'gu');
const PER_DAY = new RegExp(C.perDay, 'iu');
const CAP = new RegExp(C.cap, 'iu');

const pct = (s: string) => s.replace(',', '.');
const show = (s: string) => s.replace('.', ',');

export const penaltyRate: Extractor = {
  field: 'penalty_rate',
  label: 'Неустойка',
  extract(segments) {
    const out: ExtractResult = { facts: [], noData: [], rejected: [] };
    for (const seg of segments) {
      if (!TRIGGER.test(seg.text)) continue;
      const cap = CAP.exec(seg.text);
      const capEnd = cap ? cap.index + cap[0].length : -1;
      // The rate is the first percent that is not the "не более N%" cap.
      const rate = [...seg.text.matchAll(PERCENT)].find((m) => m.index! + m[0].length !== capEnd);
      if (!rate) {
        out.noData.push(noData('penalty_rate', seg, seg.text, 'penalty.trigger_without_value'));
        continue;
      }
      const value = pct(rate[1]!);
      const display = `${show(value)}%${PER_DAY.test(seg.text) ? ' в день' : ''}${cap ? ` (не более ${show(pct(cap[1]!))}%)` : ''}`;
      out.facts.push(fact('penalty_rate', seg, value, display, 'penalty.rate'));
    }
    return out;
  },
};
