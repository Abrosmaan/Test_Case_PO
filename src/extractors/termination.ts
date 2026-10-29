import { config } from '../config.js';
import { DATE_SRC, formatDate, toIsoDate } from '../pipeline/text.js';
import type { Fact, Segment } from './types.js';
import { fact } from './util.js';

const C = config.extract.termination;
const TRIGGER = new RegExp(C.trigger, 'iu');
const DATED = new RegExp(`(${C.date})${DATE_SRC}`, 'iu');

/**
 * Contract termination is an event, not a table column: value = ISO date from «с DATE»,
 * or '' when the text gives none (the resolver then uses the amendment's effective date).
 */
export function detectTermination(segments: Segment[]): Fact[] {
  const out: Fact[] = [];
  for (const seg of segments) {
    if (!TRIGGER.test(seg.text)) continue;
    const m = DATED.exec(seg.text);
    const iso = m ? toIsoDate(m[2]!, m[3]!, m[4]!) : null;
    out.push(fact('termination', seg, iso ?? '', iso ? `расторжение с ${formatDate(iso)}` : 'расторжение', iso ? 'termination.dated' : 'termination.undated'));
  }
  return out;
}
