import { config } from '../config.js';
import { openDb } from '../db.js';
import { createLogger } from '../logger.js';
import { reprocessAll } from '../pipeline/process.js';
import { buildApp } from './app.js';

const logger = createLogger();
const db = openDb(config.dbFile);
// Stored documents are re-extracted so that rule or extractor changes apply to them too.
reprocessAll({ db, logger });
const app = await buildApp(logger, db);

try {
  await app.listen({ host: config.host, port: config.port });
} catch (err) {
  logger.error({ err }, 'server failed to start');
  process.exit(1);
}
