import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { silentLogger } from '../src/logger.js';
import { buildApp } from '../src/server/app.js';

describe('server', () => {
  it('responds to health check', async () => {
    const app = await buildApp(silentLogger, openDb(':memory:'));
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.json()).toEqual({ ok: true });
    await app.close();
  });
});
