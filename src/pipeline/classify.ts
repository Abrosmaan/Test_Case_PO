import { config } from '../config.js';
import { findDateAfter } from './text.js';
import type { Paragraph } from './types.js';

export type DocType = 'contract' | 'amendment' | 'draft' | 'letter' | 'unknown';
export type SignStatus = 'signed_both' | 'unsigned' | 'unknown';

export interface Classification {
  doc_type: DocType;
  doc_no: string | null;
  contract_no: string | null;
  sign_status: SignStatus;
  doc_date: string | null;
  signed_date: string | null;
  effective_date: string | null;
  needs_review: boolean;
  review_reasons: string[];
  /** Why each attribute was set: rule, paragraph line and quote. */
  evidence: { attr: string; rule_id: string; line_no: number; quote: string }[];
}

const C = config.classify;
const CONTRACT_NO = new RegExp(config.contractNo, 'gu');

export function classify(paragraphs: Paragraph[]): Classification {
  const r: Classification = {
    doc_type: 'unknown', doc_no: null, contract_no: null, sign_status: 'unknown',
    doc_date: null, signed_date: null, effective_date: null,
    needs_review: false, review_reasons: [], evidence: [],
  };
  const review = (reason: string) => { r.needs_review = true; r.review_reasons.push(reason); };
  const title = paragraphs[0];
  if (!title) return review('Нет текста'), r;

  // Type — by title only.
  for (const t of C.titles) {
    const m = new RegExp(t.re, 'u').exec(title.text);
    if (m) {
      r.doc_type = t.type as DocType;
      r.evidence.push({ attr: 'doc_type', rule_id: t.rule_id, line_no: title.line_no, quote: m[0] });
      break;
    }
  }
  if (r.doc_type === 'unknown') review('Тип документа не распознан по заголовку');

  // Document number (contract number for contracts, amendment number for amendments/drafts).
  const noMatch = new RegExp(C.docNo, 'u').exec(title.text);
  const titleContractNos = [...title.text.matchAll(CONTRACT_NO)].map((m) => m[0]);
  if (r.doc_type === 'contract') {
    r.contract_no = titleContractNos[0] ?? noMatch?.[1] ?? null;
    r.doc_no = r.contract_no;
  } else if (r.doc_type === 'amendment' || r.doc_type === 'draft') {
    r.doc_no = noMatch?.[1] ?? null;
  }

  // Contract reference for non-contracts: all contract numbers in the text must agree.
  if (r.doc_type !== 'contract') {
    const all = new Set(paragraphs.flatMap((p) => [...p.text.matchAll(CONTRACT_NO)].map((m) => m[0])));
    if (all.size === 1) r.contract_no = [...all][0]!;
    else if (all.size > 1) review(`Упомянуто несколько договоров: ${[...all].join(', ')}`);
  }
  if (r.contract_no) {
    const p = paragraphs.find((x) => x.text.includes(r.contract_no!))!;
    r.evidence.push({ attr: 'contract_no', rule_id: 'classify.contract_no', line_no: p.line_no, quote: r.contract_no });
  } else review('Номер договора не найден в тексте');

  for (const p of paragraphs.slice(0, 8)) {
    const d = findDateAfter(p.text, C.docDate);
    if (d && !r.doc_date) {
      r.doc_date = d.iso;
      r.evidence.push({ attr: 'doc_date', rule_id: 'classify.doc_date', line_no: p.line_no, quote: d.quote });
    }
  }

  // Signing status — from the "Статус:" line.
  const status = paragraphs.find((p) => new RegExp(C.statusLine, 'iu').test(p.text));
  if (status) {
    const signed = findDateAfter(status.text, C.signedBoth);
    const unsigned = new RegExp(C.unsigned, 'iu').exec(status.text);
    if (signed && unsigned) {
      review('Противоречивый статус: одновременно «подписан» и «не подписан/проект»');
    } else if (signed) {
      r.sign_status = 'signed_both';
      r.signed_date = signed.iso;
      r.evidence.push({ attr: 'sign_status', rule_id: 'classify.status.signed_both', line_no: status.line_no, quote: signed.quote });
    } else if (unsigned) {
      r.sign_status = 'unsigned';
      r.evidence.push({ attr: 'sign_status', rule_id: 'classify.status.unsigned', line_no: status.line_no, quote: unsigned[0] });
    } else review('Строка статуса не распознана');
  }
  if (r.doc_type === 'draft' && r.sign_status === 'signed_both') review('Заголовок «проект», но статус «подписан»');
  if ((r.doc_type === 'contract' || r.doc_type === 'amendment') && r.sign_status === 'unknown' && !r.review_reasons.some((x) => x.startsWith('Противоречивый'))) {
    review('Статус подписания не указан');
  }

  // Effective date — amendments.
  for (const p of paragraphs) {
    const d = findDateAfter(p.text, C.effective);
    if (d) {
      r.effective_date = d.iso;
      r.evidence.push({ attr: 'effective_date', rule_id: 'classify.effective_date', line_no: p.line_no, quote: d.quote });
      break;
    }
  }
  if (r.doc_type === 'amendment' && r.sign_status === 'signed_both' && !r.effective_date) {
    review('Подписанное ДС без даты вступления в силу');
  }

  return r;
}
