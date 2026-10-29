import { config } from '../config.js';
import { openDb } from '../db.js';
import { createLogger } from '../logger.js';
import { buildApp } from './app.js';

const logger = createLogger();
const db = openDb(config.dbFile);
const app = await buildApp(logger, db);

try {
  await app.listen({ host: config.host, port: config.port });
} catch (err) {
  logger.error({ err }, 'server failed to start');
  process.exit(1);
}
