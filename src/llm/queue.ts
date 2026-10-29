import type { Db } from '../db.js';
import type { Logger } from '../logger.js';
import { llmFallback, markLlmPending } from './fallback.js';
import type { LlmProvider } from './providers.js';

/**
 * Runs the LLM fallback in the background, one document at a time, so an upload never waits for the model.
 * A schedule() while a run is in progress is picked up right after it.
 */
export class LlmQueue {
  private running: Promise<void> | null = null;
  private again = false;

  constructor(private ctx: { db: Db; logger: Logger }, private provider: LlmProvider) {}

  /** Marks eligible documents «pending» and makes sure a worker is running. Returns how many are waiting. */
  schedule(batchId: string): number {
    markLlmPending(this.ctx.db);
    if (this.running) this.again = true;
    else this.running = this.loop(batchId).finally(() => { this.running = null; });
    return this.status().pending;
  }

  status() {
    const { n } = this.ctx.db.prepare("select count(*) as n from documents where llm_status = 'pending'").get() as { n: number };
    return { pending: n, running: this.running !== null };
  }

  /** Resolves when the queue is empty (tests, shutdown). */
  async idle() {
    while (this.running) await this.running;
  }

  private async loop(batchId: string) {
    do {
      this.again = false;
      try {
        const n = await llmFallback(this.ctx, this.provider, batchId);
        this.ctx.logger.info({ stage: 'llm', batch_id: batchId, documents: n }, 'background LLM pass done');
      } catch (err) {
        this.ctx.logger.error({ stage: 'llm', batch_id: batchId, err }, 'background LLM pass failed');
      }
    } while (this.again);
  }
}
