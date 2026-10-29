import type { Db } from '../db.js';
import type { Logger } from '../logger.js';
import type { Stage, TraceEntry } from './types.js';

/**
 * Records pipeline decisions (not only errors): to the log with batch_id/document_id
 * and to the `trace` table so "why is this value here" can be answered later.
 */
export class Tracer {
  readonly entries: TraceEntry[] = [];
  private log: Logger;

  constructor(
    private db: Db,
    logger: Logger,
    readonly batchId: string,
    readonly filename: string,
    public documentId: number | null = null,
  ) {
    this.log = logger.child({ batch_id: batchId, filename });
  }

  attach(documentId: number) {
    this.documentId = documentId;
    this.log = this.log.child({ document_id: documentId });
  }

  record(stage: Stage, rule_id: string | null, message: string, data: Record<string, unknown> = {}, level: 'info' | 'debug' | 'warn' = 'info') {
    const entry: TraceEntry = { stage, rule_id, message, data };
    this.entries.push(entry);
    this.log[level]({ stage, rule_id, ...data }, message);
    // Debug entries (e.g. full document text) are persisted only when debug logging is on.
    if (level === 'debug' && !this.log.isLevelEnabled('debug')) return;
    this.db.prepare('insert into trace (batch_id, document_id, stage, rule_id, message, data) values (?, ?, ?, ?, ?, ?)')
      .run(this.batchId, this.documentId, stage, rule_id, message, JSON.stringify({ filename: this.filename, ...data }));
  }

  error(stage: Stage, err: unknown) {
    this.log.error({ stage, err }, 'stage failed');
    this.record(stage, null, 'Ошибка обработки', { error: err instanceof Error ? err.message : String(err) }, 'warn');
  }

  /** Runs a stage and logs its duration. */
  time<T>(stage: Stage, fn: () => T): T {
    const t0 = performance.now();
    const result = fn();
    this.log.info({ stage, duration_ms: Math.round((performance.now() - t0) * 100) / 100 }, 'stage done');
    return result;
  }
}
