import type { Paragraph } from './types.js';

const CLAUSE_RE = /^(\d+(?:\.\d+)*)\.\s/;

/** One non-empty line = one paragraph. Offsets point into `text` exactly. */
export function segment(text: string): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  let offset = 0;
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    const lineStart = offset;
    offset += line.length + 1;
    const lead = line.length - line.trimStart().length;
    const body = line.trim();
    if (body === '') return;
    const start = lineStart + lead;
    paragraphs.push({
      clause_no: CLAUSE_RE.exec(body)?.[1] ?? null,
      line_no: i + 1,
      start,
      end: start + body.length,
      text: body,
    });
  });
  return paragraphs;
}
