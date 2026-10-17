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
import * as z from "zod"

/** A non-negative integer read from the environment. */
const numericString = z
  .string()
  .trim()
  .regex(/^\d+$/, "must be a non-negative integer")
  .transform((value) => Number(value))

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
  /** Address to bind in HTTP mode. Loopback by default; expose deliberately. */
  HOST: z.string().trim().min(1).optional(),
  /** Comma-separated hostnames allowed in the `Host` header. */
  ALLOWED_HOSTS: z.string().optional(),
  /** Comma-separated origins allowed in the `Origin` header. */
  ALLOWED_ORIGINS: z.string().optional(),
  /** Bearer token required on `/mcp` when set. */
  MCP_AUTH_TOKEN: z.string().min(1).optional(),
  /** Escape hatch to bind a non-loopback address without a token. */
  ALLOW_INSECURE: z.string().optional(),
  /** Maximum concurrent HTTP sessions before LRU eviction. */
  MAX_SESSIONS: numericString.optional(),
  /** Idle timeout for an HTTP session, in milliseconds. */
  SESSION_IDLE_TTL_MS: numericString.optional(),
  /** Deadline for graceful shutdown, in milliseconds. */
  SHUTDOWN_TIMEOUT_MS: numericString.optional(),
  /** Requests per second allowed per client address on `/mcp`. */
  MCP_REQUESTS_PER_SECOND: numericString.optional(),
  /** Serve each request on a fresh stateless transport. */
  STATELESS: z.string().optional(),
  /** pino log level. Logs always go to stderr; stdout is the stdio protocol channel. */
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).optional(),
})

const parsed = envSchema.safeParse({
  RATE_LIMIT_RPS: process.env.RATE_LIMIT_RPS,
  PORT: process.env.PORT,
  STACKOVERFLOW_API_KEY: process.env.STACKOVERFLOW_API_KEY,
  DEFAULT_LIMIT: process.env.DEFAULT_LIMIT,
  REQUEST_TIMEOUT_MS: process.env.REQUEST_TIMEOUT_MS,
  RETRY_BASE_DELAY_MS: process.env.RETRY_BASE_DELAY_MS,
  HOST: process.env.HOST,
  ALLOWED_HOSTS: process.env.ALLOWED_HOSTS,
  ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS,
  MCP_AUTH_TOKEN: process.env.MCP_AUTH_TOKEN,
  ALLOW_INSECURE: process.env.ALLOW_INSECURE,
  MAX_SESSIONS: process.env.MAX_SESSIONS,
  SESSION_IDLE_TTL_MS: process.env.SESSION_IDLE_TTL_MS,
  SHUTDOWN_TIMEOUT_MS: process.env.SHUTDOWN_TIMEOUT_MS,
  MCP_REQUESTS_PER_SECOND: process.env.MCP_REQUESTS_PER_SECOND,
  STATELESS: process.env.STATELESS,
  LOG_LEVEL: process.env.LOG_LEVEL,
})

if (!parsed.success) {
  // Configuration errors are fatal and must be visible on stderr; stdout is
  // reserved for the stdio protocol.
  const details = parsed.error.issues
    .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n")
  throw new Error(`Invalid environment configuration:\n${details}`)
}

/**
 * Default page size when a tool call omits `limit`.
 *
 * The Stack Exchange default is 30, and because each question carries its body,
 * answers and optionally comments, 30 results routinely blow past the character
 * budget and get truncated — spending quota on content the client never sees.
 * Five results are enough to answer a search and cost a fraction of the quota.
 */
export const DEFAULT_LIMIT = parsed.data.DEFAULT_LIMIT ?? 5

/** Per-request time budget, so a hung connection cannot hang a tool call. */
export const REQUEST_TIMEOUT_MS = parsed.data.REQUEST_TIMEOUT_MS ?? 15_000

/** Base delay for the first retry; jittered exponential growth starts here. */
export const RETRY_BASE_DELAY_MS = parsed.data.RETRY_BASE_DELAY_MS ?? 1000

/**
 * Maximum requests per second the client limiter permits.
 *
 * Stack Exchange documents a 30 requests/second concurrent throttle. 25 leaves a
 * safety margin for the requests already in flight and for other clients sharing
 * the same IP. The brief for this work assumed the same default.
 */
export const MAX_REQUESTS_PER_SECOND = parsed.data.RATE_LIMIT_RPS ?? 25

/** Length of the sliding rate-limit window. */
export const RATE_LIMIT_WINDOW_MS = 1000

/** Minimum delay between consecutive requests (~25 req/s = 40 ms apart). */
export const MIN_DELAY_BETWEEN_REQUESTS_MS = Math.floor(1000 / MAX_REQUESTS_PER_SECOND)

/** The API key, or `undefined` when running on the anonymous quota. */
export const API_KEY = parsed.data.STACKOVERFLOW_API_KEY

/** The HTTP port, or `undefined` for stdio mode. */
export const PORT = parsed.data.PORT

/**
 * Address the HTTP transport binds to.
 *
 * Loopback by default: exposing an unauthenticated service that spends the
 * owner's API quota should be a deliberate act, not the default. Containers set
 * `HOST=0.0.0.0` explicitly.
 */
export const HOST = parsed.data.HOST ?? "127.0.0.1"

/** Hostnames accepted in the `Host` header, when configured. */
export const ALLOWED_HOSTS: string[] | undefined = splitList(parsed.data.ALLOWED_HOSTS)

/** Origins accepted in the `Origin` header, when configured. */
export const ALLOWED_ORIGINS: string[] | undefined = splitList(parsed.data.ALLOWED_ORIGINS)

/** Bearer token required on `/mcp`, when configured. */
export const MCP_AUTH_TOKEN = parsed.data.MCP_AUTH_TOKEN

/**
 * Escape hatch allowing a non-loopback bind without a token.
 *
 * Explicit and named so that it is obviously a decision, never an accident.
 */
export const ALLOW_INSECURE = parsed.data.ALLOW_INSECURE === "1"

/** Maximum concurrent HTTP sessions. */
export const MAX_SESSIONS = parsed.data.MAX_SESSIONS ?? 100

/** Idle timeout for an HTTP session. */
export const SESSION_IDLE_TTL_MS = parsed.data.SESSION_IDLE_TTL_MS ?? 30 * 60 * 1000

/** Deadline for graceful shutdown. */
export const SHUTDOWN_TIMEOUT_MS = parsed.data.SHUTDOWN_TIMEOUT_MS ?? 10_000

/** Requests per second allowed per client address on `/mcp`. */
export const MCP_REQUESTS_PER_SECOND = parsed.data.MCP_REQUESTS_PER_SECOND ?? 100

/** Whether each request gets a fresh stateless transport. */
export const STATELESS = parsed.data.STATELESS === "1"

/** Log level for pino. */
export const LOG_LEVEL = parsed.data.LOG_LEVEL ?? "info"

/** True when the process is configured for HTTP transport (`PORT` set). */
export const USE_HTTP_TRANSPORT = PORT !== undefined

/** True when the configured bind address can only be reached locally. */
export const BINDS_TO_LOOPBACK = isLoopbackHost(HOST)

/**
 * Splits a comma-separated environment value.
 *
 * @param raw - Raw value, or `undefined`.
 * @returns Trimmed non-empty entries, or `undefined` when nothing was configured.
 */
function splitList(raw: string | undefined): string[] | undefined {
  if (raw === undefined) {
    return undefined
  }
  const parts = raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
  return parts.length > 0 ? parts : undefined
}

/**
 * True for addresses that are only reachable from the local machine.
 *
 * @param host - Bind address or hostname.
 */
export function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]"
}

/**
 * Validates that the HTTP configuration is safe, refusing to start otherwise.
 *
 * Called by `cli.ts` before binding, so a mistake surfaces immediately with an
 * actionable message rather than as an exposed service.
 *
 * @throws Error when the configuration would expose the server insecurely.
 */
export function assertHttpConfigIsSafe(): void {
  if (!USE_HTTP_TRANSPORT || BINDS_TO_LOOPBACK || ALLOW_INSECURE) {
    return
  }
  if (!MCP_AUTH_TOKEN) {
    throw new Error(
      `Refusing to bind ${HOST} without authentication. Set MCP_AUTH_TOKEN, or ` +
        "restrict access with ALLOWED_HOSTS and ALLOWED_ORIGINS, or set " +
        "ALLOW_INSECURE=1 to accept the risk deliberately."
    )
  }
  if (!ALLOWED_HOSTS) {
    throw new Error(
      `Refusing to bind ${HOST} without ALLOWED_HOSTS. Set it to the hostnames ` +
        "clients will use, or set ALLOW_INSECURE=1 to accept the risk deliberately."
    )
  }
}
