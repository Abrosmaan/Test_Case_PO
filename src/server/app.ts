import Fastify from 'fastify';
import type { Logger } from '../logger.js';

export async function buildApp(logger: Logger) {
  const app = Fastify({ loggerInstance: logger });

  app.get('/api/health', async () => ({ ok: true }));

  return app;
}
