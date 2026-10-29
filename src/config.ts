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

  /** Contract number template, e.g. STN-101. Used everywhere a contract number is read from text. */
  contractNo: String.raw`[A-ZА-ЯЁ]{2,10}-\d+(?:[/-]\d+)*`,
  /** Date format in documents: dd.mm.yyyy */
  date: String.raw`(\d{2})\.(\d{2})\.(\d{4})`,

  /** Classifier dictionaries. Order matters: first match wins. */
  classify: {
    titles: [
      { rule_id: 'classify.title.draft', type: 'draft', re: String.raw`^ПРОЕКТ\s+ДОПОЛНИТЕЛЬНОГО\s+СОГЛАШЕНИЯ` },
      { rule_id: 'classify.title.amendment', type: 'amendment', re: String.raw`^ДОПОЛНИТЕЛЬНОЕ\s+СОГЛАШЕНИЕ` },
      { rule_id: 'classify.title.contract', type: 'contract', re: String.raw`^ДОГОВОР(?!\p{L})` },
      { rule_id: 'classify.title.letter', type: 'letter', re: String.raw`^ПИСЬМО(?!\p{L})` },
    ],
    docNo: String.raw`№\s*(\S+)`,
    docDate: String.raw`^Дата(?:\s+проекта)?\s*:\s*`,
    statusLine: String.raw`^Статус\s*:`,
    signedBoth: String.raw`подписан[оа]?\s+обеими\s+сторонами\s+`,
    unsigned: String.raw`не\s+подписан|(?<!\p{L})проект(?!\p{L})`,
    effective: String.raw`вступает\s+в\s+силу\s+(?:с\s+)?`,
  },

  llm: {
    provider: env.LLM_PROVIDER ?? 'none',
    model: env.LLM_MODEL ?? '',
    timeoutMs: 10_000,
    retries: 3,
  },
} as const;
