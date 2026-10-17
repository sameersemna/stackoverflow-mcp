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
import { SERVER_NAME, VERSION } from './version.js';
import {
  API_KEY,
  DEFAULT_LIMIT,
  REQUEST_TIMEOUT_MS,
  RETRY_BASE_DELAY_MS,
  USE_HTTP_TRANSPORT,
} from './config.js';
import { ANSWER_FILTER, COMMENT_FILTER, DEFAULT_FILTER } from './stackexchange/filters.js';
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
const MAX_REQUESTS_PER_SECOND = 25;
const RATE_LIMIT_WINDOW_MS = 1000;
const MIN_DELAY_BETWEEN_REQUESTS_MS = 40; // ~25 req/sec = 40ms between requests

/**
 * Maximum number of retries after the first attempt.
 *
 * Throttling and transient network errors are worth two retries; more than that
 * mostly burns allowance, and Stack Exchange throttles per IP.
 */
const MAX_RETRIES = 2;

/** Upper bound for a single retry delay, so a tool call cannot stall forever. */
const MAX_RETRY_DELAY_MS = 30_000;

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

const REDACTED = '***';

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
];

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
  let redacted = message;
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, replacement);
  }
  return redacted;
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
  const exponential = RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1);
  // Full jitter over the upper half of the window keeps retries spread out
  // while still waiting long enough to matter.
  const jittered = exponential / 2 + Math.random() * (exponential / 2);
  const requested = retryAfterMs ?? 0;
  return Math.min(Math.max(jittered, requested), MAX_RETRY_DELAY_MS);
}

/**
 * Reads the `Retry-After` header, which may be a number of seconds or an
 * HTTP-date.
 *
 * @returns The delay in milliseconds, or `undefined` when absent or unusable.
 */
function retryAfterMs(response: { headers?: { get(name: string): string | null } }): number | undefined {
  const raw = response.headers?.get('retry-after');
  if (!raw) {
    return undefined;
  }

  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const date = Date.parse(raw);
  if (Number.isNaN(date)) {
    return undefined;
  }
  return Math.max(0, date - Date.now());
}

/** Abort-aware promise delay used between retries. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new CancelledError('The request was cancelled before it completed.'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new CancelledError('The request was cancelled before it completed.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
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

export function buildQuotaMessage(
  quotaRemaining: number | undefined,
  quotaMax: number | undefined,
  hasApiKey: boolean
): string {
  const usage =
    quotaRemaining !== undefined && quotaMax !== undefined ? ` (${quotaRemaining}/${quotaMax})` : '';
  const base =
    `Stack Exchange API quota exhausted${usage}. Requests are counted per day and reset at ` +
    '00:00 UTC (see https://api.stackexchange.com/docs/throttle).';
  return hasApiKey
    ? `${base} The configured API key allowance is spent; retry after the reset.`
    : `${base} Without an API key the allowance is roughly 300 requests/day per IP; set ` +
        'STACKOVERFLOW_API_KEY to raise it to about 10,000/day.';
}

export class StackOverflowServer {
  private server: McpServer;
  private apiKey: string | undefined;
  private requestTimestamps: number[] = [];
  private backoffUntil: Map<string, number> = new Map();
  private lastRequestTime: number = 0;
  private readonly cacheTtlMs = 5 * 60 * 1000;
  private readonly responseCache = new Map<
    string,
    { expiresAt: number; value: PagedSearchResults }
  >();
  /**
   * Latest quota figures reported by the API.
   *
   * Previously `quota_remaining` was logged and thrown away, so
   * `stackoverflow://quota` could only report static constants. Phase 3
   * promotes this to a process-wide tracker shared by every session.
   */
  private quota: { remaining: number | undefined; max: number | undefined; observedAt: number } = {
    remaining: undefined,
    max: undefined,
    observedAt: 0,
  };

  constructor() {
    this.apiKey = API_KEY;
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
    // Server status resource
    this.server.registerResource(
      'server-status',
      'stackoverflow://status',
      {
        title: 'Server Status',
        description: 'Current server status including version, transport mode, and API key status',
        mimeType: 'application/json',
      },
      async () => ({
        contents: [
          {
            uri: 'stackoverflow://status',
            mimeType: 'application/json',
            text: JSON.stringify({
              service: 'mcp-stackoverflow',
              version: VERSION,
              transport: USE_HTTP_TRANSPORT ? 'http' : 'stdio',
              apiKeyConfigured: this.hasApiKey(),
              timestamp: new Date().toISOString(),
            }, null, 2),
          },
        ],
      })
    );

    // API quota resource
    this.server.registerResource(
      'api-quota',
      'stackoverflow://quota',
      {
        title: 'API Quota',
        description: 'Current Stack Exchange API quota status and rate limit information',
        mimeType: 'application/json',
      },
      async () => ({
        contents: [
          {
            uri: 'stackoverflow://quota',
            mimeType: 'application/json',
            text: JSON.stringify({
              maxRequestsPerSecond: MAX_REQUESTS_PER_SECOND,
              minDelayBetweenRequestsMs: MIN_DELAY_BETWEEN_REQUESTS_MS,
              quotaWarningThreshold: QUOTA_WARNING_THRESHOLD,
              cacheTtlMs: this.cacheTtlMs,
              activeBackoffs: Array.from(this.backoffUntil.entries()).map(([method, until]) => ({
                method,
                backoffUntil: new Date(until).toISOString(),
              })),
              timestamp: new Date().toISOString(),
            }, null, 2),
          },
        ],
      })
    );
  }

  /**
   * Registers MCP Prompts for common Stack Overflow search workflows.
   * Prompts provide templated interactions that guide AI models.
   */
  private setupPrompts(): void {
    this.server.registerPrompt(
      'stackoverflow_search',
      {
        title: 'Search Stack Overflow',
        description: 'Template for searching Stack Overflow with a query and optional language filter',
        argsSchema: {
          query: z.string().describe('What to search for on Stack Overflow'),
          language: z.string().optional().describe('Programming language to filter by (e.g., javascript, python, rust)'),
        },
      },
      async ({ query, language }) => ({
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: language
                ? `Search Stack Overflow for "${query}" in ${language}. Find the most helpful questions and answers.`
                : `Search Stack Overflow for "${query}". Find the most helpful questions and answers.`,
            },
          },
        ],
      })
    );

    this.server.registerPrompt(
      'stackoverflow_debug',
      {
        title: 'Debug with Stack Overflow',
        description: 'Template for debugging an error by searching Stack Overflow with the error message and language',
        argsSchema: {
          errorMessage: z.string().describe('The error message or stack trace to search for'),
          language: z.string().describe('Programming language of the code (e.g., javascript, python, java)'),
        },
      },
      async ({ errorMessage, language }) => ({
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `I'm encountering this error in ${language}:\n\n\`\`\`\n${errorMessage}\n\`\`\`\n\nSearch Stack Overflow for solutions. Use the analyze_stack_trace tool with this error and language="${language}".`,
            },
          },
        ],
      })
    );
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
        inputSchema: {
          errorMessage: z.string().describe('Error message to search for'),
          language: z.string().optional().describe('Programming language (e.g., "javascript", "python")'),
          technologies: z.array(z.string()).optional().describe('Related technologies or frameworks'),
          minScore: z.number().optional().describe('Minimum score threshold for results'),
          includeComments: z.boolean().optional().describe('Include question and answer comments in results'),
          responseFormat: z.enum(['json', 'markdown']).optional().describe('Response format: json or markdown'),
          limit: z.number().optional().describe('Maximum number of results (1-100)'),
          page: z.number().optional().describe('Page number for pagination (default: 1)'),
        },
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
        inputSchema: {
          tags: z.array(z.string()).describe('Tags to search for (e.g., ["python", "pandas", "dataframe"])'),
          minScore: z.number().optional().describe('Minimum score threshold for results'),
          includeComments: z.boolean().optional().describe('Include question and answer comments in results'),
          responseFormat: z.enum(['json', 'markdown']).optional().describe('Response format: json or markdown'),
          limit: z.number().optional().describe('Maximum number of results (1-100)'),
          page: z.number().optional().describe('Page number for pagination (default: 1)'),
        },
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
        inputSchema: {
          stackTrace: z.string().describe('Full stack trace to analyze'),
          language: z.string().describe('Programming language of the stack trace'),
          includeComments: z.boolean().optional().describe('Include question and answer comments in results'),
          responseFormat: z.enum(['json', 'markdown']).optional().describe('Response format: json or markdown'),
          limit: z.number().optional().describe('Maximum number of results (1-100)'),
          page: z.number().optional().describe('Page number for pagination (default: 1)'),
        },
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
        inputSchema: {
          query: z.string().describe('Free-text search query'),
          tags: z.array(z.string()).optional().describe('Optional tags to filter results'),
          minScore: z.number().optional().describe('Minimum score threshold for results'),
          acceptedOnly: z.boolean().optional().describe('Only return questions with accepted answers'),
          includeComments: z.boolean().optional().describe('Include question and answer comments in results'),
          responseFormat: z.enum(['json', 'markdown']).optional().describe('Response format: json or markdown'),
          limit: z.number().optional().describe('Maximum number of results (1-100)'),
          page: z.number().optional().describe('Page number for pagination (default: 1)'),
        },
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
        inputSchema: {
          questionId: z.number().describe('Stack Overflow question ID (e.g., 12345)'),
          includeAnswers: z.boolean().optional().describe('Include answers in the response (default: true)'),
          includeComments: z.boolean().optional().describe('Include question and answer comments'),
          responseFormat: z.enum(['json', 'markdown']).optional().describe('Response format: json or markdown'),
        },
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
  private async checkRateLimit(method: string = 'default', signal?: AbortSignal): Promise<void> {
    const now = Date.now();

    // Check method-specific backoff (from API responses)
    const backoffUntil = this.backoffUntil.get(method);
    if (backoffUntil && now < backoffUntil) {
      await sleep(backoffUntil - now, signal);
    }

    // Clean old timestamps (older than 1 second)
    this.requestTimestamps = this.requestTimestamps.filter(
      (timestamp) => now - timestamp < RATE_LIMIT_WINDOW_MS
    );

    // Enforce requests per second limit
    if (this.requestTimestamps.length >= MAX_REQUESTS_PER_SECOND) {
      const oldestTimestamp = Math.min(...this.requestTimestamps);
      const waitTime = RATE_LIMIT_WINDOW_MS - (now - oldestTimestamp);
      if (waitTime > 0) {
        await sleep(waitTime, signal);
      }
      // Clean again after waiting
      const newNow = Date.now();
      this.requestTimestamps = this.requestTimestamps.filter(
        (timestamp) => newNow - timestamp < RATE_LIMIT_WINDOW_MS
      );
    }

    // Enforce minimum delay between requests
    const timeSinceLastRequest = now - this.lastRequestTime;
    if (timeSinceLastRequest < MIN_DELAY_BETWEEN_REQUESTS_MS) {
      await sleep(MIN_DELAY_BETWEEN_REQUESTS_MS - timeSinceLastRequest, signal);
    }

    this.lastRequestTime = Date.now();
    this.requestTimestamps.push(this.lastRequestTime);
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
            this.backoffUntil.set(method, Date.now() + data.backoff * 1000);
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
      const backoffUntil = Date.now() + data.backoff * 1000;
      this.backoffUntil.set(method, backoffUntil);
      logger.warn({ backoff: data.backoff, method }, 'API requested backoff');
    }

    this.recordQuota(quotaRemaining, quotaMax);

    if (quotaRemaining !== undefined && quotaRemaining < QUOTA_WARNING_THRESHOLD) {
      logger.warn({ quotaRemaining, quotaMax }, 'Low API quota');
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
    if (remaining === undefined && max === undefined) {
      return;
    }
    this.quota = { remaining, max, observedAt: Date.now() };
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
  private async searchStackOverflow(
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
    const cacheKey = JSON.stringify({ query: safeQuery, tags: tags ?? [], options });
    const cachedEntry = this.responseCache.get(cacheKey);
    const now = Date.now();

    if (cachedEntry && cachedEntry.expiresAt > now) {
      return cachedEntry.value;
    }

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
        this.responseCache.set(cacheKey, {
          expiresAt: now + this.cacheTtlMs,
          value: paged,
        });
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
          const params = this.createApiParams({
            site: 'stackoverflow',
            filter: ANSWER_FILTER,
            sort: 'votes',
            order: 'desc',
            pagesize: '100',
            page: String(page),
          });

          const data = await this.withRateLimit<StackOverflowAnswer>(
            (fetchSignal) =>
              fetch(`${STACKOVERFLOW_API}/questions/${chunk.join(';')}/answers?${params}`, {
                signal: fetchSignal,
              }),
            'questions/answers',
            0,
            signal
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
        const data = await this.withRateLimit<StackOverflowComment>(
          (fetchSignal) =>
            fetch(`${STACKOVERFLOW_API}/posts/${chunk.join(';')}/comments?${params}`, {
              signal: fetchSignal,
            }),
          'posts/comments',
          0,
          signal
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
  ): Promise<{ content: TextContent[] }> {
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
  ): Promise<{ content: TextContent[] }> {
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
  ): Promise<{ content: TextContent[] }> {
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
  ): Promise<{ content: TextContent[] }> {
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
  ): Promise<{ content: TextContent[] }> {
    try {
      const input = parseInput(SearchByQuestionIdInputSchema, args);

      const params = this.createApiParams({
        site: 'stackoverflow',
        filter: DEFAULT_FILTER,
      });

      const data = await this.withRateLimit<StackOverflowQuestion>(
        (fetchSignal) =>
          fetch(`${STACKOVERFLOW_API}/questions/${input.questionId}?${params}`, {
            signal: fetchSignal,
          }),
        'questions/single',
        0,
        signal
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
  private toErrorResponse(error: unknown): {
    content: TextContent[];
    isError: true;
  } {
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
  private createErrorResponse(message: string): {
    content: TextContent[];
    isError: true;
  } {
    const sanitizedMessage = redactSecrets(message);
    return {
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
