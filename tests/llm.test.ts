import { describe, expect, it } from 'vitest';
import { classifyWithLlm, validate } from '../src/llm/classify.js';
import { llmFallback } from '../src/llm/fallback.js';
import type { LlmProvider } from '../src/llm/providers.js';
import { providerFromEnv } from '../src/llm/providers.js';
import { processBatch } from '../src/pipeline/process.js';
import { resolve } from '../src/pipeline/resolve.js';
import { freshCtx, loadDir } from './helpers.js';

// A document the rules cannot recognise: no known title.
const UNKNOWN = 'Соглашение о поставке № STN-105\nПоставщик: ООО «Ромашка».\n2.1. Общая стоимость поставки составляет 100 000 рублей.';
const FAST = { retries: 3, backoffMs: 1, timeoutMs: 200 };

function fake(answers: (string | Error | 'hang')[]): LlmProvider & { calls: number; prompts: string[] } {
  const p = {
    name: 'fake', model: 'fake-1', calls: 0, prompts: [] as string[],
    async complete(prompt: string, signal: AbortSignal) {
      p.prompts.push(prompt);
      const a = answers[Math.min(p.calls++, answers.length - 1)]!;
      if (a === 'hang') return new Promise<string>((_, rej) => signal.addEventListener('abort', () => rej(signal.reason)));
      if (a instanceof Error) throw a;
      return a;
    },
  };
  return p;
}
const ok = JSON.stringify({ doc_type: 'contract', contract_no: 'STN-105', quote: 'Соглашение о поставке № STN-105' });

describe('validate', () => {
  it('accepts a valid answer, also wrapped in a code fence', () => {
    expect(validate('```json\n' + ok + '\n```', UNKNOWN)).toMatchObject({ doc_type: 'contract', contract_no: 'STN-105' });
  });
  it('rejects non-JSON, wrong schema, invented quote, invented contract number', () => {
    expect(validate('это договор', UNKNOWN)).toBe('ответ не JSON');
    expect(validate(JSON.stringify({ doc_type: 'invoice', contract_no: null, quote: 'Поставщик' }), UNKNOWN)).toMatch(/не по схеме/);
    expect(validate(JSON.stringify({ doc_type: 'contract', contract_no: null, quote: 'ДОГОВОР ПОСТАВКИ' }), UNKNOWN)).toBe('цитата не найдена в тексте документа');
    expect(validate(JSON.stringify({ doc_type: 'contract', contract_no: 'STN-999', quote: 'Поставщик' }), UNKNOWN)).toMatch(/STN-999/);
  });
});

describe('classifyWithLlm', () => {
  it('retries after invalid answers and errors, then succeeds', async () => {
    const p = fake(['мусор', new Error('HTTP 503'), ok]);
    const r = await classifyWithLlm(p, UNKNOWN, FAST);
    expect(r.answer?.contract_no).toBe('STN-105');
    expect(r.attempts.map((a) => a.outcome)).toEqual(['invalid', 'error', 'ok']);
    expect(r.prompt_hash).toMatch(/^[0-9a-f]{12}$/);
  });
  it('gives up after 1 + 3 retries, including timeouts', async () => {
    const p = fake(['hang']);
    const r = await classifyWithLlm(p, UNKNOWN, FAST);
    expect(r.answer).toBeNull();
    expect(p.calls).toBe(4);
    expect(r.attempts.every((a) => a.detail.startsWith('таймаут'))).toBe(true);
  });
});

describe('llmFallback in the pipeline', () => {
  const files = [...loadDir(), { filename: 'odd.txt', buffer: Buffer.from(UNKNOWN) }];

  it('is called only for unrecognised documents; result is needs_review and stays out of the table', async () => {
    const ctx = freshCtx();
    const before = resolve(ctx.db, '2026-03-10');
    processBatch(files, ctx);
    const p = fake([ok]);
    expect(await llmFallback(ctx, p)).toBe(1);
    expect(p.calls).toBe(1);
    expect(p.prompts[0]).toContain('STN-105');

    const doc = ctx.db.prepare("select doc_type, contract_no, classified_by, needs_review, llm_status from documents where filename = 'odd.txt'").get();
    expect(doc).toMatchObject({ doc_type: 'contract', contract_no: 'STN-105', classified_by: 'llm', needs_review: 1, llm_status: 'ok' });

    const res = resolve(ctx.db, '2026-03-10');
    expect(res.contracts.map((c) => c.contract_no)).toEqual(['STN-101', 'STN-102', 'STN-103']);
    expect(res.unlinked).toEqual([expect.objectContaining({ filename: 'odd.txt', reason: expect.stringMatching(/LLM.*требует проверки|требует проверки.*LLM/) })]);
    expect(before.contracts).toEqual([]);

    const trace = ctx.db.prepare("select rule_id, data from trace where rule_id like 'llm.%'").all() as { rule_id: string; data: string }[];
    expect(trace.map((t) => t.rule_id)).toEqual(['llm.attempt.ok', 'llm.classified']);
    expect(JSON.parse(trace[0]!.data)).toMatchObject({ provider: 'fake', model: 'fake-1', attempt: 1 });
    expect(trace.some((t) => t.data.includes('ДОКУМЕНТ:'))).toBe(false); // full prompt is never logged
  });

  it('without a provider: no error, document stays "needs review"', async () => {
    const ctx = freshCtx();
    processBatch(files, ctx);
    await llmFallback(ctx, null);
    const doc = ctx.db.prepare("select classified_by, needs_review, llm_status from documents where filename = 'odd.txt'").get();
    expect(doc).toMatchObject({ classified_by: 'rules', needs_review: 1, llm_status: 'disabled' });
    expect(resolve(ctx.db, '2026-03-10').unlinked).toEqual([expect.objectContaining({ filename: 'odd.txt', reason: expect.stringMatching(/Тип документа не распознан/) })]);
  });

  it('when the LLM keeps failing: fallback to "needs review", reference table unchanged', async () => {
    const ctx = freshCtx();
    processBatch(files, ctx);
    const p = fake([new Error('down')]);
    await llmFallback(ctx, p); // default config: 1 attempt + 3 retries with backoff
    expect(p.calls).toBe(4);
    const doc = ctx.db.prepare("select classified_by, llm_status, review_reason from documents where filename = 'odd.txt'").get() as Record<string, string>;
    expect(doc).toMatchObject({ classified_by: 'rules', llm_status: 'failed' });
    expect(doc.review_reason).toMatch(/LLM не дал валидного ответа/);
    expect(resolve(ctx.db, '2026-03-10').contracts).toHaveLength(3);
  }, 10_000);
});

describe('providerFromEnv', () => {
  it('is off without a key; the key is not exposed in the provider object', () => {
    expect(providerFromEnv({})).toBeNull();
    const p = providerFromEnv({ LLM_API_KEY: 'secret-test-key' })!;
    expect(p.name).toBe('gemini');
    expect(JSON.stringify(p)).not.toContain('secret-test-key');
  });
});
