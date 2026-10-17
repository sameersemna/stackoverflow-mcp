/**
 * HTTP-layer primitives: credential redaction and retry timing.
 *
 * Responsibility: the parts of talking to an HTTP API that do not depend on the
 * Stack Exchange client — hiding secrets before they reach a client or a log, and
 * deciding how long to wait before a retry.
 *
 * Phase 3 grows this into the full request wrapper (timeout, abort, retry loop,
 * structured debug logging) with the clock and `fetch` injected rather than
 * taken from globals, so tests use fakes instead of mutating them.
 */
import { CancelledError } from "../errors.js"
import { RETRY_BASE_DELAY_MS } from "../config.js"

/**
 * Upper bound for a single retry delay, so a tool call cannot stall forever.
 *
 * Defined here because it only constrains the retry timing this module computes.
 */
export const MAX_RETRY_DELAY_MS = 30_000

const REDACTED = "***"

/**
 * Patterns that identify a credential in a message, URL or header dump.
 *
 * The Stack Exchange API accepts its key as the **`key` query parameter**, which
 * the original `api[_-]?key|token|authorization=` regex did not match, so a
 * request URL echoed into an error message leaked the key to the client.
 *
 * Order matters: URL query values are replaced before the generic `name=value`
 * rule so `?key=…&site=…` becomes `?key=***&site=…`.
 */
const SECRET_PATTERNS: readonly { pattern: RegExp; replacement: string }[] = [
  // `?key=…` / `&key=…` in a URL (the Stack Exchange API key).
  { pattern: /([?&]key=)[^&\s"'`]+/gi, replacement: `$1${REDACTED}` },
  // `Authorization: Bearer …` and `Authorization: …`.
  { pattern: /(authorization\s*:\s*(?:bearer\s+)?)\S+/gi, replacement: `$1${REDACTED}` },
  // `api_key=…`, `apiKey=…`, `token=…`, `authorization=…`, `access_token=…`.
  {
    pattern:
      /\b(api[_-]?key|apikey|access[_-]?token|token|authorization|password|secret)\s*[=:]\s*\S+/gi,
    replacement: `$1=${REDACTED}`,
  },
]

/**
 * Removes credentials from a message before it reaches a client or a log.
 *
 * Exported deliberately: pino's `redact` option censors **fields** by path, so a
 * URL logged as a plain string value (`logger.info({ url })`) is *not* covered
 * by any redaction path. Every URL that might carry an API key must be passed
 * through this function before it is logged.
 *
 * @param message - Raw text that may embed a request URL or header.
 * @returns The message with each detected credential replaced by `***`.
 */
export function redactSecrets(message: string): string {
  let redacted = message
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, replacement)
  }
  return redacted
}

/**
 * Delay before retry number `attempt` (1-based).
 *
 * Grows exponentially from {@link RETRY_BASE_DELAY_MS}, adds jitter so parallel
 * callers do not resynchronise, honours a larger `Retry-After`, and is capped at
 * {@link MAX_RETRY_DELAY_MS}.
 *
 * @param attempt - 1 for the first retry, 2 for the second, and so on.
 * @param retryAfterMs - Delay the API explicitly asked for, if any.
 */
export function computeRetryDelayMs(attempt: number, retryAfterMs: number | undefined): number {
  const exponential = RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1)
  // Full jitter over the upper half of the window keeps retries spread out
  // while still waiting long enough to matter.
  const jittered = exponential / 2 + Math.random() * (exponential / 2)
  const requested = retryAfterMs ?? 0
  return Math.min(Math.max(jittered, requested), MAX_RETRY_DELAY_MS)
}

/**
 * Reads the `Retry-After` header, which may be a number of seconds or an
 * HTTP-date.
 *
 * @returns The delay in milliseconds, or `undefined` when absent or unusable.
 */
export function retryAfterMs(response: {
  headers?: { get(name: string): string | null }
}): number | undefined {
  const raw = response.headers?.get("retry-after")
  if (!raw) {
    return undefined
  }

  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000
  }

  const date = Date.parse(raw)
  if (Number.isNaN(date)) {
    return undefined
  }
  return Math.max(0, date - Date.now())
}

/** Abort-aware promise delay used between retries. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve()
  }
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new CancelledError("The request was cancelled before it completed."))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new CancelledError("The request was cancelled before it completed."))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}
