/**
 * Stack Overflow MCP Server.
 *
 * Responsibility: everything that can be tested without a transport — the
 * `StackOverflowServer` class (MCP tools, resources, prompts) and the pure
 * helpers it uses (query variants, truncation, HTML-to-text, error cleaning).
 *
 * Process-level concerns deliberately live elsewhere: configuration and
 * transport selection in `cli.ts`, the HTTP/Express layer in `transports/http.ts`
 * (Phase 2). Importing this module has no side effects.
 *
 * Features:
 * - Search by error messages, tags, or stack traces
 * - Rate limiting with backoff handling
 * - API quota monitoring
 * - Structured logging with Pino
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { TextContent } from '@modelcontextprotocol/sdk/types.js';
import * as z from 'zod';
import { logger } from './utils/logger.js';
import { computeRetryDelayMs, redactSecrets, retryAfterMs, sleep } from './core/http.js';
import { RateLimiter } from './core/rateLimiter.js';
import { buildQuotaMessage } from './core/messages.js';
import { QuotaTracker } from './core/quota.js';
import {
  ResponseCache,
  cacheKey,
  type CacheKind,
  type CacheTtls,
} from './core/cache.js';
import { registerPrompts } from './prompts.js';
import { registerResources } from './resources.js';
import { SERVER_NAME, VERSION } from './version.js';
import {
  API_KEY,
  DEFAULT_LIMIT,
  MAX_REQUESTS_PER_SECOND,
  MIN_DELAY_BETWEEN_REQUESTS_MS,
  RATE_LIMIT_WINDOW_MS,
  REQUEST_TIMEOUT_MS,
  RETRY_BASE_DELAY_MS,
  USE_HTTP_TRANSPORT,
} from './config.js';
import { ANSWER_FILTER, COMMENT_FILTER, DEFAULT_FILTER } from './stackexchange/filters.js';
import {
  analyzeStackTraceInputSchema,
  searchByErrorInputSchema,
  searchByQueryInputSchema,
  searchByQuestionIdInputSchema,
  searchByTagsInputSchema,
} from './tools/schemas.js';
import { formatJson } from './format/json.js';
import {
  buildQueryVariants,
  cleanErrorMessage,
  extractErrorMessage,
} from './stackexchange/query.js';
import { formatMarkdown } from './format/markdown.js';
import { truncateJson, truncateText } from './format/truncate.js';
import {
  CancelledError,
  QuotaExhaustedError,
  TimeoutError,
  StackOverflowMcpError,
  ThrottledError,
  UpstreamError,
  ValidationError,
  toMcpError,
} from './errors.js';
import {
  SearchByErrorInputSchema,
  SearchByTagsInputSchema,
  StackTraceInputSchema,
  SearchByQueryInputSchema,
  SearchByQuestionIdInputSchema,
} from './types/index.js';
import type {
  SearchByErrorInput,
  SearchByTagsInput,
  StackTraceInput,
  SearchByQueryInput,
  SearchByQuestionIdInput,
  SearchResult,
  PagedSearchResults,
  PaginationMeta,
  StackOverflowQuestion,
  StackOverflowAnswer,
  StackOverflowComment,
  SearchResultComments,
  ApiErrorResponse,
  ApiResponse,
} from './types/index.js';

/**
 * Re-exports kept for compatibility.
 *
 * Seventeen test suites import these from `server.ts`, and Phase 2 is a pure
 * refactor, so the facade keeps the public surface stable (see
 * docs/adr/0001-module-layout.md). A later phase can migrate the imports.
 */
export { truncateText, truncateJson, CHARACTER_LIMIT } from './format/truncate.js';
export { redactSecrets, computeRetryDelayMs } from './core/http.js';
export { buildQueryVariants, cleanErrorMessage, extractErrorMessage } from './stackexchange/query.js';
export { htmlToText, decodeHtmlEntities } from './format/html.js';

const STACKOVERFLOW_API = 'https://api.stackexchange.com/2.3';

/**
 * Process configuration this module needs.
 *
 * NOTE (temporary, until Phase 7): configuration is read once at module load and
 * is therefore not injectable per instance. `cli.ts` parses `PORT` with the same
 * rules to decide the transport; Phase 7 replaces both with a single validated
 * `config.ts` and injects it into `createStackOverflowServer(deps)`.
 */

/**
 * Rate Limiting Configuration
 * Stack Exchange API allows 30 requests/second (concurrent throttle).
 * We use 25/sec with safety margin to account for concurrent requests.
 */

/**
 * Maximum number of retries after the first attempt.
 *
 * Throttling and transient network errors are worth two retries; more than that
 * mostly burns allowance, and Stack Exchange throttles per IP.
 */
const MAX_RETRIES = 2;

const QUOTA_WARNING_THRESHOLD = 100;

/**
 * Maximum number of semicolon-separated IDs accepted in one vectorized request.
 *
 * Stack Exchange documents a hard cap of 100 for `/{method}/{ids}` endpoints
 * (for example `/questions/{ids}/answers` and `/posts/{ids}/comments`).
 * Exceeding it makes the API reject the whole request, which previously broke
 * `includeComments: true` for any result set whose questions and answers
 * together exceeded 100 posts.
 */
const MAX_IDS_PER_REQUEST = 100;

/**
 * Maximum number of pages fetched per answers request.
 *
 * Answers are requested with `pagesize=100` and the API sorts the whole
 * multi-question result set by votes, so the most popular question can consume
 * an entire page and leave others with none. Paging until `has_more` is false
 * fixes that; the cap keeps a pathological result set from burning the daily
 * quota. Formatted output only renders `MAX_ANSWERS` answers per question, so a
 * few pages are always more than enough.
 */
const MAX_ANSWER_PAGES = 3;

/**
 * Splits an ID list into chunks the API will accept.
 *
 * @param ids - IDs to split; order is preserved and duplicates are removed so a
 *   post that is both a question and an answer is not requested twice.
 * @param size - Maximum chunk size (defaults to {@link MAX_IDS_PER_REQUEST}).
 */
function chunkIds(ids: readonly number[], size: number = MAX_IDS_PER_REQUEST): number[][] {
  const unique = [...new Set(ids)];
  if (unique.length === 0) {
    return [];
  }
  const chunks: number[][] = [];
  for (let index = 0; index < unique.length; index += size) {
    chunks.push(unique.slice(index, index + size));
  }
  return chunks;
}

/**
 * Explains an exhausted allowance in terms a model can act on.
 *
 * Only suggests an API key when none is configured, so the advice is never
 * useless.
 */
/**
 * Renders a zod error on a single line for an LLM to read.
 *
 * `z.prettifyError` produces a friendly multi-line report; collapsing it keeps
 * the tool result compact while staying far more readable than the raw
 * `JSON.stringify(error)` that clients used to receive.
 */
export function formatZodError(error: z.ZodError): string {
  return z
    .prettifyError(error)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('; ');
}

/**
 * Validates tool arguments and throws a {@link ValidationError}.
 *
 * The single parse site for a tool call: the registration callback used to parse
 * and then the handler parsed again.
 */
function parseInput<T>(schema: z.ZodType<T>, args: unknown): T {
  const result = schema.safeParse(args);
  if (!result.success) {
    throw new ValidationError(formatZodError(result.error));
  }
  return result.data;
}

/**
 * Awaits `promise`, but rejects as soon as `signal` aborts.
 *
 * Used so a caller that cancels does not keep waiting on a shared singleflight
 * result, without cancelling the work the other callers still need.
 */
async function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    throw new CancelledError('The request was cancelled before it completed.');
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(new CancelledError('The request was cancelled before it completed.'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}

/**
 * Shape returned by every tool handler.
 *
 * `_meta` carries the quota and cache summary; MCP sends it to the client
 * alongside the text content.
 */
export interface ToolResult {
  /**
   * Index signature required by the MCP SDK's `CallToolResult`, which allows
   * extra result keys. Our declared fields are the ones we actually set.
   */
  [key: string]: unknown;
  content: TextContent[];
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

/**
 * Options accepted by the search path.
 *
 * `signal` is the caller's cancellation and `fresh` bypasses the cache read;
 * neither takes part in the cache identity.
 */
export interface SearchOptions {
  minScore?: number;
  limit?: number;
  includeComments?: boolean;
  page?: number;
  acceptedOnly?: boolean;
  sort?: 'relevance' | 'votes' | 'activity' | 'creation';
  /** Cancellation signal from the MCP client, threaded down to `fetch`. */
  signal?: AbortSignal;
  /** Skip the cache read for this call, refreshing the stored entry. */
  fresh?: boolean;
}

/**
 * Collaborators that may be shared between server instances.
 *
 * All optional: production injects one set per process, tests get private ones.
 */
export interface ServerDeps {
  apiKey?: string | undefined;
  limiter?: RateLimiter;
  cache?: ResponseCache;
  /** Per-kind entry lifetimes, used only when `cache` is not supplied. */
  cacheTtls?: Partial<CacheTtls>;
  quota?: QuotaTracker;
}

export class StackOverflowServer {
  private server: McpServer;
  private apiKey: string | undefined;
  /**
   * Request admission control.
   *
   * Per instance today, so the 19 test suites keep their isolation; `cli.ts`
   * injects one shared limiter per process so that HTTP sessions cannot multiply
   * the per-IP request rate (see docs/adr/0002-shared-state.md).
   */
  private readonly limiter: RateLimiter;
  /**
   * Response cache: bounded, TTL'd, canonical keys, singleflight, frozen values.
   *
   * Private per instance by default so the unit suites stay isolated; `cli.ts`
   * injects one per process so HTTP sessions share cached responses.
   */
  private readonly cache: ResponseCache;
  /** Default lifetime reported by `stackoverflow://quota`. */
  private readonly cacheTtlMs: number;
  /**
   * Latest quota figures reported by the API (B15).
   *
   * Shared when injected, so every session reports the same allowance.
   */
  private readonly quota: QuotaTracker;

  /**
   * Creates a server instance.
   *
   * @param deps - Optional shared collaborators. Production passes a single set
   *   per process (`cli.ts`) so that every HTTP session shares one rate limiter,
   *   cache and quota tracker; omitting them creates private ones, which keeps
   *   the unit suites isolated (see docs/adr/0002-shared-state.md).
   */
  constructor(deps: ServerDeps = {}) {
    this.apiKey = deps.apiKey ?? API_KEY;
    this.limiter =
      deps.limiter ??
      new RateLimiter({
        capacity: MAX_REQUESTS_PER_SECOND,
        windowMs: RATE_LIMIT_WINDOW_MS,
        minDelayMs: MIN_DELAY_BETWEEN_REQUESTS_MS,
      });
    this.cache =
      deps.cache ??
      new ResponseCache(deps.cacheTtls === undefined ? {} : { ttls: deps.cacheTtls });
    this.cacheTtlMs = this.cache.ttlFor('search');
    this.quota =
      deps.quota ??
      new QuotaTracker({
        hasApiKey: () => this.hasApiKey(),
        warnThreshold: QUOTA_WARNING_THRESHOLD,
      });
    this.server = new McpServer(
      {
        name: SERVER_NAME,
        version: VERSION,
      },
      {
        capabilities: {
          tools: {},
          resources: {},
          prompts: {},
        },
      }
    );

    this.setupTools();
    this.setupResources();
    this.setupPrompts();
    this.setupErrorHandling();
  }

  // ========================================================================
  // Setup Methods
  // ========================================================================

  /**
   * Sets up error handling for the MCP server.
   * Configures error handlers for the MCP server instance.
   */
  private setupErrorHandling(): void {
    this.server.server.onerror = (error) => logger.error({ error }, 'MCP Error');
  }

  /**
   * Sets up MCP tools for Stack Overflow search operations.
   * Registers three tools: search_by_error, search_by_tags, and search_by_stack_trace.
   */
  private setupTools(): void {
    this.registerSearchByErrorTool();
    this.registerSearchByTagsTool();
    this.registerAnalyzeStackTraceTool();
    this.registerSearchByQueryTool();
    this.registerSearchByQuestionIdTool();
  }

  /**
   * Registers MCP Resources for server metadata and API quota status.
   * Resources provide read-only data that clients can subscribe to.
   */
  private setupResources(): void {
    registerResources(this.server, () => ({
      apiKeyConfigured: this.hasApiKey(),
      maxRequestsPerSecond: MAX_REQUESTS_PER_SECOND,
      minDelayBetweenRequestsMs: MIN_DELAY_BETWEEN_REQUESTS_MS,
      quotaWarningThreshold: QUOTA_WARNING_THRESHOLD,
      cacheTtlMs: this.cache.ttlFor('search'),
      activeBackoffs: new Map(
        this.limiter.activeBackoffs().map(({ method, until }) => [method, until])
      ),
      quota: { ...this.quota.snapshot(), resetAt: this.quota.resetAt() },
      cache: this.cache.stats(),
    }));
  }

  /**
   * Registers MCP Prompts for common Stack Overflow search workflows.
   * Prompts provide templated interactions that guide AI models.
   */
  private setupPrompts(): void {
    registerPrompts(this.server);
  }

  private registerSearchByErrorTool(): void {
    this.server.registerTool(
      'search_by_error',
      {
        title: 'Search by Error',
        description:
          'Search Stack Overflow for solutions to error messages. ' +
          'Extracts the most relevant questions and answers for a given error. ' +
          'Optionally filter by programming language, technologies, minimum score, and include comments.',
        annotations: {
          readOnlyHint: true,
          idempotentHint: true,
          openWorldHint: true,
        },
        inputSchema: searchByErrorInputSchema,
      },
      // `extra.signal` fires when the MCP client cancels, so the in-flight
      // fetch, the rate-limiter wait and any retry backoff all stop.
      async (args, extra) => this.handleSearchByError(args as SearchByErrorInput, extra.signal)
    );
  }

  private registerSearchByTagsTool(): void {
    this.server.registerTool(
      'search_by_tags',
      {
        title: 'Search by Tags',
        description:
          'Search Stack Overflow questions by technology tags. ' +
          'Find top-voted questions for specific programming languages, frameworks, or tools. ' +
          'Optionally filter by minimum score and include comments.',
        annotations: {
          readOnlyHint: true,
          idempotentHint: true,
          openWorldHint: true,
        },
        inputSchema: searchByTagsInputSchema,
      },
      // `extra.signal` fires when the MCP client cancels, so the in-flight
      // fetch, the rate-limiter wait and any retry backoff all stop.
      async (args, extra) => this.handleSearchByTags(args as SearchByTagsInput, extra.signal)
    );
  }

  private registerAnalyzeStackTraceTool(): void {
    this.server.registerTool(
      'analyze_stack_trace',
      {
        title: 'Analyze Stack Trace',
        description:
          'Analyze a stack trace to find relevant solutions on Stack Overflow. ' +
          'Extracts the most meaningful error line from the stack trace (skipping generic headers such as ' +
          '"Traceback (most recent call last):") and searches for matching questions. ' +
          'Requires a programming language to narrow results.',
        annotations: {
          readOnlyHint: true,
          idempotentHint: true,
          openWorldHint: true,
        },
        inputSchema: analyzeStackTraceInputSchema,
      },
      // `extra.signal` fires when the MCP client cancels, so the in-flight
      // fetch, the rate-limiter wait and any retry backoff all stop.
      async (args, extra) => this.handleAnalyzeStackTrace(args as StackTraceInput, extra.signal)
    );
  }

  private registerSearchByQueryTool(): void {
    this.server.registerTool(
      'search_by_query',
      {
        title: 'Search by Query',
        description:
          'Search Stack Overflow using a free-text query string. ' +
          'Returns the most relevant questions and answers matching your search terms. ' +
          'Optionally filter by tags, minimum score, accepted answers only, and include comments.',
        annotations: {
          readOnlyHint: true,
          idempotentHint: true,
          openWorldHint: true,
        },
        inputSchema: searchByQueryInputSchema,
      },
      // `extra.signal` fires when the MCP client cancels, so the in-flight
      // fetch, the rate-limiter wait and any retry backoff all stop.
      async (args, extra) => this.handleSearchByQuery(args as SearchByQueryInput, extra.signal)
    );
  }

  private registerSearchByQuestionIdTool(): void {
    this.server.registerTool(
      'search_by_question_id',
      {
        title: 'Search by Question ID',
        description:
          'Retrieve a specific Stack Overflow question by its ID. ' +
          'Returns the full question body, answers (sorted by votes), and optionally comments. ' +
          'Useful for looking up a known question number.',
        annotations: {
          readOnlyHint: true,
          idempotentHint: true,
          openWorldHint: true,
        },
        inputSchema: searchByQuestionIdInputSchema,
      },
      // `extra.signal` fires when the MCP client cancels, so the in-flight
      // fetch, the rate-limiter wait and any retry backoff all stop.
      async (args, extra) => this.handleSearchByQuestionId(args as SearchByQuestionIdInput, extra.signal)
    );
  }

  // ========================================================================
  // Rate Limiting
  // ========================================================================

  /**
   * Checks and enforces rate limits before making API requests
   * Handles method-specific backoff, per-second limits, and minimum delays
   */
  /**
   * Waits until the API may be called again.
   *
   * Admission is decided synchronously inside `RateLimiter.acquire`, which is
   * what makes it correct under concurrency: the previous implementation read the
   * shared timestamp list, awaited, and only then recorded its own request, so
   * concurrent callers all passed together (measured: 60 admissions in 41 ms
   * against a 25/s limit).
   *
   * @param method - API method, used for per-method backoff.
   * @param signal - Cancellation signal; aborting does not consume a slot.
   */
  private async checkRateLimit(method: string = 'default', signal?: AbortSignal): Promise<void> {
    await this.limiter.acquire(method, signal);
  }

  /**
   * Wraps API requests with rate limiting, backoff handling and bounded retries.
   *
   * Stack Exchange returns API-level errors with HTTP 200 and an `error_id` body,
   * so the parsed payload must be inspected rather than relying on
   * `response.ok`. The failure modes need very different handling:
   *
   * - **Quota exhausted** (`error_id 502` with `quota_remaining === 0`): retrying
   *   cannot help, and each attempt spends allowance the caller does not have.
   *   Fails immediately with {@link QuotaExhaustedError}.
   * - **Throttled** (`error_id 502`, or HTTP 429): honour any `Retry-After`
   *   header and the API's own `backoff`, then retry at most
   *   {@link MAX_RETRIES} times with jittered exponential delay.
   * - **Deterministic API errors** (bad parameter and friends): reported
   *   immediately as {@link UpstreamError}, since a retry is guaranteed to fail.
   */
  private async withRateLimit<T>(
    fn: (signal: AbortSignal) => Promise<globalThis.Response>,
    method: string = 'default',
    attempt = 0,
    parentSignal?: AbortSignal
  ): Promise<ApiResponse<T>> {
    // One signal carrying both the caller's cancellation and the request
    // timeout, so a hung connection cannot outlive the tool call.
    const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signal = parentSignal ? AbortSignal.any([parentSignal, timeoutSignal]) : timeoutSignal;

    if (parentSignal?.aborted) {
      throw new CancelledError('The request was cancelled before it completed.');
    }

    await this.checkRateLimit(method, signal);

    const canRetry = (): boolean => attempt < MAX_RETRIES;
    const retry = async (delayMs: number, reason: string): Promise<ApiResponse<T>> => {
      await sleep(delayMs, signal);
      logger.warn({ delayMs, attempt: attempt + 1, method, reason }, 'Retrying Stack Overflow request');
      return this.withRateLimit(fn, method, attempt + 1, parentSignal);
    };

    let response: globalThis.Response;
    try {
      response = await fn(signal);
    } catch (error) {
      // Cancellation and timeout are terminal: the caller has gone away, or the
      // request already consumed its whole budget.
      if (parentSignal?.aborted) {
        throw new CancelledError('The request was cancelled before it completed.', { cause: error });
      }
      if (signal.aborted) {
        throw new TimeoutError(
          `Stack Overflow did not respond within ${REQUEST_TIMEOUT_MS}ms. ` +
            'Try again, or narrow the search to reduce the work involved.',
          REQUEST_TIMEOUT_MS,
          { cause: error }
        );
      }

      // Network-level failure (DNS, connection reset, socket hang up).
      if (canRetry()) {
        const delayMs = computeRetryDelayMs(attempt + 1, undefined);
        return retry(delayMs, `network error: ${error instanceof Error ? error.message : String(error)}`);
      }
      throw new UpstreamError(
        `Could not reach the Stack Exchange API after ${MAX_RETRIES + 1} attempts: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        { retryable: false, cause: error }
      );
    }

    // Parse the body once; Stack Exchange always returns JSON, but a proxy or
    // gateway may not.
    let data: ApiResponse<T> & Partial<ApiErrorResponse>;
    try {
      data = (await response.json()) as ApiResponse<T> & Partial<ApiErrorResponse>;
    } catch (error) {
      if (canRetry() && (response.status === 429 || response.status >= 500)) {
        const delayMs = computeRetryDelayMs(attempt + 1, retryAfterMs(response));
        return retry(delayMs, `unreadable response with HTTP ${response.status}`);
      }
      throw new UpstreamError(
        `Stack Overflow API returned an unreadable response (HTTP ${response.status}): ` +
          `${error instanceof Error ? error.message : String(error)}`,
        { status: response.status, retryable: false, cause: error }
      );
    }

    const quotaRemaining = typeof data.quota_remaining === 'number' ? data.quota_remaining : undefined;
    const quotaMax = typeof data.quota_max === 'number' ? data.quota_max : undefined;

    // API-level error (returned with HTTP 200 by Stack Exchange).
    if (typeof data.error_id === 'number') {
      const message = data.error_message ?? 'unknown error';

      // Record the figures before throwing: an error response is exactly when
      // the remaining allowance matters most, and it is the response that told
      // us the quota is gone.
      this.recordQuota(quotaRemaining, quotaMax);

      // Quota exhaustion also arrives as error_id 502, so it must be told apart
      // from throttling before deciding whether a retry is worthwhile.
      if (quotaRemaining === 0 || /quota/i.test(message)) {
        throw new QuotaExhaustedError(buildQuotaMessage(quotaRemaining, quotaMax, this.hasApiKey()), {
          ...(quotaRemaining !== undefined ? { quotaRemaining } : {}),
          ...(quotaMax !== undefined ? { quotaMax } : {}),
        });
      }

      const isThrottle = data.error_id === 502 || response.status === 429 || /throttle/i.test(message);
      if (isThrottle) {
        const delayMs = computeRetryDelayMs(
          attempt + 1,
          retryAfterMs(response) ?? (data.backoff !== undefined ? data.backoff * 1000 : undefined)
        );
        if (canRetry()) {
          if (data.backoff) {
            this.limiter.applyBackoff(method, data.backoff * 1000);
            logger.warn({ backoff: data.backoff, method }, 'API requested backoff');
          }
          return retry(delayMs, `throttled (error_id ${data.error_id})`);
        }
        throw new ThrottledError(
          `Stack Overflow is throttling this client after ${MAX_RETRIES + 1} attempts ` +
            `(${message}). Wait a few seconds and retry, and consider setting ` +
            'STACKOVERFLOW_API_KEY for a higher request allowance.'
        );
      }

      throw new UpstreamError(`Stack Overflow API error: ${message} (${data.error_id})`, {
        status: response.status,
        errorId: data.error_id,
        retryable: false,
      });
    }

    // HTTP-level failure without a structured error body.
    if (!response.ok) {
      const isThrottle = response.status === 429;
      if (isThrottle && canRetry()) {
        const delayMs = computeRetryDelayMs(attempt + 1, retryAfterMs(response));
        return retry(delayMs, `HTTP ${response.status}`);
      }
      if (response.status === 429) {
        throw new ThrottledError(
          `Stack Overflow is throttling this client (HTTP 429) after ${MAX_RETRIES + 1} attempts. ` +
            'Wait a few seconds and retry.'
        );
      }
      if (response.status >= 500 && canRetry()) {
        const delayMs = computeRetryDelayMs(attempt + 1, retryAfterMs(response));
        return retry(delayMs, `HTTP ${response.status}`);
      }
      throw new UpstreamError(`Stack Overflow API request failed with HTTP ${response.status}`, {
        status: response.status,
        retryable: response.status >= 500,
      });
    }

    // Handle backoff requested by the API on an otherwise successful response.
    if (data.backoff) {
      this.limiter.applyBackoff(method, data.backoff * 1000);
      logger.warn({ backoff: data.backoff, method }, 'API requested backoff');
    }

    this.recordQuota(quotaRemaining, quotaMax);

    if (this.quota.isLow()) {
      const current = this.quota.snapshot();
      logger.warn(
        { quotaRemaining: current.remaining, quotaMax: current.max },
        'Low API quota'
      );
    }

    return data;
  }

  // ========================================================================
  // Helper Methods
  // ========================================================================

  /**
   * Records the quota figures from an API response.
   *
   * Called for every successful response so `stackoverflow://quota` reflects
   * reality instead of static configuration.
   */
  private recordQuota(remaining: number | undefined, max: number | undefined): void {
    this.quota.update(remaining, max);
  }

  /**
   * Result metadata attached to every tool response.
   *
   * Gives the client the same quota picture the `stackoverflow://quota` resource
   * reports, so a model can see how close it is to the daily allowance without a
   * second round trip.
   */
  private resultMeta(): Record<string, unknown> {
    return {
      quota: {
        remaining: this.quota.snapshot().remaining,
        max: this.quota.snapshot().max,
        resetAt: this.quota.resetAt(),
        anonymous: this.quota.usesAnonymousQuota(),
      },
      cache: { size: this.cache.stats().size },
    };
  }

  /**
   * Creates API request parameters with optional API key
   */
  private createApiParams(
    baseParams: Record<string, string>
  ): URLSearchParams {
    const params = new URLSearchParams(baseParams);
    if (this.apiKey) {
      params.append('key', this.apiKey);
    }
    return params;
  }

  // ========================================================================
  // API Methods
  // ========================================================================

  /**
   * Searches Stack Overflow using the advanced search endpoint.
   *
   * Uses `sort=relevance` by default because it produces far better matches for
   * error-message queries than `sort=votes` (which surfaces popular but unrelated
   * questions). `minScore` is pushed down to the API via `min` so that the
   * requested `limit` is not silently reduced by post-fetch filtering.
   *
   * Note: the Stack Exchange API rejects `min` combined with `sort=relevance`
   * (error_id 400 "min"), so a score threshold switches the sort to `votes`.
   *
   * When a query is too specific to match anything, progressively shorter
   * variants are retried so that closely related questions are still returned.
   */
  /**
   * Searches Stack Overflow, serving repeat and concurrent identical calls from
   * the cache.
   *
   * The cache identity deliberately excludes the caller's cancellation signal and
   * the `fresh` flag: an abort must not poison a response other callers are
   * waiting for, and `fresh` only decides whether the cache is read.
   */
  private async searchStackOverflow(
    query: string,
    tags?: string[],
    options: SearchOptions = {}
  ): Promise<PagedSearchResults> {
    const { signal, fresh, ...cacheableOptions } = options;

    // Fail before starting any work. `getOrProduce` invokes the producer
    // immediately, so without this check a caller that had already cancelled
    // would still spend a request.
    if (signal?.aborted) {
      throw new CancelledError('The request was cancelled before it completed.');
    }

    const key = cacheKey('search', {
      site: 'stackoverflow',
      query: query.trim().slice(0, 500),
      tags: tags ?? [],
      options: cacheableOptions,
    });
    const ttl = fresh ? 0 : this.cache.ttlFor('search');

    // The producer runs without the caller's signal on purpose (see above).
    // `cacheableOptions` has the caller's signal removed, so the shared producer
    // cannot be cancelled by whichever caller started it.
    const pending = this.cache.getOrProduce(
      key,
      ttl,
      () => this.searchStackOverflowUncached(query, tags, cacheableOptions),
      Boolean(fresh)
    );

    return signal ? await raceWithSignal(pending, signal) : pending;
  }

  /**
   * Runs `producer` through the cache, keyed by the entity it reads.
   *
   * Every read path is cached, not just searches: a question, its answers and its
   * comments change rarely and are the exact things an agent asks for repeatedly.
   * The caller's cancellation signal is deliberately excluded from the key and
   * from the producer, so one caller aborting cannot poison a value another
   * caller is waiting for; the caller instead races the shared result against its
   * own signal.
   *
   * @param kind - Data kind, which selects the TTL.
   * @param parts - Values that fully identify the read.
   * @param signal - The caller's cancellation signal, if any.
   * @param producer - Performs the actual request(s).
   */
  private async cachedRead<T>(
    kind: CacheKind,
    parts: Record<string, unknown>,
    signal: AbortSignal | undefined,
    producer: () => Promise<T>
  ): Promise<T> {
    if (signal?.aborted) {
      // Fail before starting work: `getOrProduce` calls the producer immediately,
      // so an already-cancelled caller would otherwise still spend a request.
      throw new CancelledError('The request was cancelled before it completed.');
    }

    const pending = this.cache.getOrProduce(cacheKey(kind, parts), this.cache.ttlFor(kind), producer);
    return signal ? await raceWithSignal(pending, signal) : pending;
  }

  /** Performs the search, without consulting or populating the cache. */
  private async searchStackOverflowUncached(
    query: string,
    tags?: string[],
    options: {
      minScore?: number;
      limit?: number;
      includeComments?: boolean;
      page?: number;
      acceptedOnly?: boolean;
      sort?: 'relevance' | 'votes' | 'activity' | 'creation';
      /** Cancellation signal from the MCP client, threaded down to `fetch`. */
      signal?: AbortSignal;
    } = {}
  ): Promise<PagedSearchResults> {
    const safeQuery = query.trim().slice(0, 500);

    const hasMinScore = options.minScore !== undefined && options.minScore > 0;
    // `min` is incompatible with `sort=relevance` on the Stack Exchange API
    const sort = options.sort ?? (hasMinScore ? 'votes' : 'relevance');

    const variants = buildQueryVariants(safeQuery);
    const notes: string[] = [];
    let lastError: unknown;

    // Falling back to a broader search only makes sense for the first page.
    // A page > 1 that comes back empty is the normal end of the result set, and
    // retrying with a different query would answer page N of the original search
    // with page N of an unrelated one.
    const isFirstPage = (options.page ?? 1) <= 1;

    // Attempts: progressively shorter queries, then (if tags were supplied and
    // matched nothing) the original query without the tag filter. An invalid or
    // overly narrow tag silently yields zero results on the Stack Exchange API,
    // so relaxing it is preferable to returning nothing.
    const attempts: { query: string; tags?: string[]; note?: string }[] = isFirstPage
      ? variants.map((variant) => ({
          query: variant,
          ...(tags && tags.length > 0 ? { tags } : {}),
        }))
      : [{ query: safeQuery, ...(tags && tags.length > 0 ? { tags } : {}) }];
    if (isFirstPage && tags && tags.length > 0) {
      attempts.push({
        query: safeQuery,
        note: `No results matched the tag filter (${tags.join(', ')}); the tag filter was relaxed. Tags on Stack Overflow may differ from the names you expect (for example "reactjs" rather than "react").`,
      });
    }

    for (const [index, attempt] of attempts.entries()) {
      const params = this.createApiParams({
        site: 'stackoverflow',
        sort,
        order: 'desc',
        filter: DEFAULT_FILTER,
        q: attempt.query,
        ...(attempt.tags && attempt.tags.length > 0 && { tagged: attempt.tags.join(';') }),
        pagesize: (options.limit ?? DEFAULT_LIMIT).toString(),
        ...(options.page && options.page > 1 && { page: options.page.toString() }),
        ...(hasMinScore && { min: options.minScore!.toString() }),
        ...(options.acceptedOnly && { accepted: 'True' }),
      });

      try {
        const data = await this.withRateLimit<StackOverflowQuestion>(
          (fetchSignal) =>
            fetch(`${STACKOVERFLOW_API}/search/advanced?${params}`, { signal: fetchSignal }),
          'search/advanced',
          0,
          options.signal
        );

        // Retry with a broader attempt only when this one matched nothing
        if (data.items.length === 0 && index < attempts.length - 1) {
          logger.info(
            { query: attempt.query, tags: attempt.tags, next: attempts[index + 1] },
            'No results, retrying with a broader search'
          );
          continue;
        }

        if (attempt.note) {
          notes.push(attempt.note);
        }

        // Tell the client which query actually matched, so it can request the
        // next page of *that* query instead of the one it originally sent.
        if (attempt.query !== safeQuery) {
          notes.push(
            `No results matched the full query; it was shortened to "${attempt.query}". Use that query to page through further results.`
          );
        }

        const results = await this.processSearchResults(data.items, options);
        const isOriginalQuery = attempt.query === safeQuery;
        const isOriginalTags =
          (attempt.tags?.length ?? 0) === (tags?.length ?? 0) &&
          (attempt.tags ?? []).every((tag) => (tags ?? []).includes(tag));

        const paged: PagedSearchResults = {
          results,
          page: options.page ?? 1,
          hasMore: Boolean(data.has_more),
          effectiveQuery: attempt.query,
          ...(attempt.tags && attempt.tags.length > 0 ? { effectiveTags: attempt.tags } : {}),
          usedFallback: !(isOriginalQuery && isOriginalTags),
          ...(notes.length > 0 ? { notes } : {}),
        };
        return paged;
      } catch (error) {
        lastError = error;
        break;
      }
    }

    throw new Error(
      `Failed to search Stack Overflow: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`
    );
  }

  /**
   * Fetches answers for one or more questions.
   *
   * The Stack Exchange API accepts semicolon-separated IDs, which avoids the
   * N+1 request pattern of fetching answers per question. Two constraints shape
   * the implementation:
   *
   * 1. The ID list is split into chunks of at most {@link MAX_IDS_PER_REQUEST}
   *    because the API rejects longer ID vectors outright.
   * 2. Each chunk is paged while `has_more` is true, because the API sorts the
   *    whole multi-question result set by votes: with a single page the most
   *    popular questions consume all 100 slots and every other question appears
   *    to have no answers at all.
   *
   * Paging is bounded by {@link MAX_ANSWER_PAGES} and stops early as soon as a
   * page comes back empty, so the worst case stays predictable.
   */
  private async fetchAnswersForQuestions(
    questionIds: number[],
    signal?: AbortSignal
  ): Promise<Map<number, StackOverflowAnswer[]>> {
    const grouped = new Map<number, StackOverflowAnswer[]>();
    if (questionIds.length === 0) {
      return grouped;
    }

    try {
      for (const chunk of chunkIds(questionIds)) {
        for (let page = 1; page <= MAX_ANSWER_PAGES; page += 1) {
          const data = await this.cachedRead(
            'question',
            { site: 'stackoverflow', questionIds: chunk, page, view: 'answers' },
            signal,
            // The cached producer takes no cancellation signal: a shared
            // singleflight result must not depend on whichever caller happened to
            // populate it. Each caller races the result against its own signal.
            () => this.fetchAnswersPage(chunk, page)
          );

          const items = data.items ?? [];
          for (const answer of items) {
            const existing = grouped.get(answer.question_id) ?? [];
            existing.push(answer);
            grouped.set(answer.question_id, existing);
          }

          if (!data.has_more || items.length === 0) {
            break;
          }
        }
      }
      return grouped;
    } catch (error) {
      throw new Error(
        `Failed to fetch answers: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  /**
   * Fetches one page of answers for one chunk of question IDs.
   *
   * Uses its own request timeout only, never a caller's cancellation signal: the
   * result is shared through the cache with other callers.
   */
  private async fetchAnswersPage(
    chunk: number[],
    page: number
  ): Promise<ApiResponse<StackOverflowAnswer>> {
    const params = this.createApiParams({
      site: 'stackoverflow',
      filter: ANSWER_FILTER,
      sort: 'votes',
      order: 'desc',
      pagesize: '100',
      page: String(page),
    });

    return this.withRateLimit<StackOverflowAnswer>(
      (fetchSignal) =>
        fetch(`${STACKOVERFLOW_API}/questions/${chunk.join(';')}/answers?${params}`, {
          signal: fetchSignal,
        }),
      'questions/answers'
    );
  }

  /**
   * Fetches comments for one chunk of post IDs.
   *
   * As with {@link fetchAnswersPage}, no caller signal: the result is shared.
   */
  private async fetchCommentsPage(
    chunk: number[],
    params: URLSearchParams
  ): Promise<ApiResponse<StackOverflowComment>> {
    return this.withRateLimit<StackOverflowComment>(
      (fetchSignal) =>
        fetch(`${STACKOVERFLOW_API}/posts/${chunk.join(';')}/comments?${params}`, {
          signal: fetchSignal,
        }),
      'posts/comments'
    );
  }

  /**
   * Fetches answers for a specific question.
   */
  private async fetchAnswers(
    questionId: number,
    signal?: AbortSignal
  ): Promise<StackOverflowAnswer[]> {
    const grouped = await this.fetchAnswersForQuestions([questionId], signal);
    return grouped.get(questionId) ?? [];
  }

  /**
   * Fetches comments for one or more posts.
   *
   * Comments for questions and all of their answers are requested together, so
   * the ID list is split into chunks of at most {@link MAX_IDS_PER_REQUEST} to
   * stay within the API's vectorized-request limit.
   */
  private async fetchCommentsForPosts(
    postIds: number[],
    signal?: AbortSignal
  ): Promise<Map<number, StackOverflowComment[]>> {
    const grouped = new Map<number, StackOverflowComment[]>();
    if (postIds.length === 0) {
      return grouped;
    }

    const params = this.createApiParams({
      site: 'stackoverflow',
      filter: COMMENT_FILTER,
      sort: 'votes',
      order: 'desc',
      pagesize: '100',
    });

    try {
      for (const chunk of chunkIds(postIds)) {
        const data = await this.cachedRead(
          'comments',
          { site: 'stackoverflow', postIds: chunk, view: 'comments' },
          signal,
          // No caller signal: see the note in `fetchAnswersForQuestions`.
          () => this.fetchCommentsPage(chunk, params)
        );

        for (const comment of data.items || []) {
          const existing = grouped.get(comment.post_id) ?? [];
          existing.push(comment);
          grouped.set(comment.post_id, existing);
        }
      }
      return grouped;
    } catch (error) {
      throw new Error(
        `Failed to fetch comments: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  /**
   * Fetches comments for a single post (question or answer).
   */
  private async fetchComments(
    postId: number,
    signal?: AbortSignal
  ): Promise<StackOverflowComment[]> {
    const grouped = await this.fetchCommentsForPosts([postId], signal);
    return grouped.get(postId) ?? [];
  }

  /**
   * Processes search results, fetching answers and optionally comments.
   *
   * Answers for all questions are fetched with one vectorized request per 100
   * IDs, and comments for all posts (questions plus answers) with another. The
   * number of calls therefore scales with the result set only past the API's
   * 100-ID vector limit, never one call per question.
   */
  private async processSearchResults(
    questions: StackOverflowQuestion[],
    options: {
      minScore?: number;
      includeComments?: boolean;
      signal?: AbortSignal;
    }
  ): Promise<SearchResult[]> {
    const filtered = questions.filter(
      (question) => !options.minScore || question.score >= options.minScore
    );

    if (filtered.length === 0) {
      return [];
    }

    const answersByQuestion = await this.fetchAnswersForQuestions(
      filtered.map((question) => question.question_id),
      options.signal
    );

    let commentsByPost = new Map<number, StackOverflowComment[]>();
    if (options.includeComments) {
      const postIds = [
        ...filtered.map((question) => question.question_id),
        ...Array.from(answersByQuestion.values()).flat().map((answer) => answer.answer_id),
      ];
      commentsByPost = await this.fetchCommentsForPosts(postIds, options.signal);
    }

    return filtered.map((question) => {
      const answers = answersByQuestion.get(question.question_id) ?? [];
      const searchResult: SearchResult = { question, answers };

      if (options.includeComments) {
        const answersMap: { [key: number]: StackOverflowComment[] } = {};
        for (const answer of answers) {
          answersMap[answer.answer_id] = commentsByPost.get(answer.answer_id) ?? [];
        }
        searchResult.comments = {
          question: commentsByPost.get(question.question_id) ?? [],
          answers: answersMap,
        };
      }

      return searchResult;
    });
  }

  // ========================================================================
  // Tool Handlers
  // ========================================================================

  /**
   * Handles search_by_error tool requests
   */
  private async handleSearchByError(
    args: SearchByErrorInput | unknown,
    signal?: AbortSignal
  ): Promise<ToolResult> {
    try {
      const input = parseInput(SearchByErrorInputSchema, args);
      const tags = [
        ...(input.language ? [input.language.toLowerCase()] : []),
        ...(input.technologies || []),
      ];

      const paged = await this.searchStackOverflow(
        cleanErrorMessage(input.errorMessage),
        tags.length > 0 ? tags : undefined,
        {
          ...(input.minScore !== undefined ? { minScore: input.minScore } : {}),
          ...(signal ? { signal } : {}),
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
          ...(input.includeComments !== undefined ? { includeComments: input.includeComments } : {}),
          ...(input.page !== undefined ? { page: input.page } : {}),
        }
      );

      return {
        _meta: this.resultMeta(),
        content: [
          {
            type: 'text' as const,
            text: this.formatResponse(paged.results, input.responseFormat, {
              page: paged.page,
              hasMore: paged.hasMore,
              ...(paged.notes ? { notes: paged.notes } : {}),
            }),
          },
        ],
      };
    } catch (error) {
      return this.toErrorResponse(error);
    }
  }

  /**
   * Handles search_by_tags tool requests
   */
  private async handleSearchByTags(
    args: SearchByTagsInput | unknown,
    signal?: AbortSignal
  ): Promise<ToolResult> {
    try {
      const input = parseInput(SearchByTagsInputSchema, args);
      const params = this.createApiParams({
        site: 'stackoverflow',
        sort: 'votes',
        order: 'desc',
        filter: DEFAULT_FILTER,
        tagged: input.tags.join(';'),
        pagesize: (input.limit ?? DEFAULT_LIMIT).toString(),
        ...(input.page && input.page > 1 && { page: input.page.toString() }),
        ...(input.minScore !== undefined && input.minScore > 0 && { min: input.minScore.toString() }),
      });

      const data = await this.withRateLimit<StackOverflowQuestion>(
        (fetchSignal) => fetch(`${STACKOVERFLOW_API}/questions?${params}`, { signal: fetchSignal }),
        'questions',
        0,
        signal
      );

      const results = await this.processSearchResults(data.items, {
        ...(input.minScore !== undefined ? { minScore: input.minScore } : {}),
        ...(input.includeComments !== undefined ? { includeComments: input.includeComments } : {}),
        ...(signal ? { signal } : {}),
      });

      return {
        _meta: this.resultMeta(),
        content: [
          {
            type: 'text' as const,
            text: this.formatResponse(results, input.responseFormat, {
              page: input.page ?? 1,
              hasMore: Boolean(data.has_more),
            }),
          },
        ],
      };
    } catch (error) {
      return this.toErrorResponse(error);
    }
  }

  /**
   * Handles analyze_stack_trace tool requests
   */
  private async handleAnalyzeStackTrace(
    args: StackTraceInput | unknown,
    signal?: AbortSignal
  ): Promise<ToolResult> {
    try {
      const input = parseInput(StackTraceInputSchema, args);
      const errorMessage = extractErrorMessage(input.stackTrace);

      const paged = await this.searchStackOverflow(
        cleanErrorMessage(errorMessage),
        [input.language.toLowerCase()],
        {
          minScore: 0,
          ...(signal ? { signal } : {}),
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
          ...(input.includeComments !== undefined ? { includeComments: input.includeComments } : {}),
          ...(input.page !== undefined ? { page: input.page } : {}),
        }
      );

      return {
        _meta: this.resultMeta(),
        content: [
          {
            type: 'text' as const,
            text: this.formatResponse(paged.results, input.responseFormat, {
              page: paged.page,
              hasMore: paged.hasMore,
              ...(paged.notes ? { notes: paged.notes } : {}),
            }),
          },
        ],
      };
    } catch (error) {
      return this.toErrorResponse(error);
    }
  }

  /**
   * Handles search_by_query tool requests
   */
  private async handleSearchByQuery(
    args: SearchByQueryInput | unknown,
    signal?: AbortSignal
  ): Promise<ToolResult> {
    try {
      const input = parseInput(SearchByQueryInputSchema, args);

      const paged = await this.searchStackOverflow(
        input.query,
        input.tags,
        {
          ...(input.minScore !== undefined ? { minScore: input.minScore } : {}),
          ...(signal ? { signal } : {}),
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
          ...(input.includeComments !== undefined ? { includeComments: input.includeComments } : {}),
          ...(input.page !== undefined ? { page: input.page } : {}),
          ...(input.acceptedOnly ? { acceptedOnly: true } : {}),
        }
      );

      // Belt-and-braces: the API `accepted=True` filter is authoritative, but we
      // also drop any question without an accepted answer locally. `hasMore` is
      // left as the API reported it, because the API's own paging decides what
      // the next page contains; only `pageSize` describes what was returned.
      const results = input.acceptedOnly
        ? paged.results.filter((r) => r.question.accepted_answer_id !== undefined)
        : paged.results;

      return {
        _meta: this.resultMeta(),
        content: [
          {
            type: 'text' as const,
            text: this.formatResponse(results, input.responseFormat, {
              page: paged.page,
              hasMore: paged.hasMore,
              ...(paged.notes ? { notes: paged.notes } : {}),
            }),
          },
        ],
      };
    } catch (error) {
      return this.toErrorResponse(error);
    }
  }

  /**
   * Handles search_by_question_id tool requests
   */
  private async handleSearchByQuestionId(
    args: SearchByQuestionIdInput | unknown,
    signal?: AbortSignal
  ): Promise<ToolResult> {
    try {
      const input = parseInput(SearchByQuestionIdInputSchema, args);

      const params = this.createApiParams({
        site: 'stackoverflow',
        filter: DEFAULT_FILTER,
      });

      const data = await this.cachedRead(
        'question',
        { site: 'stackoverflow', questionId: input.questionId, view: 'question' },
        signal,
        // No caller signal here either: the result is shared through the cache,
        // so it must not be cancelled by whichever caller started it. The caller
        // races the shared promise against its own signal instead.
        () =>
          this.withRateLimit<StackOverflowQuestion>(
            (fetchSignal) =>
              fetch(`${STACKOVERFLOW_API}/questions/${input.questionId}?${params}`, {
                signal: fetchSignal,
              }),
            'questions/single'
          )
      );

      if (!data.items || data.items.length === 0) {
        return this.createErrorResponse(`No question found with ID: ${input.questionId}`);
      }

      const question = data.items[0];
      const includeAnswers = input.includeAnswers !== false; // default true
      const answers = includeAnswers
        ? await this.fetchAnswers(question.question_id, signal)
        : [];

      let comments: SearchResultComments | undefined;
      if (input.includeComments) {
        const postIds = [
          question.question_id,
          ...answers.map((answer) => answer.answer_id),
        ];
        const commentsByPost = await this.fetchCommentsForPosts(postIds, signal);
        const answersMap: { [key: number]: StackOverflowComment[] } = {};
        for (const answer of answers) {
          answersMap[answer.answer_id] = commentsByPost.get(answer.answer_id) ?? [];
        }
        comments = {
          question: commentsByPost.get(question.question_id) ?? [],
          answers: answersMap,
        };
      }

      const result: SearchResult = { question, answers };
      if (comments) {
        result.comments = comments;
      }

      return {
        _meta: this.resultMeta(),
        content: [
          {
            type: 'text' as const,
            text: this.formatResponse([result], input.responseFormat),
          },
        ],
      };
    } catch (error) {
      return this.toErrorResponse(error);
    }
  }

  // ========================================================================
  // Response Formatting
  // ========================================================================

  /**
   * Formats search results as JSON or Markdown with pagination metadata and truncation.
   *
   * A thin dispatcher over the pure formatters in `format/`; the JSON and
   * Markdown bodies moved there verbatim so the output bytes are unchanged.
   *
   * `pagination.totalCount` is only emitted when the caller supplies a real
   * total from the API. It previously duplicated `pageSize`, which made clients
   * believe the page they received was the whole result set.
   *
   * @param results - Search results to format
   * @param format - Output format (json or markdown)
   * @param paginationInfo - Optional pagination state from the API response
   */
  private formatResponse(
    results: SearchResult[],
    format: 'json' | 'markdown' = 'json',
    paginationInfo?: { page?: number; hasMore?: boolean; notes?: string[]; totalCount?: number }
  ): string {
    const pagination: PaginationMeta = {
      page: paginationInfo?.page ?? 1,
      // Recomputed from the results actually returned, so local filtering
      // (e.g. acceptedOnly) can never leave the metadata describing dropped rows.
      pageSize: results.length,
      hasMore: paginationInfo?.hasMore ?? false,
      ...(paginationInfo?.totalCount !== undefined
        ? { totalCount: paginationInfo.totalCount }
        : {}),
    };
    const notes = paginationInfo?.notes ?? [];

    return format === 'json'
      ? formatJson(pagination, notes, results)
      : formatMarkdown(pagination, notes, results);
  }

  /**
   * Maps any thrown value to an accurate, actionable tool error.
   *
   * Every failure used to be reported as `Validation failed: …`, so a client
   * could not tell bad arguments from exhausted quota from an upstream outage.
   * The prefix is now derived from the error's category, and zod errors are
   * rendered compactly (via `z.prettifyError`) instead of as a raw JSON blob.
   */
  private toErrorResponse(error: unknown): ToolResult {
    if (error instanceof z.ZodError) {
      return this.createErrorResponse(`Validation failed: ${formatZodError(error)}`);
    }

    if (error instanceof ValidationError) {
      return this.createErrorResponse(`Validation failed: ${error.message}`);
    }

    if (error instanceof StackOverflowMcpError) {
      return this.createErrorResponse(error.message);
    }

    return this.createErrorResponse(toMcpError(error).message);
  }

  /**
   * Creates a standardized error response
   */
  private createErrorResponse(message: string): ToolResult {
    const sanitizedMessage = redactSecrets(message);
    return {
      _meta: this.resultMeta(),
      content: [
        {
          type: 'text' as const,
          text: `Error: ${sanitizedMessage}`,
        },
      ],
      isError: true,
    };
  }

  // ========================================================================
  // Public API
  // ========================================================================

  getServer(): McpServer {
    return this.server;
  }

  /**
   * Checks if an API key is configured.
   *
   * @returns True if API key is set, false otherwise
   */
  hasApiKey(): boolean {
    return !!this.apiKey;
  }

  /**
   * Runs the server with stdio transport (default mode).
   * Connects the server to stdio transport and logs startup message with API key status.
   */
  async runStdio(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    const apiKeyStatus = this.hasApiKey()
      ? 'with API key (increased rate limits)'
      : 'without API key (standard rate limits)';
    logger.info({ apiKeyStatus }, 'Stack Overflow MCP server running on stdio');
  }
}
