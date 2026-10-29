import { config } from '../config.js';
import { DATE_SRC, formatDate, toIsoDate } from '../pipeline/text.js';
import type { ExtractResult, Extractor } from './types.js';
import { fact, stopWordIn } from './util.js';

const C = config.extract.deliveryDate;
const DATE = new RegExp(DATE_SRC, 'gu');
const RULES = [
  { rule_id: 'delivery.deadline', re: new RegExp(`(${C.deadline})${DATE_SRC}`, 'giu') },
  { rule_id: 'delivery.change', re: new RegExp(`(${C.change.replace('DATE', DATE_SRC.replace(/\(/g, '(?:'))})${DATE_SRC}`, 'giu') },
];
const CONTEXT = new RegExp(C.context, 'iu');
const EXTRA = new RegExp(`(${C.extraDeadline})${DATE_SRC}`, 'giu');

export const deliveryDate: Extractor = {
  field: 'delivery_date',
  label: 'Срок поставки',
  extract(segments) {
    const out: ExtractResult = { facts: [], noData: [], rejected: [] };
    for (const seg of segments) {
      if (!CONTEXT.test(seg.text)) continue;
      const accepted = new Set<number>(); // index of the accepted date inside seg.text
      const stop = stopWordIn(seg.text, C.stopWords);

      if (!stop) {
        for (const { rule_id, re } of RULES) {
          for (const m of seg.text.matchAll(re)) {
            const iso = toIsoDate(m[2]!, m[3]!, m[4]!);
            if (!iso) continue;
            accepted.add(m.index! + m[1]!.length);
            out.facts.push(fact('delivery_date', seg, iso, formatDate(iso), rule_id));
          }
        }
        // Staged delivery: «первую партию не позднее A, вторую не позднее B» — every deadline counts,
        // so the resolver sees several values and asks for review instead of silently taking the first.
        if (accepted.size > 0) {
          for (const m of seg.text.matchAll(EXTRA)) {
            const at = m.index! + m[1]!.length;
            const iso = toIsoDate(m[2]!, m[3]!, m[4]!);
            if (!iso || accepted.has(at)) continue;
            accepted.add(at);
            out.facts.push(fact('delivery_date', seg, iso, formatDate(iso), 'delivery.extra_deadline'));
          }
        }
      }
      for (const m of seg.text.matchAll(DATE)) {
        if (accepted.has(m.index!)) continue;
        out.rejected.push({
          field: 'delivery_date', candidate: m[0], quote: seg.text,
          rule_id: stop ? 'delivery.stop_word' : 'delivery.no_rule',
          reason: stop ? `«${stop}» — не срок поставки` : 'дата не в формулировке «поставить … не позднее» / «срок поставки … на»',
        });
      }
    }
    return out;
  },
};
