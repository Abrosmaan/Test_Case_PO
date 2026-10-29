import type { Paragraph } from './types.js';

const CLAUSE_RE = /^(?:п\.\s*)?(\d+(?:\.\d+)*)\.\s/u;
/**
 * Where a new paragraph starts inside one physical line (a contract saved without line breaks):
 * before «Дата:» / «Статус:» header fields, and before a clause number that follows the end of a sentence.
 */
const SPLIT_RE = /(?<=[.»;])\s+(?=(?:п\.\s*)?\d+(?:\.\d+)*\.\s+\p{Lu})|\s+(?=(?:Дата|Статус)\s*:)/gu;

/** A paragraph is a non-empty line, or a part of a long line split at clause numbers. Offsets point into `text` exactly. */
export function segment(text: string): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  let offset = 0;
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    const lineStart = offset;
    offset += line.length + 1;
    const cuts = [0, ...[...line.matchAll(SPLIT_RE)].map((m) => m.index! + m[0].length), line.length];
    for (let k = 0; k < cuts.length - 1; k++) {
      const piece = line.slice(cuts[k], cuts[k + 1]);
      const lead = piece.length - piece.trimStart().length;
      const body = piece.trim();
      if (body === '') continue;
      const start = lineStart + cuts[k]! + lead;
      paragraphs.push({ clause_no: CLAUSE_RE.exec(body)?.[1] ?? null, line_no: i + 1, start, end: start + body.length, text: body });
    }
  });
  return paragraphs;
}
