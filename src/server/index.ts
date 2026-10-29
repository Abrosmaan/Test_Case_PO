import { config } from '../config.js';
import { openDb } from '../db.js';
import { createLogger } from '../logger.js';
import { providerFromEnv } from '../llm/providers.js';
import { reprocessAll } from '../pipeline/process.js';
import { buildApp } from './app.js';

const logger = createLogger();
const db = openDb(config.dbFile);
// Stored documents are re-extracted so that rule or extractor changes apply to them too.
reprocessAll({ db, logger });
const llm = providerFromEnv();
logger.info({ stage: 'llm', provider: llm?.name ?? 'none', model: llm?.model ?? null }, llm ? 'LLM fallback on' : 'LLM fallback off (no key) — unrecognised documents go to "needs review"');
const app = await buildApp(logger, db, llm);

try {
  await app.listen({ host: config.host, port: config.port });
} catch (err) {
  logger.error({ err }, 'server failed to start');
  process.exit(1);
}
