import { defineConfig, devices } from '@playwright/test';

// e2e runs on its own ports and database, with the LLM off, so it never touches data/app.db
// and does not depend on a running Ollama (env vars take precedence over .env).
const API_PORT = 3101;
const WEB_PORT = 5174;
const DB_FILE = 'data/e2e.db';

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1, // one shared server and database
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
    viewport: { width: 1400, height: 900 },
  },
  webServer: {
    // The database is reset here, once: this config file is evaluated again in every worker process,
    // and deleting the file from there would pull it from under the running server.
    command: `node -e "require('fs').rmSync('${DB_FILE}', { force: true })" && concurrently -k -n api,web "tsx src/server/index.ts" "vite"`,
    url: `http://127.0.0.1:${WEB_PORT}/api/health`,
    reuseExistingServer: false,
    stdout: process.env.E2E_SERVER_LOG ? 'pipe' : 'ignore',
    stderr: 'pipe',
    timeout: 60_000,
    env: {
      API_PORT: String(API_PORT), WEB_PORT: String(WEB_PORT), DB_FILE,
      LLM_PROVIDER: 'none', LOG_LEVEL: 'warn', CHECK_DATE: '2026-03-10',
    },
  },
});
