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

  /** Extractor dictionaries. */
  extract: {
    /** «Пункт X.Y договора изложить в следующей редакции: «…»» */
    replaceClause: String.raw`Пункт\s+(\d+(?:\.\d+)*)\s+договора\s+изложить\s+в\s+(?:следующей|новой)\s+редакции\s*:\s*«(.*)»`,
    supplier: String.raw`Поставщик\s*:\s*((?:ООО|АО|ПАО|ЗАО|ОАО|ИП)\s*«[^»]+»|[^.;\n]+)`,
    amount: {
      money: String.raw`(\d{1,3}(?:[ \u00a0]\d{3})+|\d+)(?:[.,](\d{2}))?\s*(?:\([^)]*\)\s*)?(?:рубл\p{L}*|руб\.|₽)`,
      trigger: String.raw`общ\p{L}*\s+стоимост\p{L}*`,
      stopWords: ['аванс', 'лимит', 'бюджет', 'срок оплаты', 'неустойк', 'штраф'],
    },
    deliveryDate: {
      /** «поставить … не позднее DATE» */
      deadline: String.raw`постав\p{L}*[^.]*?не\s+позднее\s+`,
      /** «изменить/перенести срок поставки (с DATE) на DATE» */
      change: String.raw`срок\p{L}*\s+поставки\s+(?:с\s+(?:DATE)\s+)?на\s+`,
      context: String.raw`постав\p{L}*`,
      stopWords: ['оплат', 'приемк', 'приёмк'],
    },
  },

  llm: {
    provider: env.LLM_PROVIDER ?? 'none',
    model: env.LLM_MODEL ?? '',
    timeoutMs: 10_000,
    retries: 3,
  },
} as const;
