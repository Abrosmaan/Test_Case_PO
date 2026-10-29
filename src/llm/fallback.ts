import type { Db } from '../db.js';
import type { Logger } from '../logger.js';
import { Tracer } from '../pipeline/trace.js';
import { classifyWithLlm, findInjection, PROMPT_VERSION, type LlmAnswer } from './classify.js';
import type { LlmProvider } from './providers.js';

interface Pending { id: number; filename: string; text: string; sha256: string; review_reason: string | null }
interface Cached { outcome: 'ok' | 'invalid'; answer: string | null; detail: string | null }

/** Documents the rules could not recognise (unknown type or no contract number) and the LLM has not seen yet. */
const ELIGIBLE = `classified_by = 'rules' and (llm_status is null or llm_status = 'pending') and (doc_type = 'unknown' or contract_no is null)`;

/** Marks eligible documents as waiting for the LLM, so the UI can show «LLM проверяет…» right away. */
export function markLlmPending(db: Db): number {
  return Number(db.prepare(`update documents set llm_status = 'pending' where ${ELIGIBLE}`).run().changes);
}

/**
 * Optional second pass for documents the rules could not recognise (unknown type or no contract number).
 * Classification only — values are never extracted by the LLM. Any LLM result is `needs_review`
 * and stays out of the contracts table until a person confirms it. Never throws.
 *
 * The model is called only when nothing else decides: no provider → skipped; instructions for a model in
 * the text → skipped; the same text was already answered by the same model and prompt → cached answer.
 */
export async function llmFallback(ctx: { db: Db; logger: Logger }, provider: LlmProvider | null, batchId = 'llm') {
  const { db, logger } = ctx;
  const pending = db.prepare(`select id, filename, text, sha256, review_reason from documents where ${ELIGIBLE} order by id`).all() as unknown as Pending[];
  const stillThere = db.prepare('select 1 from documents where id = ?');
  const modelKey = provider ? `${provider.name}/${provider.model}/v${PROMPT_VERSION}` : '';

  for (const doc of pending) {
    const tracer = new Tracer(db, logger, batchId, doc.filename);
    tracer.attach(doc.id);
    const appendReason = (r: string) => [doc.review_reason, r].filter(Boolean).join('; ');
    const failed = (detail: string) => {
      tracer.record('llm', 'llm.fallback', `LLM не дал валидного ответа (${detail}) — документ остаётся «требует проверки»`, {}, 'warn');
      db.prepare("update documents set llm_status = 'failed', review_reason = ? where id = ?").run(appendReason('LLM не дал валидного ответа'), doc.id);
    };
    const classified = (a: LlmAnswer) => {
      const suggestion = { provider: provider!.name, model: provider!.model, ...a };
      tracer.record('llm', 'llm.classified', `LLM: ${a.doc_type}, договор ${a.contract_no ?? '?'} — «${a.quote}» (требует проверки)`, { doc_type: a.doc_type, contract_no: a.contract_no });
      db.prepare(`update documents set doc_type = ?, contract_no = ?, classified_by = 'llm', needs_review = 1, llm_status = 'ok',
          llm_suggestion = ?, review_reason = ? where id = ?`)
        .run(a.doc_type, a.contract_no, JSON.stringify(suggestion), appendReason('классифицировано LLM, требует подтверждения'), doc.id);
    };

    if (!provider) {
      tracer.record('llm', 'llm.disabled', 'LLM не настроен — документ остаётся «требует проверки»');
      db.prepare("update documents set llm_status = 'disabled' where id = ?").run(doc.id);
      continue;
    }

    const injection = findInjection(doc.text);
    if (injection) {
      tracer.record('llm', 'llm.injection_suspected', `В тексте похоже на инструкции для модели — LLM не вызывалась: «${injection}»`, {}, 'warn');
      db.prepare("update documents set llm_status = 'suspected', review_reason = ? where id = ?")
        .run(appendReason(`в тексте найдены инструкции для модели («${injection}») — LLM не вызывалась`), doc.id);
      continue;
    }

    const cached = db.prepare('select outcome, answer, detail from llm_cache where sha256 = ? and model_key = ?').get(doc.sha256, modelKey) as Cached | undefined;
    if (cached) {
      tracer.record('llm', 'llm.cache_hit', `Ответ ${modelKey} для этого текста уже есть — LLM не вызывалась`, { model_key: modelKey });
      if (cached.outcome === 'ok') classified(JSON.parse(cached.answer!) as LlmAnswer);
      else failed(cached.detail ?? 'невалидный ответ');
      continue;
    }

    const res = await classifyWithLlm(provider, doc.text);
    // Runs in the background: the documents may have been deleted («Удалить все») while the model was thinking.
    if (!stillThere.get(doc.id)) continue;
    for (const a of res.attempts) {
      tracer.record('llm', `llm.attempt.${a.outcome}`, `Попытка ${a.attempt}: ${a.detail}`, {
        provider: provider.name, model: provider.model, attempt: a.attempt, duration_ms: a.duration_ms, prompt_hash: res.prompt_hash,
      }, a.outcome === 'ok' ? 'info' : 'warn');
    }

    // Cache what the model said; never cache network errors or timeouts — those are worth retrying later.
    const modelAnswered = res.answer !== null || res.attempts.every((a) => a.outcome === 'invalid');
    if (modelAnswered) {
      db.prepare('insert or replace into llm_cache (sha256, model_key, outcome, answer, detail) values (?, ?, ?, ?, ?)')
        .run(doc.sha256, modelKey, res.answer ? 'ok' : 'invalid', res.answer ? JSON.stringify(res.answer) : null, res.attempts.at(-1)?.detail ?? null);
    }

    if (res.answer) classified(res.answer);
    else failed(res.attempts.at(-1)?.detail ?? 'нет ответа');
  }
  return pending.length;
}
