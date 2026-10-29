import { config } from '../config.js';
import type { ExtractResult, Extractor } from './types.js';
import { fact } from './util.js';

const RE = new RegExp(config.extract.supplier, 'u');

export const supplier: Extractor = {
  field: 'supplier',
  label: 'Поставщик',
  extract(segments) {
    const out: ExtractResult = { facts: [], noData: [], rejected: [] };
    for (const seg of segments) {
      const m = RE.exec(seg.text);
      if (m) out.facts.push(fact('supplier', seg, m[1]!.trim(), m[1]!.trim(), 'supplier.label'));
    }
    return out;
  },
};
