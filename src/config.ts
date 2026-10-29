// All tunable values live here. Logic must not hardcode them.
import { existsSync } from 'node:fs';

// Optional local settings (.env is git-ignored). Real environment variables take precedence.
if (existsSync('.env') && !process.env.VITEST) process.loadEnvFile('.env');

const env = process.env;

export const config = {
  host: '127.0.0.1',
  port: Number(env.API_PORT ?? 3000),
  logLevel: env.LOG_LEVEL ?? 'info',
  logFile: env.LOG_FILE ?? 'logs/app.jsonl',
  dbFile: env.DB_FILE ?? 'data/app.db',

  /** Default check date (ISO). Overridable from env and from the UI. */
  checkDate: env.CHECK_DATE ?? '2026-03-10',

  upload: {
    maxFileBytes: 1024 * 1024,
    /** Files per upload request. More → a clear 413, the user splits the batch. */
    maxFiles: 500,
    allowedExtensions: ['.txt'],
  },

  /** Contract number template, e.g. STN-101. Used everywhere a contract number is read from text. */
  contractNo: String.raw`(?<![\p{L}\d])[A-ZА-ЯЁ]{2,10}-\d+(?:[/-]\d+)*(?![\p{L}\d])`,
  /**
   * Dates in documents, as ONE capturing group: 15.04.2026, 30.04.26, 2026-05-20, «15 апреля 2026 г.», «"28" марта 2026 года».
   * Parsed by parseDate() in src/pipeline/text.ts; an impossible date (31.02.2026) parses to null.
   */
  date: String.raw`((?:[«"“]?\d{1,2}[»"”]?\s+(?:январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр)\p{L}*\s+\d{4}(?:\s*(?:года|г\.?))?)|\d{4}-\d{2}-\d{2}|\d{1,2}\.\d{1,2}\.(?:\d{4}|\d{2})(?![\d\p{L}]))`,

  /** Classifier dictionaries. Order matters: first match wins. */
  classify: {
    titles: [
      { rule_id: 'classify.title.draft', type: 'draft', re: String.raw`^ПРОЕКТ\s+ДОПОЛНИТЕЛЬНОГО\s+СОГЛАШЕНИЯ` },
      { rule_id: 'classify.title.amendment', type: 'amendment', re: String.raw`^ДОПОЛНИТЕЛЬНОЕ\s+СОГЛАШЕНИЕ` },
      // Typo-tolerant: «ДОГОВР ПОСТАВКИ», «договор поставки» (titles are matched case-insensitively).
      { rule_id: 'classify.title.contract', type: 'contract', re: String.raw`^(?:ДОГОВОР(?!\p{L})|ДОГ[ОА]?В[ОА]?Р\s+ПОСТАВК)` },
      { rule_id: 'classify.title.letter', type: 'letter', re: String.raw`^ПИСЬМО(?!\p{L})` },
    ],
    docNo: String.raw`№\s*(\S+)`,
    docDate: String.raw`^Дата(?:\s+проекта)?\s*:\s*`,
    statusLine: String.raw`^Статус\s*:`,
    signedBoth: String.raw`подписан[оа]?\s+об[еоа]ими\s+сторон\p{L}*\s+`, // «обоими» — частая опечатка
    unsigned: String.raw`не\s+подписан|(?<!\p{L})проект(?!\p{L})`,
    effective: String.raw`вступает\s+в\s+силу\s+(?:с\s+)?`,
  },

  /** Extractor dictionaries. */
  extract: {
    /** «Пункт X.Y договора изложить в следующей редакции: «…»» */
    replaceClause: String.raw`Пункт\s+(\d+(?:\.\d+)*)\s+договора\s+изложить\s+в\s+(?:следующей|новой)\s+редакции\s*:\s*«(.*)»`,
    supplier: String.raw`Поставщик\s*:\s*((?:ООО|АО|ПАО|ЗАО|ОАО|ИП)\s*«[^»]+»|[^.;\n]+)`,
    amount: {
      // Thousands by space, NBSP or dot («1.200.000,00»); never starts in the middle of a number («1 200 00 0»).
      money: String.raw`(?<!\d[ \u00a0.]?)(\d{1,3}(?:[ \u00a0.]\d{3})+|\d+)(?:[.,](\d{2}))?\s*(?:\([^)]*\)\s*)?(?:рубл\p{L}*|руб\.|₽)`,
      /** A clause that names a sum in roubles at all: if no amount parses in it, a person must look. */
      moneyWord: String.raw`рубл|руб\.|₽`,
      /** A sum in another currency: never shown as roubles, a person decides. */
      foreignCurrency: String.raw`доллар|евро(?!\p{L})|юан|USD|EUR|CNY|\$|€`,
      // «Общая стоимость» (also «Обшая»), «Цена договора», «Стоимость договора».
      trigger: String.raw`об[щш]\p{L}*\s+стоимост\p{L}*|цен\p{L}*\s+(?:настоящего\s+)?договор|стоимост\p{L}*\s+(?:настоящего\s+)?договор`,
      // «Ориентировочная/предварительная стоимость» is not the agreed total.
      stopWords: ['аванс', 'лимит', 'бюджет', 'срок оплаты', 'неустойк', 'штраф', 'ориентировоч', 'предварительн'],
    },
    deliveryDate: {
      /** «поставить … не позднее DATE» */
      deadline: String.raw`постав\p{L}*[^.]*?не\s+позд\p{L}{2,4}\s+`, // «не позднее», опечатка «не позденее»
      /** A deadline is there but is not a usable date: «в течение 45 дней», «30.04.2O26», «31.02.2026» → review. */
      unparsed: String.raw`не\s+позд\p{L}{2,4}\s+\S|в\s+течение\s+\d+|до\s+\d{1,2}[./]`,
      /** «изменить/перенести срок поставки (с DATE) на DATE» */
      change: String.raw`срок\p{L}*\s+поставки\s+(?:с\s+(?:DATE)\s+)?на\s+`,
      context: String.raw`постав\p{L}*`,
      /** Any further «не позднее DATE» in a clause that already set a delivery deadline (staged delivery). */
      extraDeadline: String.raw`не\s+позд\p{L}{2,4}\s+`,
      stopWords: ['оплат', 'приемк', 'приёмк'],
    },
    /** «Стороны договорились расторгнуть договор (с DATE)» */
    termination: {
      trigger: String.raw`расторг\p{L}*\s+(?:настоящ\p{L}*\s+)?договор|договор\p{L}*\s+(?:\S+\s+){0,3}?расторгнут\p{L}*|прекра\p{L}*\s+действи\p{L}*\s+договор`,
      date: String.raw`(?:с|со|с\s+даты)\s+`,
    },
    /**
     * Amendment clauses that do not change terms. Any other numbered clause of an applied amendment
     * that is neither «изложить в редакции» nor termination is an unrecognised change → needs review.
     */
    amendmentBoilerplate: String.raw`без\s+изменени|вступает\s+в\s+силу|вступа\p{L}*\s+в\s+силу|составлен\p{L}*\s+в\s+\S+\s+экземпляр|неотъемлем\p{L}*\s+част`,
    /** Which tracked field an unrecognised amendment clause probably touches. */
    fieldHints: {
      total_amount: String.raw`стоимост|сумм|цен[аыу]`,
      delivery_date: String.raw`срок\p{L}*\s+поставк|постав\p{L}*\s+(?:\S+\s+){0,3}?не\s+позднее`,
      penalty_rate: String.raw`неустойк|пен[яиеё]`,
      supplier: String.raw`поставщик\p{L}*\s*:|замен\p{L}*\s+поставщик`,
    },
    penaltyRate: {
      trigger: String.raw`неустойк\p{L}*|пен(?:я|и|ей)(?!\p{L})`,
      percent: String.raw`(\d+(?:[.,]\d+)?)\s*%`,
      perDay: String.raw`за\s+каждый\s+(?:календарный\s+)?день`,
      cap: String.raw`не\s+более\s+(\d+(?:[.,]\d+)?)\s*%`,
    },
  },

  /**
   * Optional LLM fallback: classification of documents the rules could not recognise.
   * provider: 'auto' = Gemini if LLM_API_KEY is set, else off; 'gemini' | 'ollama' | 'none'.
   * The key itself is read only inside src/llm/providers.ts and never logged.
   */
  llm: {
    provider: env.LLM_PROVIDER ?? 'auto',
    model: env.LLM_MODEL ?? '',
    defaultModels: { gemini: 'gemini-2.5-flash', ollama: 'qwen3:8b' },
    ollamaUrl: env.OLLAMA_URL ?? 'http://127.0.0.1:11434',
    timeoutMs: Number(env.LLM_TIMEOUT_MS ?? 15_000),
    /** Retries after the first attempt on network errors and timeouts, with exponential backoff. */
    retries: 3,
    /**
     * Retries on an invalid answer (not JSON, wrong schema, quote not in the text). With temperature 0
     * the model tends to repeat itself, so one retry is enough — more only burns time and tokens.
     */
    invalidRetries: 1,
    backoffMs: 500,
    /** Only the beginning of the document is sent: title and requisites are enough to classify. */
    maxChars: 6000,
    /**
     * Text that looks like instructions to a model. Such a document is never sent to the LLM:
     * it stays «требует проверки» with this reason. Regular contracts do not contain these phrases.
     */
    injectionPatterns: [
      String.raw`игнорир\p{L}*\s+(?:вс\p{L}+\s+)?(?:предыдущ|прошл|вышеуказ|прежн)\p{L}*`,
      String.raw`забудь\s+(?:вс[её]|предыдущ\p{L}*|инструкц\p{L}*)`,
      String.raw`(?:системн\p{L}*|новые)\s+(?:сообщени|промпт|инструкци|указани)\p{L}*`,
      String.raw`(?:ответь|верни|выведи|отвечай)\s+(?:строго|только|ровно)?\s*(?:json|\{|«\{|"\{)`,
      String.raw`ты\s+(?:—\s*|-\s*)?(?:ии|ассистент|модель|языков\p{L}*\s+модель|нейросеть)`,
      String.raw`ignore\s+(?:all\s+)?(?:previous|prior|above|earlier)`,
      String.raw`system\s*prompt|you\s+are\s+(?:an?\s+)?(?:ai|assistant|language\s+model)`,
      String.raw`"?(?:doc_type|contract_no)"?\s*:`,
      // Steering the classification itself: business documents never talk about how to classify them.
      String.raw`классифицир\p{L}*|для\s+автоматическ\p{L}*\s+(?:обработк|систем)\p{L}*|систем\p{L}*\s+ИИ(?!\p{L})`,
    ],
  },
} as const;
