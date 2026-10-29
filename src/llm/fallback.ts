import type { Db } from '../db.js';
import type { Logger } from '../logger.js';
import { Tracer } from '../pipeline/trace.js';
import { classifyWithLlm } from './classify.js';
import type { LlmProvider } from './providers.js';

interface Pending { id: number; filename: string; text: string; review_reason: string | null }

/**
 * Optional second pass for documents the rules could not recognise (unknown type or no contract number).
 * Classification only — values are never extracted by the LLM. Any LLM result is `needs_review`
 * and stays out of the contracts table until a person confirms it. Never throws.
 */
export async function llmFallback(ctx: { db: Db; logger: Logger }, provider: LlmProvider | null, batchId = 'llm') {
  const { db, logger } = ctx;
  const pending = db.prepare(`select id, filename, text, review_reason from documents
    where classified_by = 'rules' and llm_status is null and (doc_type = 'unknown' or contract_no is null)`).all() as unknown as Pending[];

  for (const doc of pending) {
    const tracer = new Tracer(db, logger, batchId, doc.filename);
    tracer.attach(doc.id);
    const appendReason = (r: string) => [doc.review_reason, r].filter(Boolean).join('; ');

    if (!provider) {
      tracer.record('llm', 'llm.disabled', 'LLM не настроен — документ остаётся «требует проверки»');
      db.prepare("update documents set llm_status = 'disabled' where id = ?").run(doc.id);
      continue;
    }

    const res = await classifyWithLlm(provider, doc.text);
    for (const a of res.attempts) {
      tracer.record('llm', `llm.attempt.${a.outcome}`, `Попытка ${a.attempt}: ${a.detail}`, {
        provider: provider.name, model: provider.model, attempt: a.attempt, duration_ms: a.duration_ms, prompt_hash: res.prompt_hash,
      }, a.outcome === 'ok' ? 'info' : 'warn');
    }

    if (!res.answer) {
      tracer.record('llm', 'llm.fallback', 'LLM не дал валидного ответа — документ остаётся «требует проверки»', { attempts: res.attempts.length }, 'warn');
      db.prepare("update documents set llm_status = 'failed', review_reason = ? where id = ?")
        .run(appendReason('LLM не дал валидного ответа'), doc.id);
      continue;
    }

    const a = res.answer;
    const suggestion = { provider: provider.name, model: provider.model, ...a };
    tracer.record('llm', 'llm.classified', `LLM: ${a.doc_type}, договор ${a.contract_no ?? '?'} — «${a.quote}» (требует проверки)`, { doc_type: a.doc_type, contract_no: a.contract_no });
    db.prepare(`update documents set doc_type = ?, contract_no = ?, classified_by = 'llm', needs_review = 1, llm_status = 'ok',
        llm_suggestion = ?, review_reason = ? where id = ?`)
      .run(a.doc_type, a.contract_no, JSON.stringify(suggestion), appendReason('классифицировано LLM, требует подтверждения'), doc.id);
  }
  return pending.length;
}
