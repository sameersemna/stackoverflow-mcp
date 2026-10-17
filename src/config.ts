/**
 * Process configuration.
 *
 * Responsibility: the single place that reads and validates environment
 * variables, so no other module has to know their names, defaults or parsing
 * rules. Phase 1 left two overlapping copies of this logic (`server.ts` read
 * `PORT`, `STACKOVERFLOW_API_KEY` and `DEFAULT_LIMIT`, `cli.ts` read `PORT` and
 * `STACKOVERFLOW_API_KEY` again); this module removes that duplication.
 *
 * Values are resolved once at import time, so importing this module also freezes
 * configuration for the process. Phase 7 expands the schema with the HTTP,
 * cache and logging variables, and turns configuration into an injectable
 * dependency so tests can supply their own instead of mutating `process.env`.
 *
 * Invalid values are reported with a clear message rather than silently
 * defaulting, because a typo in a systemd unit or `.env` file is otherwise
 * invisible.
 */
import * as z from 'zod';

/** A non-negative integer read from the environment. */
const numericString = z
  .string()
  .trim()
  .regex(/^\d+$/, 'must be a non-negative integer')
  .transform((value) => Number(value));

const envSchema = z.object({
  /** Requests per second allowed by the client-side limiter. */
  RATE_LIMIT_RPS: numericString.optional(),
  /** When set, the process serves streamable HTTP instead of stdio. */
  PORT: numericString.optional(),
  /** Optional Stack Exchange API key: raises the daily quota from ~300 to ~10,000. */
  STACKOVERFLOW_API_KEY: z.string().trim().min(1).optional(),
  /** Page size used when a tool call omits `limit`. */
  DEFAULT_LIMIT: numericString.optional(),
  /** Per-request time budget in milliseconds. */
  REQUEST_TIMEOUT_MS: numericString.optional(),
  /** Base delay for the first retry in milliseconds. */
  RETRY_BASE_DELAY_MS: numericString.optional(),
});

const parsed = envSchema.safeParse({
  RATE_LIMIT_RPS: process.env.RATE_LIMIT_RPS,
  PORT: process.env.PORT,
  STACKOVERFLOW_API_KEY: process.env.STACKOVERFLOW_API_KEY,
  DEFAULT_LIMIT: process.env.DEFAULT_LIMIT,
  REQUEST_TIMEOUT_MS: process.env.REQUEST_TIMEOUT_MS,
  RETRY_BASE_DELAY_MS: process.env.RETRY_BASE_DELAY_MS,
});

if (!parsed.success) {
  // Configuration errors are fatal and must be visible on stderr; stdout is
  // reserved for the stdio protocol.
  const details = parsed.error.issues
    .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
  throw new Error(`Invalid environment configuration:\n${details}`);
}

/**
 * Default page size when a tool call omits `limit`.
 *
 * The Stack Exchange default is 30, and because each question carries its body,
 * answers and optionally comments, 30 results routinely blow past the character
 * budget and get truncated — spending quota on content the client never sees.
 * Five results are enough to answer a search and cost a fraction of the quota.
 */
export const DEFAULT_LIMIT = parsed.data.DEFAULT_LIMIT ?? 5;

/** Per-request time budget, so a hung connection cannot hang a tool call. */
export const REQUEST_TIMEOUT_MS = parsed.data.REQUEST_TIMEOUT_MS ?? 15_000;

/** Base delay for the first retry; jittered exponential growth starts here. */
export const RETRY_BASE_DELAY_MS = parsed.data.RETRY_BASE_DELAY_MS ?? 1000;

/**
 * Maximum requests per second the client limiter permits.
 *
 * Stack Exchange documents a 30 requests/second concurrent throttle. 25 leaves a
 * safety margin for the requests already in flight and for other clients sharing
 * the same IP. The brief for this work assumed the same default.
 */
export const MAX_REQUESTS_PER_SECOND = parsed.data.RATE_LIMIT_RPS ?? 25;

/** Length of the sliding rate-limit window. */
export const RATE_LIMIT_WINDOW_MS = 1000;

/** Minimum delay between consecutive requests (~25 req/s = 40 ms apart). */
export const MIN_DELAY_BETWEEN_REQUESTS_MS = Math.floor(1000 / MAX_REQUESTS_PER_SECOND);

/** The API key, or `undefined` when running on the anonymous quota. */
export const API_KEY = parsed.data.STACKOVERFLOW_API_KEY;

/** The HTTP port, or `undefined` for stdio mode. */
export const PORT = parsed.data.PORT;

/** True when the process is configured for HTTP transport (`PORT` set). */
export const USE_HTTP_TRANSPORT = PORT !== undefined;
