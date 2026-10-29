import { config } from '../config.js';
import type { Db } from '../db.js';
import { extractors } from '../extractors/index.js';
import type { FieldName } from '../extractors/types.js';
import { formatDate } from './text.js';

interface DocRow {
  id: number; filename: string; doc_type: string; doc_no: string | null; contract_no: string | null;
  sign_status: string; doc_date: string | null; signed_date: string | null; effective_date: string | null;
  needs_review: number; review_reason: string | null; classified_by: string | null; llm_suggestion: string | null;
  llm_status: string | null;
}
interface FactRow {
  id: number; document_id: number; paragraph_id: number | null; field: string; kind: 'fact' | 'no_data';
  value: string | null; display: string | null; quote: string; start: number; end: number;
  rule_id: string; replaces_clause: string | null; reason: string | null;
}
interface ParagraphRow { id: number; document_id: number; clause_no: string | null; start: number; end: number; text: string }

export type FieldStatus = 'active' | 'amended' | 'no_data' | 'needs_review';

export interface SourceRef {
  fact_id: number | null; document_id: number; filename: string; doc_label: string;
  paragraph_id: number | null; quote: string; start: number; end: number; rule_id: string;
}
export interface ChainStep { display: string; label: string; source: SourceRef }
export interface Proposal { field: FieldName; display: string; reason: string; source: SourceRef }
/** A linked letter, draft or not-applied amendment with nothing to propose — still worth seeing. */
export interface Note { document_id: number; doc_label: string; doc_date: string | null; reason: string; source: SourceRef }
export interface Termination { date: string; display: string; in_force: boolean; source: SourceRef }
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
  /** active — действует; terminated — расторгнут на дату проверки. */
  status: 'active' | 'terminated';
  status_label: string;
  termination: Termination | null;
  fields: Record<FieldName, ResolvedField>;
  proposals: Proposal[];
  notes: Note[];
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
const REPLACE = new RegExp(config.extract.replaceClause, 'u');
const TERMINATION = new RegExp(config.extract.termination.trigger, 'iu');
const BOILERPLATE = new RegExp(config.extract.amendmentBoilerplate, 'iu');
const CLAUSE_REF = /пункт\p{L}*\s+(\d+(?:\.\d+)+)/giu;
const FIELD_HINTS = Object.entries(config.extract.fieldHints).map(([f, re]) => [f as FieldName, new RegExp(re, 'iu')] as const);

function docLabel(d: DocRow): string {
  return d.doc_type === 'contract' ? `Договор ${d.contract_no}` : `${TYPE_LABEL[d.doc_type] ?? 'Документ'}${d.doc_no ? ` №${d.doc_no}` : ''}`;
}

function ref(f: FactRow, d: DocRow): SourceRef {
  return { fact_id: f.id, document_id: d.id, filename: d.filename, doc_label: docLabel(d), paragraph_id: f.paragraph_id, quote: f.quote, start: f.start, end: f.end, rule_id: f.rule_id };
}
function paraRef(p: ParagraphRow, d: DocRow, rule_id: string): SourceRef {
  return { fact_id: null, document_id: d.id, filename: d.filename, doc_label: docLabel(d), paragraph_id: p.id, quote: p.text, start: p.start, end: p.end, rule_id };
}
const isField = (f: string): f is FieldName => extractors.some((e) => e.field === f);

/** Why a linked non-contract document does not change terms on the check date (null = it does). */
function notApplicable(d: DocRow, checkDate: string): string | null {
  if (d.doc_type === 'letter') return 'письмо — предложение, не согласовано';
  if (d.doc_type === 'draft') return 'проект ДС, не подписан';
  if (d.doc_type !== 'amendment') return `тип документа не распознан${d.review_reason ? ` (${d.review_reason})` : ''}${d.llm_status === 'pending' ? ' — LLM проверяет…' : ''}`;
  if (d.needs_review) return `требует проверки: ${d.review_reason}`;
  if (d.sign_status !== 'signed_both') return 'ДС не подписано обеими сторонами';
  if (!d.effective_date) return 'у ДС нет даты вступления в силу';
  if (d.effective_date > checkDate) return `вступает в силу ${formatDate(d.effective_date)} — позже даты проверки`;
  return null;
}

function needsReview(cur: ResolvedField, reason: string, source: SourceRef): ResolvedField {
  // The last known value stays visible, but it is no longer presented as certain.
  return { ...cur, status: 'needs_review', status_label: 'требует проверки', reason, source, chain: cur.chain };
}

/** Current terms of every loaded contract on `checkDate`. File names and upload order never matter. */
export function resolve(db: Db, checkDate: string): Resolution {
  const docs = db.prepare('select * from documents').all() as unknown as DocRow[];
  const facts = db.prepare('select * from facts order by document_id, start').all() as unknown as FactRow[];
  const paragraphs = db.prepare('select id, document_id, clause_no, start, "end", text from paragraphs order by document_id, start').all() as unknown as ParagraphRow[];
  const byDoc = groupBy(facts, (f) => f.document_id);
  const parasByDoc = groupBy(paragraphs, (p) => p.document_id);
  const clauseOf = (f: FactRow) => paragraphs.find((p) => p.id === f.paragraph_id)?.clause_no ?? null;

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
    /** Clause of the contract each field's value came from: an amendment rewriting it must give a new value. */
    const fieldClause = new Map<FieldName, string | null>();
    for (const { field } of extractors) {
      const base = cDocs.flatMap((d) => (byDoc.get(d.id) ?? []).filter((f) => f.field === field).map((f) => ({ f, d })));
      const values = base.filter((x) => x.f.kind === 'fact');
      const distinct = [...new Set(values.map((x) => x.f.display!))];
      const first = values[0];
      if (first) fieldClause.set(field, clauseOf(first.f));
      if (distinct.length > 1) {
        fields[field] = {
          value: null, display: distinct.join(' / '), status: 'needs_review', status_label: 'требует проверки',
          reason: `В договоре несколько разных значений: ${distinct.join(', ')} — например, поэтапная поставка. Какое считать, решает человек.`,
          source: ref(first!.f, first!.d), chain: values.map((x) => ({ display: x.f.display!, label: docLabel(x.d), source: ref(x.f, x.d) })),
        };
      } else if (first) {
        fields[field] = {
          value: first.f.value, display: first.f.display!, status: 'active', status_label: 'действует', reason: null,
          source: ref(first.f, first.d), chain: [{ display: first.f.display!, label: `${docLabel(first.d)}, п. ${clauseOf(first.f) ?? '?'}`, source: ref(first.f, first.d) }],
        };
      } else {
        const nd = base.find((x) => x.f.kind === 'no_data');
        // The value is in the text but broken («1 200 00 0 рублей») — not the same as «нет данных».
        const unparsed = nd?.f.rule_id.endsWith('.unparsed');
        fields[field] = {
          value: null, display: unparsed ? 'требует проверки' : 'нет данных', status: unparsed ? 'needs_review' : 'no_data',
          status_label: unparsed ? 'требует проверки' : 'нет данных',
          reason: unparsed ? `значение в тексте не распознано: «${nd!.f.reason}»` : nd?.f.reason ?? 'значение не найдено в тексте договора',
          source: nd ? ref(nd.f, nd.d) : null, chain: [],
        };
      }
    }

    // A contract not signed by both parties gives no terms in force: its values are only a draft.
    const unsigned = cDocs.find((d) => d.sign_status !== 'signed_both');
    if (unsigned) {
      for (const { field } of extractors) {
        const cur = fields[field];
        if (cur.status === 'active' && cur.source) {
          fields[field] = needsReview(cur, `Договор не подписан обеими сторонами (${unsigned.review_reason ?? 'статус: не подписан'}) — значение проектное`, cur.source);
        }
      }
      review_reasons.push(`${unsigned.filename}: договор не подписан обеими сторонами`);
    }

    // Amendments applied in order of effective date; everything else becomes a proposal or a note.
    const linked = ruled.filter((d) => d.doc_type !== 'contract' && d.contract_no === contractNo);
    const applicable: DocRow[] = [];
    const notApplied: { d: DocRow; reason: string }[] = [];
    for (const d of linked) {
      const why = notApplicable(d, checkDate);
      if (why === null) applicable.push(d);
      else notApplied.push({ d, reason: why });
    }
    applicable.sort((a, b) => (a.effective_date! + a.signed_date).localeCompare(b.effective_date! + b.signed_date) || Number(a.doc_no) - Number(b.doc_no));

    let termination: Termination | null = null;
    /** Which amendment set each field last, to catch two amendments in force on the same day disagreeing. */
    const setBy = new Map<FieldName, { d: DocRow; display: string }>();
    for (const d of applicable) {
      const dFacts = byDoc.get(d.id) ?? [];
      const label = `изменено ДС №${d.doc_no ?? '?'}`;
      const changes: string[] = [];

      // 1. «Пункт X.Y изложить в новой редакции»: one value per field, otherwise a person decides.
      const byField = groupBy(dFacts.filter((f) => f.kind === 'fact' && f.replaces_clause && isField(f.field)), (f) => f.field as FieldName);
      for (const [field, fs] of byField) {
        const cur = fields[field];
        const distinct = [...new Set(fs.map((f) => f.display!))];
        const prev = setBy.get(field);
        if (distinct.length > 1) {
          fields[field] = needsReview(cur, `${docLabel(d)} задаёт несколько значений: ${distinct.join(', ')}`, ref(fs[0]!, d));
        } else if (prev && prev.d.effective_date === d.effective_date && prev.display !== distinct[0]) {
          // Same effective date, different values: which one wins is a legal question, not «the last file».
          const why = `${docLabel(prev.d)} и ${docLabel(d)} вступают в силу в один день (${formatDate(d.effective_date!)}) и задают разные значения: ${prev.display} и ${distinct[0]}`;
          fields[field] = needsReview(cur, why, ref(fs[0]!, d));
          review_reasons.push(why);
        } else if (cur.status !== 'needs_review') {
          const f = fs[0]!;
          fields[field] = {
            value: f.value, display: f.display!, status: 'amended', status_label: label, reason: null,
            source: ref(f, d), chain: [...cur.chain, { display: f.display!, label: `${docLabel(d)} (новая редакция п. ${f.replaces_clause})`, source: ref(f, d) }],
          };
        }
        setBy.set(field, { d, display: distinct[0]! });
        changes.push(field);
      }

      // 2. Termination.
      const term = dFacts.find((f) => f.field === 'termination');
      if (term) {
        const date = term.value || d.effective_date!;
        termination = { date, display: `расторгнут с ${formatDate(date)}`, in_force: date <= checkDate, source: ref(term, d) };
        changes.push('termination');
      }

      // 3. Clauses the rules did not understand. Never apply silently: flag the fields they seem to touch.
      for (const p of (parasByDoc.get(d.id) ?? []).filter((p) => p.clause_no)) {
        const rep = REPLACE.exec(p.text);
        if (rep) {
          // New wording of a clause the value came from, but no value found in it.
          const lost = extractors.map((e) => e.field).filter((f) => fieldClause.get(f) === rep[1] && !byField.has(f));
          if (lost.length) {
            const why = `${docLabel(d)} излагает п. ${rep[1]} в новой редакции, но значение в ней не распознано: «${p.text}»`;
            review_reasons.push(why);
            for (const f of lost) fields[f] = needsReview(fields[f], why, paraRef(p, d, 'resolve.replaced_without_value'));
            changes.push('unrecognised');
          }
          continue;
        }
        if (TERMINATION.test(p.text) || BOILERPLATE.test(p.text)) continue;
        // Which field it touches: by the clause it names («в пункте 3.1 …») or by its words.
        const named = [...p.text.matchAll(CLAUSE_REF)].map((m) => m[1]);
        const hinted = [...new Set([
          ...extractors.map((e) => e.field).filter((f) => named.includes(fieldClause.get(f) ?? '')),
          ...FIELD_HINTS.filter(([, re]) => re.test(p.text)).map(([f]) => f),
        ])];
        const why = `${docLabel(d)} подписано и вступило в силу, но изменение в п. ${p.clause_no} не распознано: «${p.text}»`;
        review_reasons.push(why);
        for (const f of hinted) fields[f] = needsReview(fields[f], why, paraRef(p, d, 'resolve.unrecognised_change'));
        changes.push('unrecognised');
      }

      decisions.push({
        contract_no: contractNo, document_id: d.id, filename: d.filename, applied: true,
        reason: changes.length
          ? `подписано обеими сторонами, вступило в силу ${formatDate(d.effective_date!)}${changes.includes('unrecognised') ? '; часть изменений не распознана — требует проверки' : ''}`
          : `подписано и вступило в силу ${formatDate(d.effective_date!)}, но изменений не найдено`,
      });
      if (!changes.length) review_reasons.push(`${docLabel(d)} подписано и вступило в силу, но изменений условий в нём не найдено — проверьте вручную`);
    }

    const proposals: Proposal[] = [];
    const notes: Note[] = [];
    for (const { d, reason } of notApplied) {
      decisions.push({ contract_no: contractNo, document_id: d.id, filename: d.filename, applied: false, reason });
      // An unrecognised or doubtful document about this contract (unknown type, unclear signing status)
      // may change its terms — a person has to look.
      if (d.needs_review) review_reasons.push(`${d.filename}: ${reason}`);
      let proposed = 0;
      for (const f of byDoc.get(d.id) ?? []) {
        if (f.kind !== 'fact' || !isField(f.field) || f.value === fields[f.field].value) continue;
        proposals.push({ field: f.field, display: f.display!, reason, source: ref(f, d) });
        proposed++;
        // A doubtful document (signed amendment without an effective date, «проект» with signatures, unknown type)
        // may already be in force: the value it would change can no longer be shown as certain.
        if (d.needs_review && fields[f.field].status !== 'needs_review' && fields[f.field].status !== 'no_data') {
          fields[f.field] = needsReview(fields[f.field],
            `${docLabel(d)} (${d.filename}) может менять значение на ${f.display}: ${reason}`, ref(f, d));
        }
      }
      if (proposed) continue;
      // Nothing to propose: keep it visible as a note. Proposed termination is quoted as such.
      const term = (byDoc.get(d.id) ?? []).find((f) => f.field === 'termination');
      const body = term ? null : longestBodyParagraph(parasByDoc.get(d.id) ?? []);
      notes.push({
        document_id: d.id, doc_label: docLabel(d), doc_date: d.doc_date,
        reason: term ? `предлагается расторжение (${reason})` : reason,
        source: term ? ref(term, d) : body ? paraRef(body, d, 'note.body') : { fact_id: null, document_id: d.id, filename: d.filename, doc_label: docLabel(d), paragraph_id: null, quote: '', start: 0, end: 0, rule_id: 'note.empty' },
      });
    }
    notes.sort((a, b) => (b.doc_date ?? '').localeCompare(a.doc_date ?? ''));

    const terminated = termination?.in_force ?? false;
    contracts.push({
      contract_no: contractNo, document_id: cDocs[0]!.id,
      status: terminated ? 'terminated' : 'active',
      status_label: terminated ? termination!.display : termination ? `действует, ${termination.display.replace('расторгнут', 'расторгается')}` : 'действует',
      termination, fields, proposals, notes,
      needs_review: review_reasons.length > 0 || Object.values(fields).some((f) => f.status === 'needs_review'),
      review_reasons,
    });
  }

  const unlinked = ruled
    .filter((d) => d.doc_type !== 'contract' && (!d.contract_no || !contractDocs.has(d.contract_no)))
    .map((d) => ({
      document_id: d.id, filename: d.filename, doc_type: d.doc_type, contract_no: d.contract_no,
      reason: d.llm_status === 'pending'
        ? `LLM проверяет документ… (${d.review_reason ?? 'номер договора не найден'})`
        : d.doc_type === 'unknown' || !d.contract_no
          ? `требует проверки: ${d.review_reason ?? 'номер договора не найден'}`
          : `договор ${d.contract_no} не загружен`,
    }));
  for (const d of docs) if (d.classified_by === 'llm') unlinked.push({ document_id: d.id, filename: d.filename, doc_type: d.doc_type, contract_no: d.contract_no, reason: llmReason(d) });
  for (const d of ruled) if (d.doc_type === 'contract' && !d.contract_no) unlinked.push({ document_id: d.id, filename: d.filename, doc_type: d.doc_type, contract_no: null, reason: 'номер договора не найден' });

  return { check_date: checkDate, contracts, unlinked, decisions };
}

/** The main text of a letter: the longest paragraph that is not a header line («Дата:», «Тема:», …). */
function longestBodyParagraph(ps: ParagraphRow[]): ParagraphRow | null {
  const body = ps.slice(1).filter((p) => !/^[\p{L} ]{2,20}:\s/u.test(p.text));
  return body.sort((a, b) => b.text.length - a.text.length)[0] ?? null;
}

function llmReason(d: DocRow): string {
  const s = d.llm_suggestion ? (JSON.parse(d.llm_suggestion) as { model: string; quote: string }) : null;
  const no = d.contract_no ? ` ${d.doc_type === 'contract' ? '' : 'к договору '}${d.contract_no}` : '';
  const what = `${TYPE_LABEL[d.doc_type] ?? 'Документ'}${no}`;
  return `требует проверки: LLM (${s?.model ?? '?'}) предполагает «${what}» по цитате «${s?.quote ?? ''}»; в таблицу не попадает до подтверждения`;
}

function groupBy<T, K>(xs: T[], key: (x: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const x of xs) m.set(key(x), [...(m.get(key(x)) ?? []), x]);
  return m;
}
