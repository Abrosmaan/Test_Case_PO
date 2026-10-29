import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import pino, { type Logger } from 'pino';
import { config } from './config.js';

export type { Logger };

/** Console (pretty) + JSON lines file. Never log secrets or .env contents. */
export function createLogger(opts: { pretty?: boolean; file?: string | false } = {}): Logger {
  const file = opts.file ?? config.logFile;
  const targets: pino.TransportTargetOptions[] = [
    opts.pretty === false
      ? { target: 'pino/file', options: { destination: 1 }, level: config.logLevel }
      : { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' }, level: config.logLevel },
  ];
  if (file) {
    mkdirSync(dirname(file), { recursive: true });
    targets.push({ target: 'pino/file', options: { destination: file, append: true }, level: config.logLevel });
  }
  return pino({ level: config.logLevel, redact: ['req.headers.authorization', '*.apiKey', '*.LLM_API_KEY'] }, pino.transport({ targets }));
}

/** Silent logger for tests. */
export const silentLogger: Logger = pino({ level: 'silent' });
