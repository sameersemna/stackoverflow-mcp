/**
 * Structured logger.
 *
 * Responsibility: the one logger every module uses, writing **only to stderr**.
 *
 * The stdout rule is not cosmetic: in stdio transport mode stdout carries the MCP
 * protocol, so a single stray log line corrupts the stream. `pino.destination(2)`
 * enforces it, and `logging.test.ts` guards it.
 */
import pino from 'pino';
import { LOG_LEVEL } from '../config.js';

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
    level: LOG_LEVEL,
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
