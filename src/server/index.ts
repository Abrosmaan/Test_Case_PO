import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { buildApp } from './app.js';

const logger = createLogger();
const app = await buildApp(logger);

try {
  await app.listen({ host: config.host, port: config.port });
} catch (err) {
  logger.error({ err }, 'server failed to start');
  process.exit(1);
}
