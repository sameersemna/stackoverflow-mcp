import pino from 'pino';
import { z } from 'zod';

const envSchema = z.object({
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).optional(),
});

const parsedEnv = envSchema.safeParse({
  LOG_LEVEL: process.env.LOG_LEVEL,
});

const logLevel = parsedEnv.success && parsedEnv.data.LOG_LEVEL ? parsedEnv.data.LOG_LEVEL : 'info';

/**
 * Redaction paths (exported so the test-suite can prove they work).
 *
 * `key` is the parameter the Stack Exchange API uses for its key, and it appears
 * both as a top-level field and nested inside request/response objects — hence
 * the wildcard paths.
 */
export const REDACT_PATHS: readonly string[] = [
  'API_KEY',
  'STACKOVERFLOW_API_KEY',
  'password',
  'authorization',
  'apiKey',
  'api_key',
  'token',
  'access_token',
  'key',
  '*.key',
  '*.*.key',
  '*.apiKey',
  '*.*.apiKey',
  '*.authorization',
  '*.*.authorization',
  '*.token',
  '*.*.token',
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'headers.cookie',
];

export const logger = pino(
  {
    level: logLevel,
    redact: {
      paths: [...REDACT_PATHS],
      censor: '***',
    },
    formatters: {
      level: (label) => ({ level: label.toUpperCase() }),
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  pino.destination(2)
);
