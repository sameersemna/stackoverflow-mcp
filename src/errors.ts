/**
 * Typed errors for the Stack Overflow MCP server.
 *
 * Responsibility: give every failure an explicit category and an
 * LLM-actionable message. Previously *every* thrown value — validation failure,
 * network error, HTTP error, throttle and quota exhaustion — reached the client
 * as `Validation failed: …`, so a model could not tell "your arguments are bad"
 * from "you are out of quota until midnight UTC" from "Stack Overflow is down".
 *
 * Each subclass is safe to surface: messages never contain the API key (see
 * `redactSecrets` in `server.ts`).
 */

/** Stable machine-readable category for each failure. */
export type ErrorCode =
  | 'VALIDATION'
  | 'UPSTREAM'
  | 'QUOTA_EXHAUSTED'
  | 'THROTTLED'
  | 'TIMEOUT'
  | 'CANCELLED';

/** Base class for all errors this server raises deliberately. */
export class StackOverflowMcpError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions);
    this.name = new.target.name;
    this.code = code;
  }
}

/**
 * The caller's arguments did not satisfy the tool's schema.
 *
 * Carries the compact zod rendering so a model can correct the call without
 * guessing which field was wrong.
 */
export class ValidationError extends StackOverflowMcpError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('VALIDATION', message, options);
  }
}

/**
 * The Stack Exchange API answered with an error, or the response was unusable.
 *
 * `retryable` is false for deterministic failures (bad parameter, rejected
 * filter) so the caller does not spend quota retrying something that cannot
 * succeed.
 */
export class UpstreamError extends StackOverflowMcpError {
  readonly status: number | undefined;
  readonly errorId: number | undefined;
  readonly retryable: boolean;

  constructor(
    message: string,
    options?: { status?: number; errorId?: number; retryable?: boolean; cause?: unknown }
  ) {
    super('UPSTREAM', message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.status = options?.status;
    this.errorId = options?.errorId;
    this.retryable = options?.retryable ?? false;
  }
}

/** The daily (or per-key) request allowance is spent. Retrying cannot help. */
export class QuotaExhaustedError extends StackOverflowMcpError {
  readonly quotaRemaining: number | undefined;
  readonly quotaMax: number | undefined;

  constructor(
    message: string,
    options?: { quotaRemaining?: number; quotaMax?: number; cause?: unknown }
  ) {
    super(
      'QUOTA_EXHAUSTED',
      message,
      options?.cause === undefined ? undefined : { cause: options.cause }
    );
    this.quotaRemaining = options?.quotaRemaining;
    this.quotaMax = options?.quotaMax;
  }
}

/** Stack Exchange asked us to slow down. Retrying after a delay can help. */
export class ThrottledError extends StackOverflowMcpError {
  /** Delay the API explicitly requested, in milliseconds, when it gave one. */
  readonly requestedDelayMs: number | undefined;

  constructor(message: string, options?: { requestedDelayMs?: number; cause?: unknown }) {
    super(
      'THROTTLED',
      message,
      options?.cause === undefined ? undefined : { cause: options.cause }
    );
    this.requestedDelayMs = options?.requestedDelayMs;
  }
}

/** The request exceeded the configured time budget. */
export class TimeoutError extends StackOverflowMcpError {
  readonly timeoutMs: number;

  constructor(message: string, timeoutMs: number, options?: { cause?: unknown }) {
    super('TIMEOUT', message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.timeoutMs = timeoutMs;
  }
}

/** The MCP client cancelled the request through `extra.signal`. */
export class CancelledError extends StackOverflowMcpError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('CANCELLED', message, options?.cause === undefined ? undefined : { cause: options.cause });
  }
}

/** True when `error` is an abort raised by a timeout rather than the client. */
export function isTimeoutAbort(error: unknown): boolean {
  return error instanceof TimeoutError;
}

/**
 * Classifies any thrown value into one of the typed errors.
 *
 * Keeps the single `catch` site honest: whatever escapes the API layer becomes a
 * category the client can act on.
 */
export function toMcpError(error: unknown): StackOverflowMcpError {
  if (error instanceof StackOverflowMcpError) {
    return error;
  }
  if (error instanceof Error) {
    if (error.name === 'AbortError' || error.name === 'TimeoutError') {
      return new CancelledError('The request was cancelled before it completed.', { cause: error });
    }
    return new UpstreamError(error.message, { retryable: false, cause: error });
  }
  return new UpstreamError(String(error), { retryable: false });
}
