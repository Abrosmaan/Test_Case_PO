import { config } from '../config.js';
import type { ExtractResult, Extractor } from './types.js';
import { fact, formatRub, noData, stopWordIn } from './util.js';

const C = config.extract.amount;
const MONEY = new RegExp(C.money, 'gu');
const TRIGGER = new RegExp(C.trigger, 'iu');

export const totalAmount: Extractor = {
  field: 'total_amount',
  label: 'Сумма',
  extract(segments) {
    const out: ExtractResult = { facts: [], noData: [], rejected: [] };
    for (const seg of segments) {
      const amounts = [...seg.text.matchAll(MONEY)];
      const trigger = TRIGGER.test(seg.text);
      const stop = stopWordIn(seg.text, C.stopWords);

      for (const m of amounts) {
        const rub = Number(m[1]!.replace(/[  ]/g, '')) + Number(m[2] ?? 0) / 100;
        if (stop) {
          out.rejected.push({ field: 'total_amount', candidate: formatRub(rub), reason: `«${stop}» — не общая стоимость`, rule_id: 'amount.stop_word', quote: seg.text });
        } else if (!trigger) {
          out.rejected.push({ field: 'total_amount', candidate: formatRub(rub), reason: 'нет формулировки «общая стоимость»', rule_id: 'amount.no_trigger', quote: seg.text });
        } else {
          out.facts.push(fact('total_amount', seg, String(rub), formatRub(rub), 'amount.total'));
          break; // first amount in a "total cost" clause; the rest is usually the same sum in words
        }
      }
      if (trigger && !stop && amounts.length === 0) {
        out.noData.push(noData('total_amount', seg, seg.text, 'amount.trigger_without_value'));
      }
    }
    return out;
  },
};
