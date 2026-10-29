import type { FieldName } from '../src/extractors/types.js';
import type { FileResult } from '../src/pipeline/types.js';
import type { Note, Resolution, ResolvedContract, ResolvedField, SourceRef } from '../src/pipeline/resolve.js';

interface DocRow { id: number; filename: string; doc_type: string; doc_no: string | null; contract_no: string | null; sign_status: string; effective_date: string | null; needs_review: number; review_reason: string | null; classified_by: string | null; llm_suggestion: string | null }
interface DocFull extends DocRow { text: string }
interface TraceRow { stage: string; rule_id: string | null; message: string }

/** Columns come from the extractor registry (GET /api/config): a new field needs no UI change. */
let FIELDS: { field: FieldName; label: string }[] = [];
const FIELD_LABEL = {} as Record<FieldName, string>;
const TYPE_LABEL: Record<string, string> = { contract: 'договор', amendment: 'доп. соглашение', draft: 'проект ДС', letter: 'письмо', unknown: 'не распознан' };
const SIGN_LABEL: Record<string, string> = { signed_both: 'подписан обеими сторонами', unsigned: 'не подписан', unknown: '—' };

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
// Escapes ' too: document text ends up inside single-quoted attributes (data-src).
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
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
  const docs = await api<DocRow[]>('/api/documents');
  renderDocuments(docs);
  document.body.classList.toggle('empty', docs.length === 0);
  const sel = $<HTMLSelectElement>('q-contract');
  const prev = sel.value;
  sel.innerHTML = state.contracts.map((c) => `<option>${esc(c.contract_no)}</option>`).join('');
  if (state.contracts.some((c) => c.contract_no === prev)) sel.value = prev;
}

function statusBadge(f: ResolvedField, quietActive = false) {
  // In the table the value itself already says "нет данных"; plain "действует" is the default.
  if (quietActive && (f.status === 'active' || f.status === 'no_data')) return '';
  return `<span class="status ${f.status}">${esc(f.status_label)}</span>`;
}

function renderContracts(res: Resolution) {
  const cell = (c: ResolvedContract, field: FieldName) => {
    const f = c.fields[field];
    const pending = c.proposals.some((p) => p.field === field) ? ' <span class="warn" title="Есть несогласованные предложения">⚠</span>' : '';
    const badge = statusBadge(f, true);
    return `<td class="v" data-contract="${esc(c.contract_no)}" data-field="${field}" title="Показать источник">${esc(f.display)}${pending}${badge ? `<br>${badge}` : ''}</td>`;
  };
  $('contracts-head').innerHTML = `<th>Договор</th>${FIELDS.map((f) => `<th>${esc(f.label)}</th>`).join('')}<th>Статус</th>`;
  $('contracts').innerHTML = res.contracts.length
    ? res.contracts.map((c) => `<tr class="${c.status}">
        <td><b>${esc(c.contract_no)}</b>${c.termination ? `<br><span class="status terminated">${esc(c.status === 'terminated' ? c.termination.display : `расторгается с ${fmt(c.termination.date)}`)}</span>` : ''}</td>
        ${FIELDS.map((f) => cell(c, f.field)).join('')}
        <td class="v" data-contract-detail="${esc(c.contract_no)}" title="Подробнее о договоре">${contractFlags(c) || '<span class="muted">—</span>'}</td>
      </tr>`).join('')
    : `<tr><td colspan="${FIELDS.length + 2}" class="muted">Загрузите TXT-файлы договоров</td></tr>`;
  $('unlinked').innerHTML = res.unlinked.length
    ? `<h2>Не связаны с загруженным договором</h2><ul>${res.unlinked.map((u) => `<li>${esc(u.filename)} — ${esc(u.reason)}</li>`).join('')}</ul>`
    : '';
}

function contractFlags(c: ResolvedContract) {
  return [
    c.needs_review && `<span class="status needs_review">требует проверки</span>`,
    c.proposals.length && `<span class="warn">⚠ предложений: ${c.proposals.length}</span>`,
    c.notes.length && `<span class="status note">📝 заметок: ${c.notes.length}</span>`,
  ].filter(Boolean).join('<br>');
}

const srcButton = (src: SourceRef, label = 'показать') => `<button data-src='${esc(JSON.stringify(src))}'>${label}</button>`;
const noteLine = (n: Note) =>
  `<li><b>${esc(n.doc_label)}</b>${n.doc_date ? ` от ${fmt(n.doc_date)}` : ''}: ${n.source.quote ? `«${esc(n.source.quote)}»` : ''}
    <span class="muted">(${esc(n.reason)})</span> ${n.source.quote ? srcButton(n.source) : ''}</li>`;

/** Everything about one contract that is not a single value: termination, review reasons, proposals, notes. */
function contractDetail(c: ResolvedContract) {
  const term = c.termination
    ? `<p><span class="status terminated">${esc(c.status_label)}</span> ${srcButton(c.termination.source, 'источник')}</p>` : '';
  const review = c.review_reasons.length || Object.values(c.fields).some((f) => f.status === 'needs_review')
    ? `<p><b>Требует проверки:</b></p><ul>${[
        ...c.review_reasons.map((r) => `<li>${esc(r)}</li>`),
        ...FIELDS.filter((f) => c.fields[f.field].status === 'needs_review' && !c.review_reasons.includes(c.fields[f.field].reason ?? ''))
          .map((f) => `<li>${esc(f.label)}: ${esc(c.fields[f.field].reason ?? '')}</li>`),
      ].join('')}</ul>` : '';
  const props = c.proposals.length
    ? `<p><b>Несогласованные предложения</b> (не меняют условия):</p><ul>${c.proposals.map((p) =>
        `<li>${esc(FIELD_LABEL[p.field])}: ${esc(p.display)} — ${esc(p.source.doc_label)} (${esc(p.reason)}) ${srcButton(p.source)}</li>`).join('')}</ul>` : '';
  const notes = c.notes.length ? `<p><b>Заметки</b> (письма и документы без новых значений):</p><ul>${c.notes.map(noteLine).join('')}</ul>` : '';
  openDetail(`<h2 style="margin-top:0">Договор ${esc(c.contract_no)}</h2>${term}${review}${props}${notes}
    ${term || review || props || notes ? '' : '<p class="muted">Действует, вопросов нет.</p>'}`);
}

function renderDocuments(docs: DocRow[]) {
  $('documents').innerHTML = docs.map((d) => `<tr>
    <td>${esc(d.filename)}</td>
    <td>${esc(TYPE_LABEL[d.doc_type] ?? d.doc_type)}${d.doc_no && d.doc_type !== 'contract' ? ` №${esc(d.doc_no)}` : ''}
      ${d.needs_review ? `<br><span class="status needs_review">${esc(d.review_reason ?? 'требует проверки')}</span>` : ''}
      ${d.llm_suggestion ? `<br><span class="muted">LLM: «${esc((JSON.parse(d.llm_suggestion) as { quote: string }).quote)}»</span>` : ''}</td>
    <td>${esc(d.contract_no ?? '—')}</td>
    <td>${esc(SIGN_LABEL[d.sign_status] ?? d.sign_status)}${d.effective_date ? `<br><span class="muted">в силе с ${fmt(d.effective_date)}</span>` : ''}</td>
    <td><button data-doc="${d.id}">Открыть</button> <button data-trace="${d.id}">Трасса</button></td>
  </tr>`).join('');
}

/** The side panel opens only when there is something to show; the table is full width otherwise. */
function openDetail(html: string) {
  $('detail').innerHTML = `<button class="close" id="close-detail" title="Закрыть">×</button>${html}`;
  $('layout').classList.add('has-detail');
}
function closeDetail() {
  $('layout').classList.remove('has-detail');
  document.querySelectorAll('td.v.selected').forEach((el) => el.classList.remove('selected'));
}

async function showSource(title: string, src: SourceRef | null, extraHtml = '') {
  if (!src) {
    openDetail(`<h2 style="margin-top:0">${esc(title)}</h2>${extraHtml}`);
    return;
  }
  const doc = await api<DocFull>(`/api/documents/${src.document_id}`);
  const t = doc.text;
  openDetail(`<h2 style="margin-top:0">${esc(title)}</h2>${extraHtml}
    <p class="muted">Источник: ${esc(src.doc_label)} · ${esc(src.filename)} · правило <code>${esc(src.rule_id)}</code></p>
    <pre class="doc">${esc(t.slice(0, src.start))}<mark id="hl">${esc(t.slice(src.start, src.end))}</mark>${esc(t.slice(src.end))}</pre>`);
  // Scroll only the document box to the quote — the page itself stays where the user is.
  const hl = document.getElementById('hl');
  const pre = hl?.closest('pre');
  if (hl && pre) pre.scrollTop = hl.offsetTop - pre.clientHeight / 3; // pre is positioned, so offsetTop is relative to it
}

function fieldDetail(c: ResolvedContract, field: FieldName) {
  const f = c.fields[field];
  const chain = f.chain.length > 1
    ? `<p><b>Цепочка изменений:</b> ${f.chain.map((s) => `${esc(s.display)} <span class="muted">(${esc(s.label)})</span>`).join(' → ')}</p>` : '';
  const reason = f.reason ? `<p><b>Причина:</b> ${esc(f.reason)}</p>` : '';
  const props = c.proposals.filter((p) => p.field === field);
  const propHtml = props.length
    ? `<p><b>Несогласованные предложения</b> (не меняют значение):</p><ul>${props.map((p) =>
        `<li>${esc(p.display)} — ${esc(p.source.doc_label)} (${esc(p.reason)}) ${srcButton(p.source)}</li>`).join('')}</ul>`
    : '';
  const term = c.status === 'terminated' ? `<p><span class="status terminated">${esc(c.status_label)}</span> — значение историческое, обязательств по договору нет.</p>` : '';
  const notes = c.notes.length ? `<p><b>Заметки по договору:</b></p><ul>${c.notes.map(noteLine).join('')}</ul>` : '';
  return showSource(`${c.contract_no} · ${FIELD_LABEL[field]}: ${f.display}`, f.source,
    `${term}<p>${statusBadge(f)}</p>${reason}${chain}${propHtml}${notes}`);
}

async function showDoc(id: number) {
  const doc = await api<DocFull>(`/api/documents/${id}`);
  openDetail(`<h2 style="margin-top:0">${esc(doc.filename)}</h2><pre class="doc">${esc(doc.text)}</pre>`);
}

async function showTrace(id: number) {
  const rows = await api<TraceRow[]>(`/api/debug/trace/${id}`);
  openDetail(`<h2 style="margin-top:0">Трасса документа #${id}</h2>
    <table><thead><tr><th>Этап</th><th>Правило</th><th>Решение</th></tr></thead><tbody>
    ${rows.map((r) => `<tr class="${r.rule_id?.includes('stop_word') || r.rule_id?.includes('no_rule') ? 'rejected' : ''}">
      <td>${esc(r.stage)}</td><td><code>${esc(r.rule_id ?? '')}</code></td><td>${esc(r.message)}</td></tr>`).join('')}
    </tbody></table>`);
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
    ${c.termination ? `<br><span class="status terminated">${esc(c.status_label)}</span>` : ''}
    ${f.status === 'needs_review' && f.reason ? `<br><span class="muted">${esc(f.reason)}</span>` : ''}
    ${f.reason && f.status !== 'needs_review' ? `<br><span class="muted">${noData ? 'Причина, ' : ''}${f.source ? `${esc(f.source.doc_label)}: ` : ''}«${esc(f.reason)}»</span>` : ''}
    ${f.source && !noData ? `<br><span class="muted">Источник: ${esc(f.source.doc_label)}, «${esc(f.source.quote)}»</span>` : ''}
    ${props.length ? `<br><span class="warn">Несогласованные предложения: ${props.map((p) => `${esc(p.display)} (${esc(p.source.doc_label)})`).join(', ')}</span>` : ''}`);
  void fieldDetail(c, field);
}

$('q-date').addEventListener('click', () => contractAnswer('delivery_date'));
$('q-amount').addEventListener('click', () => contractAnswer('total_amount'));
$('q-early').addEventListener('click', () => {
  if (!state) return;
  const before = $<HTMLInputElement>('q-before').value;
  const early = state.contracts.filter((c) => c.fields.delivery_date.value !== null && c.fields.delivery_date.value < before);
  const hits = early.filter((c) => c.status !== 'terminated');
  const terminated = early.filter((c) => c.status === 'terminated');
  const unknown = state.contracts.filter((c) => c.fields.delivery_date.value === null && c.status !== 'terminated');
  answer(`<b>Поставка раньше ${fmt(before)} (на ${fmt(state.check_date)}):</b> ${hits.length ? '' : 'нет таких договоров'}
    <ul>${hits.map((c) => {
      const props = c.proposals.filter((p) => p.field === 'delivery_date');
      return `<li>${esc(c.contract_no)} — ${esc(c.fields.delivery_date.display)} ${statusBadge(c.fields.delivery_date)}
        ${props.length ? `<span class="warn">есть несогласованное изменение срока: ${props.map((p) => `${esc(p.display)} (${esc(p.source.doc_label)}, ${esc(p.reason)})`).join('; ')}</span>` : ''}</li>`;
    }).join('')}</ul>
    ${unknown.length ? `<span class="muted">Срок не определён (нет данных или требует проверки): ${unknown.map((c) => esc(c.contract_no)).join(', ')}</span><br>` : ''}
    ${terminated.length ? `<span class="muted">Не учитываются — расторгнуты: ${terminated.map((c) => `${esc(c.contract_no)} (${esc(c.status_label)})`).join(', ')}</span>` : ''}`);
});

// --- Events
document.body.addEventListener('click', (e) => {
  if ((e.target as HTMLElement).id === 'close-detail') return closeDetail();
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-field],[data-doc],[data-trace],[data-src],[data-contract-detail]');
  if (!el || !state) return;
  if (el.dataset.contractDetail) {
    document.querySelectorAll('td.v.selected').forEach((x) => x.classList.remove('selected'));
    el.classList.add('selected');
    contractDetail(state.contracts.find((x) => x.contract_no === el.dataset.contractDetail)!);
  } else if (el.dataset.field) {
    document.querySelectorAll('td.v.selected').forEach((x) => x.classList.remove('selected'));
    el.classList.add('selected');
    const c = state.contracts.find((x) => x.contract_no === el.dataset.contract)!;
    void fieldDetail(c, el.dataset.field as FieldName);
  } else if (el.dataset.doc) void showDoc(Number(el.dataset.doc));
  else if (el.dataset.trace) void showTrace(Number(el.dataset.trace));
  else if (el.dataset.src) {
    const src = JSON.parse(el.dataset.src) as SourceRef;
    void showSource(`Предложение: ${src.doc_label}`, src);
  }
});

// --- Upload: picking or dropping files uploads them at once.
const drop = $<HTMLLabelElement>('drop');
let busy = false;

function plural(n: number, one: string, few: string, many: string) {
  const m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
}

async function uploadFiles(files: File[]) {
  if (busy || files.length === 0) return;
  busy = true;
  drop.classList.add('busy');
  $('drop-title').textContent = `Обрабатываю ${files.length} ${plural(files.length, 'файл', 'файла', 'файлов')}…`;
  $('drop-hint').textContent = 'Проверяю формат, распознаю тип документа и извлекаю условия.';
  $('upload-summary').innerHTML = '';
  try {
    const form = new FormData();
    for (const f of files) form.append('files', f, f.name);
    const { results } = await api<{ results: FileResult[] }>('/api/upload', { method: 'POST', body: form });
    const ok = results.filter((r) => r.status === 'ok').length;
    const dup = results.filter((r) => r.status === 'duplicate').length;
    const bad = results.filter((r) => r.status === 'rejected').length;
    const parts = [
      ok && `<span class="ok">✓ принято ${ok}</span>`,
      dup && `<span class="muted">уже были загружены: ${dup}</span>`,
      bad && `<span class="rejected">✕ отклонено ${bad}</span>`,
    ].filter(Boolean);
    const list = results.map((r) =>
      r.status === 'ok' ? `<li class="ok">${esc(r.filename)}: принят</li>`
      : r.status === 'duplicate' ? `<li class="muted">${esc(r.filename)}: уже загружен (как ${esc(r.duplicate_of)}), дубль не создан</li>`
      : `<li class="rejected">${esc(r.filename)}: ${esc(r.reason)}</li>`).join('');
    // Details are open when something was rejected — that is what the user has to act on.
    $('upload-summary').innerHTML = `<b>Загружено ${results.length} ${plural(results.length, 'файл', 'файла', 'файлов')}:</b> ${parts.join(' · ')}
      <details ${bad ? 'open' : ''}><summary>подробно по файлам</summary><ul>${list}</ul></details>`;
    await refresh();
  } catch (err) {
    $('upload-summary').innerHTML = `<span class="rejected">Не удалось загрузить: ${esc(String(err))}</span>`;
  } finally {
    busy = false;
    drop.classList.remove('busy');
    $('drop-title').textContent = 'Перетащите файлы сюда или нажмите, чтобы выбрать';
    $('drop-hint').textContent = 'Можно сразу несколько: договоры, допсоглашения, проекты, письма. Формат — TXT.';
    $<HTMLInputElement>('files').value = '';
  }
}

$<HTMLInputElement>('files').addEventListener('change', (e) => void uploadFiles([...((e.target as HTMLInputElement).files ?? [])]));
drop.addEventListener('click', (e) => { if (busy) e.preventDefault(); });
for (const ev of ['dragenter', 'dragover'] as const) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); });
for (const ev of ['dragleave', 'drop'] as const) drop.addEventListener(ev, () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => { e.preventDefault(); void uploadFiles([...(e.dataTransfer?.files ?? [])]); });
// A file dropped outside the zone must not make the browser navigate away from the page.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

$('clear').addEventListener('click', async () => {
  if (!confirm('Удалить все загруженные документы?')) return;
  await api('/api/documents', { method: 'DELETE' });
  $('upload-summary').innerHTML = '';
  $('answer').innerHTML = '';
  closeDetail();
  await refresh();
});

$('check-date').addEventListener('change', () => void refresh());

// The API may still be starting when the page opens (npm run dev) — retry for a few seconds.
for (let attempt = 0; ; attempt++) {
  try {
    const cfg = await api<{ check_date: string; llm: string | null; fields: typeof FIELDS }>('/api/config');
    $('llm-status').textContent = cfg.llm
      ? `Нераспознанные документы подсказывает LLM: ${cfg.llm}`
      : 'LLM не подключена: нераспознанные документы помечаются «требует проверки»';
    $<HTMLInputElement>('check-date').value = cfg.check_date;
    FIELDS = cfg.fields;
    for (const f of FIELDS) FIELD_LABEL[f.field] = f.label;
    await refresh();
    break;
  } catch (err) {
    if (attempt >= 10) { $('upload-summary').innerHTML = `<span class="rejected">Сервер недоступен: ${esc(String(err))}. Запустите npm run dev.</span>`; break; }
    await new Promise((r) => setTimeout(r, 500));
  }
}
