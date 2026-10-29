import type { Db } from '../db.js';
import { extractors } from '../extractors/index.js';
import type { FieldName } from '../extractors/types.js';
import { formatDate } from './text.js';

interface DocRow {
  id: number; filename: string; doc_type: string; doc_no: string | null; contract_no: string | null;
  sign_status: string; doc_date: string | null; signed_date: string | null; effective_date: string | null;
  needs_review: number; review_reason: string | null; classified_by: string | null; llm_suggestion: string | null;
}
interface FactRow {
  id: number; document_id: number; paragraph_id: number | null; field: FieldName; kind: 'fact' | 'no_data';
  value: string | null; display: string | null; quote: string; start: number; end: number;
  rule_id: string; replaces_clause: string | null; reason: string | null;
}

export type FieldStatus = 'active' | 'amended' | 'no_data' | 'needs_review';

export interface SourceRef {
  fact_id: number; document_id: number; filename: string; doc_label: string;
  paragraph_id: number | null; quote: string; start: number; end: number; rule_id: string;
}
export interface ChainStep { display: string; label: string; source: SourceRef }
export interface Proposal { field: FieldName; display: string; reason: string; source: SourceRef }
export interface ResolvedField {
  value: string | null;
  display: string;
  status: FieldStatus;
  status_label: string;
  reason: string | null;
  source: SourceRef | null;
  /** «было в договоре → изменено ДС №1» */
  chain: ChainStep[];
}
export interface ResolvedContract {
  contract_no: string;
  document_id: number;
  fields: Record<FieldName, ResolvedField>;
  proposals: Proposal[];
  needs_review: boolean;
  review_reasons: string[];
}
export interface Decision { contract_no: string; document_id: number; filename: string; applied: boolean; reason: string }
export interface Resolution {
  check_date: string;
  contracts: ResolvedContract[];
  unlinked: { document_id: number; filename: string; doc_type: string; contract_no: string | null; reason: string }[];
  decisions: Decision[];
}

const TYPE_LABEL: Record<string, string> = { contract: 'Договор', amendment: 'ДС', draft: 'Проект ДС', letter: 'Письмо', unknown: 'Документ' };

function docLabel(d: DocRow): string {
  return d.doc_type === 'contract' ? `Договор ${d.contract_no}` : `${TYPE_LABEL[d.doc_type] ?? 'Документ'}${d.doc_no ? ` №${d.doc_no}` : ''}`;
}

function ref(f: FactRow, d: DocRow): SourceRef {
  return { fact_id: f.id, document_id: d.id, filename: d.filename, doc_label: docLabel(d), paragraph_id: f.paragraph_id, quote: f.quote, start: f.start, end: f.end, rule_id: f.rule_id };
}

/** Why a linked non-contract document does not change terms on the check date (null = it does). */
function notApplicable(d: DocRow, checkDate: string): string | null {
  if (d.doc_type === 'letter') return 'письмо — предложение, не согласовано';
  if (d.doc_type === 'draft') return 'проект ДС, не подписан';
  if (d.doc_type !== 'amendment') return 'тип документа не распознан';
  if (d.needs_review) return `требует проверки: ${d.review_reason}`;
  if (d.sign_status !== 'signed_both') return 'ДС не подписано обеими сторонами';
  if (!d.effective_date) return 'у ДС нет даты вступления в силу';
  if (d.effective_date > checkDate) return `вступает в силу ${formatDate(d.effective_date)} — позже даты проверки`;
  return null;
}

/** Current terms of every loaded contract on `checkDate`. File names and upload order never matter. */
export function resolve(db: Db, checkDate: string): Resolution {
  const docs = db.prepare('select * from documents').all() as unknown as DocRow[];
  const facts = db.prepare('select * from facts order by document_id, start').all() as unknown as FactRow[];
  const byDoc = new Map<number, FactRow[]>();
  for (const f of facts) byDoc.set(f.document_id, [...(byDoc.get(f.document_id) ?? []), f]);

  const contractDocs = new Map<string, DocRow[]>();
  // Only rule-classified documents take part; LLM suggestions wait for a person (see `unlinked`).
  const ruled = docs.filter((d) => d.classified_by !== 'llm');
  for (const d of ruled) if (d.doc_type === 'contract' && d.contract_no) contractDocs.set(d.contract_no, [...(contractDocs.get(d.contract_no) ?? []), d]);

  const decisions: Decision[] = [];
  const contracts: ResolvedContract[] = [];

  for (const [contractNo, cDocs] of [...contractDocs].sort(([a], [b]) => a.localeCompare(b, 'ru', { numeric: true }))) {
    const review_reasons: string[] = [];
    if (cDocs.length > 1) review_reasons.push(`Загружено несколько текстов договора: ${cDocs.map((d) => d.filename).join(', ')}`);
    for (const d of cDocs) if (d.needs_review) review_reasons.push(`${d.filename}: ${d.review_reason}`);

    const fields = {} as Record<FieldName, ResolvedField>;
    for (const { field } of extractors) {
      const base = cDocs.flatMap((d) => (byDoc.get(d.id) ?? []).filter((f) => f.field === field).map((f) => ({ f, d })));
      const values = base.filter((x) => x.f.kind === 'fact');
      const distinct = new Set(values.map((x) => x.f.value));
      const first = values[0];
      if (distinct.size > 1) {
        fields[field] = {
          value: null, display: 'требует проверки', status: 'needs_review', status_label: 'требует проверки',
          reason: `В договоре несколько разных значений: ${values.map((x) => x.f.display).join(', ')}`,
          source: ref(first!.f, first!.d), chain: values.map((x) => ({ display: x.f.display!, label: docLabel(x.d), source: ref(x.f, x.d) })),
        };
      } else if (first) {
        fields[field] = {
          value: first.f.value, display: first.f.display!, status: 'active', status_label: 'действует', reason: null,
          source: ref(first.f, first.d), chain: [{ display: first.f.display!, label: `${docLabel(first.d)}, п. ${clauseOf(first.f, db) ?? '?'}`, source: ref(first.f, first.d) }],
        };
      } else {
        const nd = base.find((x) => x.f.kind === 'no_data');
        fields[field] = {
          value: null, display: 'нет данных', status: 'no_data', status_label: 'нет данных',
          reason: nd?.f.reason ?? 'значение не найдено в тексте договора',
          source: nd ? ref(nd.f, nd.d) : null, chain: [],
        };
      }
    }

    // Amendments applied in order of effective date; everything else becomes a proposal.
    const linked = ruled.filter((d) => d.doc_type !== 'contract' && d.contract_no === contractNo);
    const applicable: DocRow[] = [];
    const proposalsFrom: { d: DocRow; reason: string }[] = [];
    for (const d of linked) {
      const why = notApplicable(d, checkDate);
      decisions.push({ contract_no: contractNo, document_id: d.id, filename: d.filename, applied: why === null, reason: why ?? `подписано обеими сторонами, вступило в силу ${formatDate(d.effective_date!)}` });
      if (why === null) applicable.push(d);
      else proposalsFrom.push({ d, reason: why });
    }
    applicable.sort((a, b) => (a.effective_date! + a.signed_date).localeCompare(b.effective_date! + b.signed_date) || Number(a.doc_no) - Number(b.doc_no));

    for (const d of applicable) {
      for (const f of byDoc.get(d.id) ?? []) {
        if (f.kind !== 'fact' || !f.replaces_clause) continue;
        const cur = fields[f.field];
        if (cur.status === 'needs_review') continue;
        const label = `изменено ДС №${d.doc_no ?? '?'}`;
        fields[f.field] = {
          value: f.value, display: f.display!, status: 'amended', status_label: label, reason: null,
          source: ref(f, d), chain: [...cur.chain, { display: f.display!, label: `${docLabel(d)} (новая редакция п. ${f.replaces_clause})`, source: ref(f, d) }],
        };
      }
    }

    const proposals: Proposal[] = [];
    for (const { d, reason } of proposalsFrom) {
      for (const f of byDoc.get(d.id) ?? []) {
        if (f.kind !== 'fact' || f.value === fields[f.field].value) continue;
        proposals.push({ field: f.field, display: f.display!, reason, source: ref(f, d) });
      }
    }

    contracts.push({ contract_no: contractNo, document_id: cDocs[0]!.id, fields, proposals, needs_review: review_reasons.length > 0, review_reasons });
  }

  const unlinked = ruled
    .filter((d) => d.doc_type !== 'contract' && (!d.contract_no || !contractDocs.has(d.contract_no)))
    .map((d) => ({
      document_id: d.id, filename: d.filename, doc_type: d.doc_type, contract_no: d.contract_no,
      reason: d.doc_type === 'unknown' || !d.contract_no
        ? `требует проверки: ${d.review_reason ?? 'номер договора не найден'}`
        : `договор ${d.contract_no} не загружен`,
    }));
  for (const d of docs) if (d.classified_by === 'llm') unlinked.push({ document_id: d.id, filename: d.filename, doc_type: d.doc_type, contract_no: d.contract_no, reason: llmReason(d) });
  for (const d of ruled) if (d.doc_type === 'contract' && !d.contract_no) unlinked.push({ document_id: d.id, filename: d.filename, doc_type: d.doc_type, contract_no: null, reason: 'номер договора не найден' });

  return { check_date: checkDate, contracts, unlinked, decisions };
}

function llmReason(d: DocRow): string {
  const s = d.llm_suggestion ? (JSON.parse(d.llm_suggestion) as { model: string; quote: string }) : null;
  const what = `${TYPE_LABEL[d.doc_type] ?? 'Документ'}${d.contract_no ? ` к договору ${d.contract_no}` : ''}`;
  return `требует проверки: LLM (${s?.model ?? '?'}) предполагает «${what}» по цитате «${s?.quote ?? ''}»; в таблицу не попадает до подтверждения`;
}

function clauseOf(f: FactRow, db: Db): string | null {
  if (f.paragraph_id == null) return null;
  const row = db.prepare('select clause_no from paragraphs where id = ?').get(f.paragraph_id) as { clause_no: string | null } | undefined;
  return row?.clause_no ?? null;
}
