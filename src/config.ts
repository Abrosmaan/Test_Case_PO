// All tunable values live here. Logic must not hardcode them.

const env = process.env;

export const config = {
  host: '127.0.0.1',
  port: Number(env.PORT ?? 3000),
  logLevel: env.LOG_LEVEL ?? 'info',
  logFile: 'logs/app.jsonl',
  dbFile: env.DB_FILE ?? 'data/app.db',

  /** Default check date (ISO). Overridable from env and from the UI. */
  checkDate: env.CHECK_DATE ?? '2026-03-10',

  upload: {
    maxFileBytes: 1024 * 1024,
    allowedExtensions: ['.txt'],
  },

  llm: {
    provider: env.LLM_PROVIDER ?? 'none',
    model: env.LLM_MODEL ?? '',
    timeoutMs: 10_000,
    retries: 3,
  },
} as const;
