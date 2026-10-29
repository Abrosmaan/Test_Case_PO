import { config } from '../config.js';
import type { DocType } from '../pipeline/classify.js';
import type { Paragraph } from '../pipeline/types.js';
import type { Segment } from './types.js';

const REPLACE = new RegExp(config.extract.replaceClause, 'u');

/**
 * What extractors see:
 * - amendment: only the new wording of replaced clauses (the rest of an amendment does not change terms);
 * - everything else: every paragraph.
 */
export function buildSegments(docType: DocType, paragraphs: Paragraph[]): Segment[] {
  if (docType !== 'amendment') {
    return paragraphs.map((p) => ({ text: p.text, start: p.start, paragraph_id: p.id ?? null, clause_no: p.clause_no, replaces_clause: null }));
  }
  const out: Segment[] = [];
  for (const p of paragraphs) {
    const m = REPLACE.exec(p.text);
    if (!m) continue;
    const inner = m[2]!;
    const offset = m.index + m[0].length - 1 - inner.length; // position of the inner text inside p.text
    out.push({ text: inner, start: p.start + offset, paragraph_id: p.id ?? null, clause_no: p.clause_no, replaces_clause: m[1]! });
  }
  return out;
}
