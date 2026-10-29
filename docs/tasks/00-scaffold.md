# Этап 0. Каркас

**Сделано**
- Node + TypeScript strict, Fastify на `127.0.0.1:3000`, Vite (`web/`) на `127.0.0.1:5173` с прокси `/api` → Fastify.
- `npm run dev` поднимает оба процесса (concurrently), `npm test` (vitest), `npm run typecheck`.
- Логгер pino: читаемый вывод в консоль (pino-pretty) + JSON-строки в `logs/app.jsonl`. Уровень — `LOG_LEVEL`.
- Все настройки — `src/config.ts`; `.env.example` без секретов; `.gitignore` по SPEC.

**Решения**
- Сервер запускается через `tsx` (без сборки) — быстрее для прототипа.
- `buildApp(logger)` отделён от `listen`, чтобы тестировать API через `app.inject` без порта.

**Не решено**
- `npm run analyze` объявлен, CLI появится на этапе 1–4.
