import type { FieldName } from '../src/extractors/types.js';
import type { FileResult } from '../src/pipeline/types.js';
import type { Resolution, ResolvedContract, ResolvedField, SourceRef } from '../src/pipeline/resolve.js';

interface DocRow { id: number; filename: string; doc_type: string; doc_no: string | null; contract_no: string | null; sign_status: string; effective_date: string | null; needs_review: number; review_reason: string | null }
interface DocFull extends DocRow { text: string }
interface TraceRow { stage: string; rule_id: string | null; message: string }

/** Columns come from the extractor registry (GET /api/config): a new field needs no UI change. */
let FIELDS: { field: FieldName; label: string }[] = [];
const FIELD_LABEL = {} as Record<FieldName, string>;
const TYPE_LABEL: Record<string, string> = { contract: 'договор', amendment: 'доп. соглашение', draft: 'проект ДС', letter: 'письмо', unknown: 'не распознан' };
const SIGN_LABEL: Record<string, string> = { signed_both: 'подписан обеими сторонами', unsigned: 'не подписан', unknown: '—' };

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const fmt = (iso: string) => iso.split('-').reverse().join('.');

let state: Resolution | null = null;

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  const body = await r.json().catch(() => ({ error: `${r.status} ${r.statusText}` }));
  if (!r.ok) throw new Error(body.error ?? r.statusText);
  return body as T;
}

const checkDate = () => $<HTMLInputElement>('check-date').value;

async function refresh() {
  state = await api<Resolution>(`/api/contracts?check_date=${checkDate()}`);
  $('date-label').textContent = fmt(state.check_date);
  renderContracts(state);
  renderDocuments(await api<DocRow[]>('/api/documents'));
  const sel = $<HTMLSelectElement>('q-contract');
  const prev = sel.value;
  sel.innerHTML = state.contracts.map((c) => `<option>${esc(c.contract_no)}</option>`).join('');
  if (state.contracts.some((c) => c.contract_no === prev)) sel.value = prev;
}

function statusBadge(f: ResolvedField) {
  return `<span class="status ${f.status}">${esc(f.status_label)}</span>`;
}

function renderContracts(res: Resolution) {
  const cell = (c: ResolvedContract, field: FieldName) => {
    const f = c.fields[field];
    const pending = c.proposals.some((p) => p.field === field) ? ' <span class="warn" title="Есть несогласованные предложения">⚠</span>' : '';
    return `<td class="v" data-contract="${esc(c.contract_no)}" data-field="${field}">${esc(f.display)}${pending}<br>${statusBadge(f)}</td>`;
  };
  $('contracts-head').innerHTML = `<th>Договор</th>${FIELDS.map((f) => `<th>${esc(f.label)}</th>`).join('')}<th>Статус</th>`;
  $('contracts').innerHTML = res.contracts.length
    ? res.contracts.map((c) => `<tr>
        <td><b>${esc(c.contract_no)}</b></td>${FIELDS.map((f) => cell(c, f.field)).join('')}
        <td>${c.needs_review ? `<span class="status needs_review" title="${esc(c.review_reasons.join('; '))}">требует проверки</span>` : ''}
            ${c.proposals.length ? `<span class="warn">есть несогласованные предложения: ${c.proposals.length}</span>` : ''}</td>
      </tr>`).join('')
    : `<tr><td colspan="${FIELDS.length + 2}" class="muted">Загрузите TXT-файлы договоров</td></tr>`;
  $('unlinked').innerHTML = res.unlinked.length
    ? `<h2>Не связаны с загруженным договором</h2><ul>${res.unlinked.map((u) => `<li>${esc(u.filename)} — ${esc(u.reason)}</li>`).join('')}</ul>`
    : '';
}

function renderDocuments(docs: DocRow[]) {
  $('documents').innerHTML = docs.map((d) => `<tr>
    <td>${esc(d.filename)}</td>
    <td>${esc(TYPE_LABEL[d.doc_type] ?? d.doc_type)}${d.doc_no && d.doc_type !== 'contract' ? ` №${esc(d.doc_no)}` : ''}
      ${d.needs_review ? `<br><span class="status needs_review">${esc(d.review_reason ?? 'требует проверки')}</span>` : ''}</td>
    <td>${esc(d.contract_no ?? '—')}</td>
    <td>${esc(SIGN_LABEL[d.sign_status] ?? d.sign_status)}${d.effective_date ? `<br><span class="muted">в силе с ${fmt(d.effective_date)}</span>` : ''}</td>
    <td><button data-doc="${d.id}">Открыть</button> <button data-trace="${d.id}">Трасса</button></td>
  </tr>`).join('');
}

async function showSource(title: string, src: SourceRef | null, extraHtml = '') {
  if (!src) {
    $('detail').innerHTML = `<h2 style="margin-top:0">${esc(title)}</h2>${extraHtml}`;
    return;
  }
  const doc = await api<DocFull>(`/api/documents/${src.document_id}`);
  const t = doc.text;
  $('detail').innerHTML = `<h2 style="margin-top:0">${esc(title)}</h2>${extraHtml}
    <p class="muted">Источник: ${esc(src.doc_label)} · ${esc(src.filename)} · правило <code>${esc(src.rule_id)}</code></p>
    <pre class="doc">${esc(t.slice(0, src.start))}<mark id="hl">${esc(t.slice(src.start, src.end))}</mark>${esc(t.slice(src.end))}</pre>`;
  document.getElementById('hl')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function fieldDetail(c: ResolvedContract, field: FieldName) {
  const f = c.fields[field];
  const chain = f.chain.length > 1
    ? `<p><b>Цепочка изменений:</b> ${f.chain.map((s) => `${esc(s.display)} <span class="muted">(${esc(s.label)})</span>`).join(' → ')}</p>` : '';
  const reason = f.reason ? `<p><b>Причина:</b> ${esc(f.reason)}</p>` : '';
  const props = c.proposals.filter((p) => p.field === field);
  const propHtml = props.length
    ? `<p><b>Несогласованные предложения</b> (не меняют значение):</p><ul>${props.map((p) =>
        `<li>${esc(p.display)} — ${esc(p.source.doc_label)} (${esc(p.reason)}) <button data-src='${esc(JSON.stringify(p.source))}'>показать</button></li>`).join('')}</ul>`
    : '';
  return showSource(`${c.contract_no} · ${FIELD_LABEL[field]}: ${f.display}`, f.source,
    `<p>${statusBadge(f)}</p>${reason}${chain}${propHtml}`);
}

async function showDoc(id: number) {
  const doc = await api<DocFull>(`/api/documents/${id}`);
  $('detail').innerHTML = `<h2 style="margin-top:0">${esc(doc.filename)}</h2><pre class="doc">${esc(doc.text)}</pre>`;
}

async function showTrace(id: number) {
  const rows = await api<TraceRow[]>(`/api/debug/trace/${id}`);
  $('detail').innerHTML = `<h2 style="margin-top:0">Трасса документа #${id}</h2>
    <table><thead><tr><th>Этап</th><th>Правило</th><th>Решение</th></tr></thead><tbody>
    ${rows.map((r) => `<tr class="${r.rule_id?.includes('stop_word') || r.rule_id?.includes('no_rule') ? 'rejected' : ''}">
      <td>${esc(r.stage)}</td><td><code>${esc(r.rule_id ?? '')}</code></td><td>${esc(r.message)}</td></tr>`).join('')}
    </tbody></table>`;
}

// --- Questions: answers are built from the same data as the table.
function answer(html: string) { $('answer').innerHTML = `<div class="answer">${html}</div>`; }
function contractAnswer(field: FieldName) {
  const c = state?.contracts.find((x) => x.contract_no === $<HTMLSelectElement>('q-contract').value);
  if (!c) return answer('Нет загруженных договоров');
  const f = c.fields[field];
  const props = c.proposals.filter((p) => p.field === field);
  const noData = f.status === 'no_data';
  answer(`<b>${esc(FIELD_LABEL[field])} по ${esc(c.contract_no)} на ${fmt(state!.check_date)}:</b> ${esc(f.display)} ${noData ? '' : statusBadge(f)}
    ${f.reason ? `<br><span class="muted">${noData ? 'Причина, ' : ''}${f.source ? `${esc(f.source.doc_label)}: ` : ''}«${esc(f.reason)}»</span>` : ''}
    ${f.source && !noData ? `<br><span class="muted">Источник: ${esc(f.source.doc_label)}, «${esc(f.source.quote)}»</span>` : ''}
    ${props.length ? `<br><span class="warn">Несогласованные предложения: ${props.map((p) => `${esc(p.display)} (${esc(p.source.doc_label)})`).join(', ')}</span>` : ''}`);
  void fieldDetail(c, field);
}

$('q-date').addEventListener('click', () => contractAnswer('delivery_date'));
$('q-amount').addEventListener('click', () => contractAnswer('total_amount'));
$('q-early').addEventListener('click', () => {
  if (!state) return;
  const before = $<HTMLInputElement>('q-before').value;
  const hits = state.contracts.filter((c) => c.fields.delivery_date.value !== null && c.fields.delivery_date.value < before);
  const unknown = state.contracts.filter((c) => c.fields.delivery_date.value === null);
  answer(`<b>Поставка раньше ${fmt(before)} (на ${fmt(state.check_date)}):</b> ${hits.length ? '' : 'нет таких договоров'}
    <ul>${hits.map((c) => {
      const props = c.proposals.filter((p) => p.field === 'delivery_date');
      return `<li>${esc(c.contract_no)} — ${esc(c.fields.delivery_date.display)} ${statusBadge(c.fields.delivery_date)}
        ${props.length ? `<span class="warn">есть несогласованное изменение срока: ${props.map((p) => `${esc(p.display)} (${esc(p.source.doc_label)}, ${esc(p.reason)})`).join('; ')}</span>` : ''}</li>`;
    }).join('')}</ul>
    ${unknown.length ? `<span class="muted">Срок неизвестен: ${unknown.map((c) => esc(c.contract_no)).join(', ')}</span>` : ''}`);
});

// --- Events
document.body.addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-field],[data-doc],[data-trace],[data-src]');
  if (!el || !state) return;
  if (el.dataset.field) {
    const c = state.contracts.find((x) => x.contract_no === el.dataset.contract)!;
    void fieldDetail(c, el.dataset.field as FieldName);
  } else if (el.dataset.doc) void showDoc(Number(el.dataset.doc));
  else if (el.dataset.trace) void showTrace(Number(el.dataset.trace));
  else if (el.dataset.src) {
    const src = JSON.parse(el.dataset.src) as SourceRef;
    void showSource(`Предложение: ${src.doc_label}`, src);
  }
});

$('upload').addEventListener('click', async () => {
  const input = $<HTMLInputElement>('files');
  if (!input.files?.length) return;
  const form = new FormData();
  for (const f of input.files) form.append('files', f, f.name);
  const { results } = await api<{ results: FileResult[] }>('/api/upload', { method: 'POST', body: form });
  $('upload-results').innerHTML = results.map((r) =>
    r.status === 'ok' ? `<li>${esc(r.filename)}: принят</li>`
    : r.status === 'duplicate' ? `<li class="muted">${esc(r.filename)}: уже загружен (как ${esc(r.duplicate_of)})</li>`
    : `<li class="rejected">${esc(r.filename)}: отклонён — ${esc(r.reason)}</li>`).join('');
  input.value = '';
  await refresh();
});

$('clear').addEventListener('click', async () => {
  if (!confirm('Удалить все загруженные документы?')) return;
  await api('/api/documents', { method: 'DELETE' });
  $('upload-results').innerHTML = '';
  $('detail').innerHTML = '<p class="muted">Нажмите на значение в таблице, чтобы увидеть источник.</p>';
  await refresh();
});

$('check-date').addEventListener('change', () => void refresh());

// The API may still be starting when the page opens (npm run dev) — retry for a few seconds.
for (let attempt = 0; ; attempt++) {
  try {
    const cfg = await api<{ check_date: string; fields: typeof FIELDS }>('/api/config');
    $<HTMLInputElement>('check-date').value = cfg.check_date;
    FIELDS = cfg.fields;
    for (const f of FIELDS) FIELD_LABEL[f.field] = f.label;
    await refresh();
    break;
  } catch (err) {
    if (attempt >= 10) { $('contracts').innerHTML = `<tr><td colspan="5" class="rejected">Сервер недоступен: ${esc(String(err))}</td></tr>`; break; }
    await new Promise((r) => setTimeout(r, 500));
  }
}
