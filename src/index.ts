#!/usr/bin/env node
/**
 * Stack Overflow MCP Server
 *
 * Provides MCP tools for searching Stack Overflow questions, answers, and comments.
 * Supports both stdio and HTTP (streamable-http) transport modes.
 *
 * Features:
 * - Search by error messages, tags, or stack traces
 * - Rate limiting with backoff handling
 * - API quota monitoring
 * - Structured logging with Pino
 * - Graceful shutdown handling
 */

// Suppress DEP0169 url.parse() deprecation warning emitted by transitive deps
// (e.g. parseurl used by express). This is a harmless warning with no CVE.
const __origEmitWarning = process.emitWarning;
process.emitWarning = ((msg: string | Error, ...args: unknown[]) => {
  if (typeof msg === 'string' && msg.includes('url.parse()')) return;
  return __origEmitWarning.apply(process, [msg, ...args] as Parameters<typeof process.emitWarning>);
}) as typeof process.emitWarning;

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { TextContent } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import * as z from 'zod';
import express, { type Request, type Response as ExpressResponse } from 'express';
import { logger } from './utils/logger.js';
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

const STACKOVERFLOW_API = 'https://api.stackexchange.com/2.3';

/**
 * API Filters
 * Using built-in filters instead of custom filter IDs to avoid invalidation issues.
 * - 'withbody': Includes default fields plus body content
 * - 'default': Standard fields only
 */
const DEFAULT_FILTER = 'withbody';
const ANSWER_FILTER = 'withbody';
const COMMENT_FILTER = 'default';

/**
 * Rate Limiting Configuration
 * Stack Exchange API allows 30 requests/second (concurrent throttle).
 * We use 25/sec with safety margin to account for concurrent requests.
 */
const MAX_REQUESTS_PER_SECOND = 25;
const RATE_LIMIT_WINDOW_MS = 1000;
const MIN_DELAY_BETWEEN_REQUESTS_MS = 40; // ~25 req/sec = 40ms between requests
const RETRY_AFTER_MS = 100;
const QUOTA_WARNING_THRESHOLD = 100;

/** Maximum character count for response text before truncation */
const CHARACTER_LIMIT = 25000;

/** Maximum number of answers included per question in formatted output */
const MAX_ANSWERS = 5;

/** Maximum characters of a question body included in formatted output */
const MAX_QUESTION_BODY_CHARS = 5000;

/** Maximum characters of an answer body included in formatted output */
const MAX_ANSWER_BODY_CHARS = 3000;

/**
 * Builds progressively broader query variants for fallback searching.
 *
 * Stack Exchange returns zero results for very specific queries (long error
 * messages), even when closely related questions exist. When the full query
 * yields nothing we retry with progressively shorter prefixes, which retain the
 * leading error type and message while dropping volatile trailing detail.
 *
 * @returns An ordered list of distinct query variants, most specific first.
 */
function buildQueryVariants(query: string): string[] {
  const words = query.split(/\s+/).filter((word) => word.length > 0);
  const variants: string[] = [query];

  // Only shorten when there is enough trailing detail to be worth dropping
  for (const maxWords of [8, 5, 3]) {
    if (words.length > maxWords) {
      const shortened = words.slice(0, maxWords).join(' ');
      if (!variants.includes(shortened)) {
        variants.push(shortened);
      }
    }
  }

  return variants;
}

/**
 * Truncates text to a character limit with a graceful message.
 * Preserves Markdown structure when possible.
 */
function truncateText(text: string, limit: number = CHARACTER_LIMIT): string {
  if (text.length <= limit) {
    return text;
  }
  const truncated = text.slice(0, limit);
  const lastNewline = truncated.lastIndexOf('\n');
  const cutPoint = lastNewline > limit * 0.8 ? lastNewline : limit;
  return (
    truncated.slice(0, cutPoint) +
    `\n\n> *Content truncated at ${CHARACTER_LIMIT.toLocaleString()} characters. Refine your search or use limit to narrow results.*`
  );
}

/**
 * Truncates a JSON payload while keeping it valid JSON.
 *
 * Slicing a serialized JSON string mid-way produces invalid JSON that clients
 * cannot parse. Instead we progressively drop trailing result entries until the
 * serialized payload fits, and report the truncation in the pagination metadata.
 */
function truncateJson(
  payload: { pagination: PaginationMeta; results: unknown[] },
  limit: number = CHARACTER_LIMIT
): string {
  const results = [...payload.results];
  let serialized = JSON.stringify(payload, null, 2);

  while (serialized.length > limit && results.length > 0) {
    results.pop();
    serialized = JSON.stringify(
      {
        pagination: { ...payload.pagination, pageSize: results.length },
        results,
        truncated: true,
        message: `Response exceeded ${limit.toLocaleString()} characters; some results were omitted. Reduce limit or refine your search.`,
      },
      null,
      2
    );
  }

  if (serialized.length <= limit) {
    return serialized;
  }

  // Even a single result is too large: fall back to a minimal valid payload.
  return JSON.stringify(
    {
      pagination: { ...payload.pagination, pageSize: 0 },
      results: [],
      truncated: true,
      message: `Response exceeded ${limit.toLocaleString()} characters. Refine your search or reduce limit.`,
    },
    null,
    2
  );
}

/** Named HTML entities commonly found in Stack Overflow post bodies. */
const HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  times: '×',
  divide: '÷',
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°',
  middot: '·',
  bull: '•',
  laquo: '«',
  raquo: '»',
  euro: '€',
  pound: '£',
  yen: '¥',
  cent: '¢',
  sect: '§',
  para: '¶',
  dagger: '†',
  permil: '‰',
  prime: '′',
  Prime: '″',
  larr: '←',
  rarr: '→',
  harr: '↔',
  uarr: '↑',
  darr: '↓',
  infin: '∞',
  ne: '≠',
  le: '≤',
  ge: '≥',
  minus: '−',
  plusmn: '±',
  frac12: '½',
  frac14: '¼',
  frac34: '¾',
  sup2: '²',
  sup3: '³',
  alpha: 'α',
  beta: 'β',
  gamma: 'γ',
  delta: 'δ',
  lambda: 'λ',
  mu: 'μ',
  pi: 'π',
  sigma: 'σ',
  omega: 'ω',
  Delta: 'Δ',
  Sigma: 'Σ',
  Omega: 'Ω',
};

/**
 * Decodes HTML entities (named and numeric) found in Stack Overflow post bodies.
 */
function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isNaN(code) ? match : String.fromCodePoint(code);
    }
    if (entity.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isNaN(code) ? match : String.fromCodePoint(code);
    }
    return HTML_ENTITIES[entity] ?? match;
  });
}

/**
 * Converts a Stack Overflow HTML post body into readable plain text / Markdown.
 *
 * Stack Overflow bodies are HTML fragments. Returning them verbatim makes the
 * output hard to read (raw tags, escaped entities such as `&#39;`). This helper
 * converts code blocks to fenced Markdown, inline code to backticks, and strips
 * the remaining markup while preserving paragraph and list structure.
 */
function htmlToText(html: string): string {
  if (!html) {
    return '';
  }

  let text = html;

  // Normalise line breaks
  text = text.replace(/\r\n?/g, '\n');

  // Fenced code blocks: <pre><code class="...">...</code></pre>
  text = text.replace(
    /<pre[^>]*>\s*<code[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi,
    (_match, code: string) => `\n\`\`\`\n${decodeHtmlEntities(code).trim()}\n\`\`\`\n`
  );
  // <pre> without <code>
  text = text.replace(
    /<pre[^>]*>([\s\S]*?)<\/pre>/gi,
    (_match, code: string) => `\n\`\`\`\n${decodeHtmlEntities(code).trim()}\n\`\`\`\n`
  );
  // Inline code
  text = text.replace(
    /<code[^>]*>([\s\S]*?)<\/code>/gi,
    (_match, code: string) => `\`${decodeHtmlEntities(code).trim()}\``
  );

  // Block-level elements become newlines
  text = text.replace(/<\/(p|div|section|article|blockquote|h[1-6]|tr)>/gi, '\n\n');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<li[^>]*>/gi, '\n- ');
  text = text.replace(/<\/li>/gi, '');
  text = text.replace(/<hr\s*\/?>/gi, '\n---\n');

  // Links: keep the visible text and the href
  text = text.replace(
    /<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_match, href: string, label: string) => {
      const cleanLabel = label.replace(/<[^>]+>/g, '').trim();
      return cleanLabel && cleanLabel !== href ? `${cleanLabel} (${href})` : href;
    }
  );

  // Strip any remaining tags
  text = text.replace(/<[^>]+>/g, '');

  // Decode entities last so decoded `<`/`>` are not treated as markup
  text = decodeHtmlEntities(text);

  // Collapse excessive blank lines and trailing whitespace
  text = text.replace(/[ \t]+\n/g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');

  return text.trim();
}

/** Generic stack-trace header lines that carry no search value. */
const STACK_TRACE_NOISE = [
  /^traceback \(most recent call last\):?$/i,
  /^during handling of the above exception/i,
  /^the above exception was the direct cause/i,
  /^at\s+/i,
  /^file\s+["']/i,
  /^\s*\.{3}\s*\d+\s+more\s*$/i,
  /^error:?\s*$/i,
];

/**
 * Generic prefixes that appear before the real error on the same line.
 * These are stripped rather than discarding the whole line, because in Java the
 * thread header and the exception share a line
 * (e.g. `Exception in thread "main" java.lang.NullPointerException: ...`).
 */
const STACK_TRACE_PREFIXES = [
  /^exception in thread\s+["“”']?[^"“”']*["“”']?\s*/i,
  /^caused by:\s*/i,
  /^uncaught\s+/i,
  /^fatal:\s*/i,
];

/**
 * Extracts the most meaningful error line from a stack trace.
 *
 * The first line is often a generic header (e.g. Python's
 * "Traceback (most recent call last):"), so we scan for the first line that
 * looks like an actual error message and fall back to the first non-empty line.
 * Generic prefixes on the same line are stripped so the exception type and
 * message are preserved.
 */
function extractErrorMessage(stackTrace: string): string {
  const lines = stackTrace
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return stackTrace.trim();
  }

  const isNoise = (line: string) => STACK_TRACE_NOISE.some((pattern) => pattern.test(line));

  const stripPrefixes = (line: string) => {
    let result = line;
    for (const pattern of STACK_TRACE_PREFIXES) {
      result = result.replace(pattern, '');
    }
    return result.trim();
  };

  // Prefer a line that names an error/exception type
  const errorLike = lines.find(
    (line) =>
      !isNoise(line) &&
      /(error|exception|fatal|panic|failed|failure|denied|refused|timeout|not found|undefined|null|cannot|unable|invalid|unexpected)/i.test(
        line
      )
  );
  if (errorLike) {
    return stripPrefixes(errorLike);
  }

  const firstMeaningful = lines.find((line) => !isNoise(line));
  return stripPrefixes(firstMeaningful ?? lines[0]);
}

/**
 * Cleans an error message so it works better as a Stack Exchange search query.
 *
 * Removes volatile fragments (file paths, hex addresses, line numbers, memory
 * addresses) that prevent the API from matching real questions, and strips
 * square brackets because Stack Exchange interprets `[...]` as tag syntax
 * (e.g. `[Errno 2]` is treated as a non-existent tag and yields zero results).
 */
function cleanErrorMessage(message: string): string {
  let cleaned = message;

  // Drop trailing stack frames / "at ..." segments
  cleaned = cleaned.split(/\s+at\s+/)[0];

  // Remove file paths and line/column references
  cleaned = cleaned.replace(/([A-Za-z]:)?[\\/][\w.\-/\\]+:\d+(:\d+)?/g, ' ');
  cleaned = cleaned.replace(/\([\w./\\-]+:\d+(:\d+)?\)/g, ' ');

  // Remove hex addresses and long numeric identifiers
  cleaned = cleaned.replace(/0x[0-9a-fA-F]+/g, ' ');
  cleaned = cleaned.replace(/\b[0-9a-fA-F]{8,}\b/g, ' ');

  // Square brackets are parsed as tag filters by the Stack Exchange search API
  cleaned = cleaned.replace(/[[\]]/g, ' ');

  // Unwrap quoted literals, keeping their content (e.g. 'length' -> length)
  cleaned = cleaned.replace(/['"`]/g, ' ');

  // Remove line/column suffixes like ":12:34"
  cleaned = cleaned.replace(/:\d+(:\d+)?\b/g, ' ');

  // Collapse whitespace and trim punctuation
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  cleaned = cleaned.replace(/^[\s:,-]+|[\s:,-]+$/g, '');

  return cleaned.length > 0 ? cleaned : message.trim();
}

const runtimeEnvSchema = z.object({
  PORT: z.string().trim().regex(/^\d+$/).transform((value) => Number(value)).optional(),
  STACKOVERFLOW_API_KEY: z.string().trim().min(1).optional(),
});

const runtimeEnv = runtimeEnvSchema.parse({
  PORT: process.env.PORT,
  STACKOVERFLOW_API_KEY: process.env.STACKOVERFLOW_API_KEY,
});

const PORT = runtimeEnv.PORT;
const USE_HTTP = PORT !== undefined;

// Session management for HTTP transport (one transport per MCP session)
const transports = new Map<string, StreamableHTTPServerTransport>();

/**
 * Extracts MCP session ID from HTTP request headers
 */
function getSessionId(
  headers: Request['headers'] | Record<string, string | string[] | undefined>
): string | undefined {
  const header = headers['mcp-session-id'] || headers['Mcp-Session-Id'];
  return typeof header === 'string' ? header : undefined;
}

/**
 * Sends a JSON-RPC error response.
 * Prevents sending response if headers have already been sent.
 *
 * @param res - Express response object
 * @param statusCode - HTTP status code
 * @param errorCode - JSON-RPC error code
 * @param message - Error message
 * @param id - Optional request ID for correlation
 */
function sendErrorResponse(
  res: ExpressResponse,
  statusCode: number,
  errorCode: number,
  message: string,
  id: unknown = null
): void {
  if (res.headersSent) {
    return;
  }
  res.status(statusCode).json({
    jsonrpc: '2.0',
    error: {
      code: errorCode,
      message,
    },
    id,
  });
}

/**
 * MCP Server for Stack Overflow API integration
 *
 * Provides tools for searching Stack Overflow by error messages, tags, and stack traces.
 * Implements rate limiting, backoff handling, and quota monitoring.
 */
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

  constructor() {
    this.apiKey = runtimeEnv.STACKOVERFLOW_API_KEY?.trim() || undefined;
    this.server = new McpServer(
      {
        name: 'stackoverflow-mcp',
        version: '0.2.0',
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
              version: '0.2.0',
              transport: USE_HTTP ? 'http' : 'stdio',
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
      async (args) => {
        try {
          const input = SearchByErrorInputSchema.parse(args) as SearchByErrorInput;
          return await this.handleSearchByError(input);
        } catch (error) {
          return this.createErrorResponse(
            `Validation failed: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
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
      async (args) => {
        try {
          const input = SearchByTagsInputSchema.parse(args) as SearchByTagsInput;
          return await this.handleSearchByTags(input);
        } catch (error) {
          return this.createErrorResponse(
            `Validation failed: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
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
      async (args) => {
        try {
          const input = StackTraceInputSchema.parse(args) as StackTraceInput;
          return await this.handleAnalyzeStackTrace(input);
        } catch (error) {
          return this.createErrorResponse(
            `Validation failed: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
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
      async (args) => {
        try {
          const input = SearchByQueryInputSchema.parse(args) as SearchByQueryInput;
          return await this.handleSearchByQuery(input);
        } catch (error) {
          return this.createErrorResponse(
            `Validation failed: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
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
      async (args) => {
        try {
          const input = SearchByQuestionIdInputSchema.parse(args) as SearchByQuestionIdInput;
          return await this.handleSearchByQuestionId(input);
        } catch (error) {
          return this.createErrorResponse(
            `Validation failed: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    );
  }

  // ========================================================================
  // Rate Limiting
  // ========================================================================

  /**
   * Checks and enforces rate limits before making API requests
   * Handles method-specific backoff, per-second limits, and minimum delays
   */
  private async checkRateLimit(method: string = 'default'): Promise<void> {
    const now = Date.now();

    // Check method-specific backoff (from API responses)
    const backoffUntil = this.backoffUntil.get(method);
    if (backoffUntil && now < backoffUntil) {
      const waitTime = backoffUntil - now;
      await new Promise((resolve) => setTimeout(resolve, waitTime));
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
        await new Promise((resolve) => setTimeout(resolve, waitTime));
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
      await new Promise((resolve) =>
        setTimeout(resolve, MIN_DELAY_BETWEEN_REQUESTS_MS - timeSinceLastRequest)
      );
    }

    this.lastRequestTime = Date.now();
    this.requestTimestamps.push(this.lastRequestTime);
  }

  /**
   * Wraps API requests with rate limiting, backoff handling, and error retry logic.
   *
   * Stack Exchange returns API-level errors with HTTP 200 and an `error_id` body,
   * so we must inspect the parsed payload rather than relying on `response.ok`.
   * Throttling is signalled either by HTTP 429 or by `error_id === 502`
   * (`throttle_violation`); both are retried with exponential backoff.
   */
  private async withRateLimit<T>(
    fn: () => Promise<globalThis.Response>,
    method: string = 'default',
    retries = 3
  ): Promise<ApiResponse<T>> {
    await this.checkRateLimit(method);

    let response: globalThis.Response;
    try {
      response = await fn();
    } catch (error) {
      // Network-level failure (DNS, connection reset, timeout)
      if (retries > 0) {
        const backoffTime = RETRY_AFTER_MS * Math.pow(2, 3 - retries);
        logger.warn(
          { backoffTime, retries, method, error: error instanceof Error ? error.message : String(error) },
          'Network error, retrying'
        );
        await new Promise((resolve) => setTimeout(resolve, backoffTime));
        return this.withRateLimit(fn, method, retries - 1);
      }
      throw error;
    }

    // Parse the body once; Stack Exchange always returns JSON.
    let data: ApiResponse<T> & Partial<ApiErrorResponse>;
    try {
      data = (await response.json()) as ApiResponse<T> & Partial<ApiErrorResponse>;
    } catch (error) {
      throw new Error(
        `Stack Overflow API returned an unreadable response (HTTP ${response.status}): ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    // API-level error (returned with HTTP 200 by Stack Exchange)
    if (typeof data.error_id === 'number') {
      const isThrottle = data.error_id === 502 || response.status === 429;
      if (isThrottle && retries > 0) {
        const backoffTime = RETRY_AFTER_MS * Math.pow(2, 3 - retries);
        logger.warn(
          { backoffTime, retries, method, errorId: data.error_id },
          'Rate limit hit, retrying'
        );
        await new Promise((resolve) => setTimeout(resolve, backoffTime));
        return this.withRateLimit(fn, method, retries - 1);
      }
      throw new Error(
        `Stack Overflow API error: ${data.error_message ?? 'unknown error'} (${data.error_id})`
      );
    }

    // HTTP-level failure without a structured error body
    if (!response.ok) {
      throw new Error(`Stack Overflow API request failed with HTTP ${response.status}`);
    }

    // Handle backoff requested by the API
    if (data.backoff) {
      const backoffUntil = Date.now() + data.backoff * 1000;
      this.backoffUntil.set(method, backoffUntil);
      logger.warn({ backoff: data.backoff, method }, 'API requested backoff');
    }

    // Warn if quota is running low
    if (typeof data.quota_remaining === 'number' && data.quota_remaining < QUOTA_WARNING_THRESHOLD) {
      logger.warn(
        { quotaRemaining: data.quota_remaining, quotaMax: data.quota_max },
        'Low API quota'
      );
    }

    return data;
  }

  // ========================================================================
  // Helper Methods
  // ========================================================================

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

    // Attempts: progressively shorter queries, then (if tags were supplied and
    // matched nothing) the original query without the tag filter. An invalid or
    // overly narrow tag silently yields zero results on the Stack Exchange API,
    // so relaxing it is preferable to returning nothing.
    const attempts: { query: string; tags?: string[]; note?: string }[] = variants.map(
      (variant) => ({ query: variant, ...(tags && tags.length > 0 ? { tags } : {}) })
    );
    if (tags && tags.length > 0) {
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
        ...(options.limit && { pagesize: options.limit.toString() }),
        ...(options.page && options.page > 1 && { page: options.page.toString() }),
        ...(hasMinScore && { min: options.minScore!.toString() }),
        ...(options.acceptedOnly && { accepted: 'True' }),
      });

      try {
        const data = await this.withRateLimit<StackOverflowQuestion>(
          () => fetch(`${STACKOVERFLOW_API}/search/advanced?${params}`),
          'search/advanced'
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

        const results = await this.processSearchResults(data.items, options);
        const paged: PagedSearchResults = {
          results,
          page: options.page ?? 1,
          hasMore: Boolean(data.has_more),
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
   * Fetches answers for one or more questions in a single API call.
   *
   * The Stack Exchange API accepts semicolon-separated IDs (up to 100), which
   * avoids the N+1 request pattern of fetching answers per question.
   */
  private async fetchAnswersForQuestions(
    questionIds: number[]
  ): Promise<Map<number, StackOverflowAnswer[]>> {
    const grouped = new Map<number, StackOverflowAnswer[]>();
    if (questionIds.length === 0) {
      return grouped;
    }

    const params = this.createApiParams({
      site: 'stackoverflow',
      filter: ANSWER_FILTER,
      sort: 'votes',
      order: 'desc',
      pagesize: '100',
    });

    try {
      const data = await this.withRateLimit<StackOverflowAnswer>(
        () =>
          fetch(
            `${STACKOVERFLOW_API}/questions/${questionIds.join(';')}/answers?${params}`
          ),
        'questions/answers'
      );

      for (const answer of data.items || []) {
        const existing = grouped.get(answer.question_id) ?? [];
        existing.push(answer);
        grouped.set(answer.question_id, existing);
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
    questionId: number
  ): Promise<StackOverflowAnswer[]> {
    const grouped = await this.fetchAnswersForQuestions([questionId]);
    return grouped.get(questionId) ?? [];
  }

  /**
   * Fetches comments for one or more posts in a single API call.
   */
  private async fetchCommentsForPosts(
    postIds: number[]
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
      const data = await this.withRateLimit<StackOverflowComment>(
        () =>
          fetch(`${STACKOVERFLOW_API}/posts/${postIds.join(';')}/comments?${params}`),
        'posts/comments'
      );

      for (const comment of data.items || []) {
        const existing = grouped.get(comment.post_id) ?? [];
        existing.push(comment);
        grouped.set(comment.post_id, existing);
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
  private async fetchComments(postId: number): Promise<StackOverflowComment[]> {
    const grouped = await this.fetchCommentsForPosts([postId]);
    return grouped.get(postId) ?? [];
  }

  /**
   * Processes search results, fetching answers and optionally comments.
   *
   * Answers for all questions are fetched in a single batched request, and
   * comments for all posts in a second batched request, keeping the number of
   * API calls constant regardless of result count.
   */
  private async processSearchResults(
    questions: StackOverflowQuestion[],
    options: {
      minScore?: number;
      includeComments?: boolean;
    }
  ): Promise<SearchResult[]> {
    const filtered = questions.filter(
      (question) => !options.minScore || question.score >= options.minScore
    );

    if (filtered.length === 0) {
      return [];
    }

    const answersByQuestion = await this.fetchAnswersForQuestions(
      filtered.map((question) => question.question_id)
    );

    let commentsByPost = new Map<number, StackOverflowComment[]>();
    if (options.includeComments) {
      const postIds = [
        ...filtered.map((question) => question.question_id),
        ...Array.from(answersByQuestion.values()).flat().map((answer) => answer.answer_id),
      ];
      commentsByPost = await this.fetchCommentsForPosts(postIds);
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
    args: SearchByErrorInput | unknown
  ): Promise<{ content: TextContent[] }> {
    try {
      const input = SearchByErrorInputSchema.parse(args) as SearchByErrorInput;
      const tags = [
        ...(input.language ? [input.language.toLowerCase()] : []),
        ...(input.technologies || []),
      ];

      const paged = await this.searchStackOverflow(
        cleanErrorMessage(input.errorMessage),
        tags.length > 0 ? tags : undefined,
        {
          ...(input.minScore !== undefined ? { minScore: input.minScore } : {}),
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
      return this.createErrorResponse(
        `Validation failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Handles search_by_tags tool requests
   */
  private async handleSearchByTags(
    args: SearchByTagsInput | unknown
  ): Promise<{ content: TextContent[] }> {
    try {
      const input = SearchByTagsInputSchema.parse(args) as SearchByTagsInput;
      const params = this.createApiParams({
        site: 'stackoverflow',
        sort: 'votes',
        order: 'desc',
        filter: DEFAULT_FILTER,
        tagged: input.tags.join(';'),
        ...(input.limit && { pagesize: input.limit.toString() }),
        ...(input.page && input.page > 1 && { page: input.page.toString() }),
        ...(input.minScore !== undefined && input.minScore > 0 && { min: input.minScore.toString() }),
      });

      const data = await this.withRateLimit<StackOverflowQuestion>(
        () => fetch(`${STACKOVERFLOW_API}/questions?${params}`),
        'questions'
      );

      const results = await this.processSearchResults(data.items, {
        ...(input.minScore !== undefined ? { minScore: input.minScore } : {}),
        ...(input.includeComments !== undefined ? { includeComments: input.includeComments } : {}),
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
      return this.createErrorResponse(
        `Validation failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Handles analyze_stack_trace tool requests
   */
  private async handleAnalyzeStackTrace(
    args: StackTraceInput | unknown
  ): Promise<{ content: TextContent[] }> {
    try {
      const input = StackTraceInputSchema.parse(args) as StackTraceInput;
      const errorMessage = extractErrorMessage(input.stackTrace);

      const paged = await this.searchStackOverflow(
        cleanErrorMessage(errorMessage),
        [input.language.toLowerCase()],
        {
          minScore: 0,
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
      return this.createErrorResponse(
        `Validation failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Handles search_by_query tool requests
   */
  private async handleSearchByQuery(
    args: SearchByQueryInput | unknown
  ): Promise<{ content: TextContent[] }> {
    try {
      const input = SearchByQueryInputSchema.parse(args) as SearchByQueryInput;

      const paged = await this.searchStackOverflow(
        input.query,
        input.tags,
        {
          ...(input.minScore !== undefined ? { minScore: input.minScore } : {}),
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
          ...(input.includeComments !== undefined ? { includeComments: input.includeComments } : {}),
          ...(input.page !== undefined ? { page: input.page } : {}),
          ...(input.acceptedOnly ? { acceptedOnly: true } : {}),
        }
      );

      // Belt-and-braces: the API `accepted=True` filter is authoritative, but we
      // also drop any question without an accepted answer locally.
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
      return this.createErrorResponse(
        `Validation failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Handles search_by_question_id tool requests
   */
  private async handleSearchByQuestionId(
    args: SearchByQuestionIdInput | unknown
  ): Promise<{ content: TextContent[] }> {
    try {
      const input = SearchByQuestionIdInputSchema.parse(args) as SearchByQuestionIdInput;

      const params = this.createApiParams({
        site: 'stackoverflow',
        filter: DEFAULT_FILTER,
      });

      const data = await this.withRateLimit<StackOverflowQuestion>(
        () => fetch(`${STACKOVERFLOW_API}/questions/${input.questionId}?${params}`),
        'questions/single'
      );

      if (!data.items || data.items.length === 0) {
        return this.createErrorResponse(`No question found with ID: ${input.questionId}`);
      }

      const question = data.items[0];
      const includeAnswers = input.includeAnswers !== false; // default true
      const answers = includeAnswers
        ? await this.fetchAnswers(question.question_id)
        : [];

      let comments: SearchResultComments | undefined;
      if (input.includeComments) {
        const postIds = [
          question.question_id,
          ...answers.map((answer) => answer.answer_id),
        ];
        const commentsByPost = await this.fetchCommentsForPosts(postIds);
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
      return this.createErrorResponse(
        `Validation failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // ========================================================================
  // Response Formatting
  // ========================================================================

  /**
   * Formats search results as JSON or Markdown with pagination metadata and truncation.
   *
   * @param results - Search results to format
   * @param format - Output format (json or markdown)
   * @param paginationInfo - Optional pagination state from the API response
   */
  private formatResponse(
    results: SearchResult[],
    format: 'json' | 'markdown' = 'json',
    paginationInfo?: { page?: number; hasMore?: boolean; notes?: string[] }
  ): string {
    const pagination: PaginationMeta = {
      page: paginationInfo?.page ?? 1,
      pageSize: results.length,
      totalCount: results.length,
      hasMore: paginationInfo?.hasMore ?? false,
    };
    const notes = paginationInfo?.notes ?? [];

    if (format === 'json') {
      const output = {
        pagination,
        ...(notes.length > 0 ? { notes } : {}),
        results: results.map((result) => ({
          question: {
            question_id: result.question.question_id,
            title: result.question.title,
            score: result.question.score,
            answer_count: result.question.answer_count,
            is_answered: result.question.is_answered,
            accepted_answer_id: result.question.accepted_answer_id,
            link: result.question.link,
            tags: result.question.tags,
            body: htmlToText(result.question.body).slice(0, MAX_QUESTION_BODY_CHARS),
          },
          // Cap answers and body length so a single popular question cannot
          // blow past the character limit and force the whole payload to be dropped.
          answers: result.answers.slice(0, MAX_ANSWERS).map((answer) => ({
            answer_id: answer.answer_id,
            score: answer.score,
            is_accepted: answer.is_accepted,
            link: answer.link,
            body: htmlToText(answer.body).slice(0, MAX_ANSWER_BODY_CHARS),
          })),
          answers_omitted: Math.max(0, result.answers.length - MAX_ANSWERS),
          comments: result.comments
            ? {
                question: result.comments.question.slice(0, 3).map((comment) => ({
                  score: comment.score,
                  body: htmlToText(comment.body).slice(0, 220),
                })),
                answers: Object.fromEntries(
                  Object.entries(result.comments.answers).map(([answerId, comments]) => [
                    answerId,
                    comments.slice(0, 3).map((comment) => ({
                      score: comment.score,
                      body: htmlToText(comment.body).slice(0, 220),
                    })),
                  ])
                ),
              }
            : undefined,
        })),
      };
      return truncateJson(output);
    }
    const markdown = results
      .map((result) => {
        let md = `# ${htmlToText(result.question.title)}\n\n`;        md += `**Score:** ${result.question.score} | **Answers:** ${result.question.answer_count} | **Tags:** ${result.question.tags.join(', ')}\n\n`;
        md += `## Question\n\n${htmlToText(result.question.body).slice(0, MAX_QUESTION_BODY_CHARS)}\n\n`;

        if (result.comments?.question && result.comments.question.length > 0) {
          md += '### Question Comments\n\n';
          result.comments.question.slice(0, 5).forEach((comment: StackOverflowComment) => {
            md += `- ${htmlToText(comment.body).slice(0, 300)} *(Score: ${comment.score})*\n`;
          });
          md += '\n';
        }

        // Only render the answers section when answers are present, so that
        // `includeAnswers: false` does not emit an empty heading.
        if (result.answers.length > 0) {
          md += '## Answers\n\n';
          result.answers.slice(0, MAX_ANSWERS).forEach((answer: StackOverflowAnswer) => {
            md += `### ${answer.is_accepted ? '✓ ' : ''}Answer (Score: ${answer.score})\n\n`;
            md += `${htmlToText(answer.body).slice(0, MAX_ANSWER_BODY_CHARS)}\n\n`;

            if (result.comments?.answers[answer.answer_id]) {
              md += '#### Answer Comments\n\n';
              result.comments.answers[answer.answer_id].slice(0, 3).forEach(
                (comment: StackOverflowComment) => {
                  md += `- ${htmlToText(comment.body).slice(0, 200)} *(Score: ${comment.score})*\n`;
                }
              );
              md += '\n';
            }
          });
        }

        md += `---\n\n[View on Stack Overflow](${result.question.link})\n\n`;
        return md;
      })
      .join('\n\n');

    const notesBlock =
      notes.length > 0 ? `> **Note:** ${notes.join(' ')}\n\n` : '';

    return truncateText(notesBlock + markdown);
  }

  /**
   * Creates a standardized error response
   */
  private createErrorResponse(message: string): {
    content: TextContent[];
    isError: true;
  } {
    const sanitizedMessage = message.replace(/(api[_-]?key|token|authorization)=([^\s]+)/gi, '$1=***');
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

/**
 * Sets up HTTP transport with Express server
 *
 * Configures all standard MCP endpoints:
 * - GET /health - Health check endpoint
 * - GET /mcp - SSE stream endpoint (returns 404 for stateless servers)
 * - DELETE /mcp - Session termination endpoint
 * - POST /mcp - Main MCP endpoint for requests
 *
 * @param server - The StackOverflowServer instance
 * @param port - The port number to listen on (must be defined)
 */
function setupHttpTransport(server: StackOverflowServer, port: number): void {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.disable('x-powered-by');

  // Health check endpoint
  app.get('/health', (_req: Request, res: ExpressResponse) => {
    res.json({
      status: 'ok',
      service: 'mcp-stackoverflow',
      version: '0.2.0',
      activeSessions: transports.size,
    });
  });

  // SSE stream endpoint (GET /mcp)
  // According to MCP specification, StreamableHTTPServerTransport.handleRequest
  // can handle both POST and GET requests, automatically processing SSE streams
  // when Accept: text/event-stream header is present.
  app.get('/mcp', async (req: Request, res: ExpressResponse) => {
    const sessionId = getSessionId(req.headers);

    if (!sessionId) {
      sendErrorResponse(res, 400, -32000, 'Bad Request: No session ID provided');
      return;
    }

    const transport = transports.get(sessionId);
    if (!transport) {
      sendErrorResponse(res, 404, -32000, 'Session not found');
      return;
    }

    try {
      // transport.handleRequest automatically handles GET with Accept: text/event-stream
      // It will set appropriate SSE headers and stream responses
      await transport.handleRequest(req, res, null);
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error), sessionId },
        'Error handling SSE stream request',
      );
      sendErrorResponse(res, 500, -32603, 'Internal server error');
    }
  });

  // Session termination endpoint (DELETE /mcp)
  app.delete('/mcp', async (req: Request, res: ExpressResponse) => {
    const sessionId = getSessionId(req.headers);

    if (!sessionId) {
      sendErrorResponse(res, 400, -32000, 'Bad Request: No session ID provided');
      return;
    }

    const transport = transports.get(sessionId);
    if (!transport) {
      sendErrorResponse(res, 404, -32000, 'Session not found');
      return;
    }

    try {
      await transport.handleRequest(req, res, req.body);
      transports.delete(sessionId);
      logger.info({ sessionId, totalSessions: transports.size }, 'Session deleted');
    } catch (error) {
      logger.error({ error: error instanceof Error ? error.message : String(error), sessionId }, 'Error handling session termination');
      sendErrorResponse(res, 500, -32603, 'Error handling session termination');
    }
  });

  // Main MCP endpoint (POST /mcp)
  app.post('/mcp', async (req: Request, res: ExpressResponse) => {
    try {
      const sessionId = getSessionId(req.headers);
      const requestId = typeof req.body === 'object' && req.body !== null && 'id' in req.body ? req.body.id : null;

      // Handle existing session
      if (sessionId) {
        const transport = transports.get(sessionId);
        if (transport) {
          await transport.handleRequest(req, res, req.body);
          return;
        }
        sendErrorResponse(res, 404, -32000, 'Session not found', requestId);
        return;
      }

      // No session ID - only allow initialize requests to create new sessions
      const isInitialize =
        typeof req.body === 'object' &&
        req.body !== null &&
        'method' in req.body &&
        req.body.method === 'initialize';

      if (!isInitialize) {
        sendErrorResponse(res, 400, -32000, 'Bad Request: No session ID provided', requestId);
        return;
      }

      // Create new session for initialize request
      const newServer = new StackOverflowServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (sessionId: string) => {
          logger.info({ sessionId, totalSessions: transports.size + 1 }, 'Session initialized');
          transports.set(sessionId, transport);
        },
      });

      newServer.getServer().server.onclose = () => {
        const sid = transport.sessionId;
        if (sid && transports.has(sid)) {
          logger.info({ sessionId: sid, totalSessions: transports.size - 1 }, 'Session closed');
          transports.delete(sid);
        }
      };

      const connect = newServer.getServer().connect.bind(newServer.getServer());
      await connect(transport as Parameters<typeof connect>[0]);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger.error({ error: errorMessage }, 'Error handling MCP request');
      const requestId = typeof req.body === 'object' && req.body !== null && 'id' in req.body ? req.body.id : null;
      sendErrorResponse(res, 500, -32603, 'Internal server error', requestId);
    }
  });

  const httpServer = app.listen(port, '0.0.0.0', () => {
    const apiKeyStatus = server.hasApiKey() ? 'with API key (increased rate limits)' : 'without API key (standard rate limits)';
    logger.info({ port, apiKeyStatus }, 'Stack Overflow MCP server started');
  });

  // Graceful shutdown handler
  const shutdown = async () => {
    logger.info('Shutting down...');
    for (const [sessionId, transport] of transports.entries()) {
      try {
        await transport.close();
      } catch (error) {
        logger.error({ error: error instanceof Error ? error.message : String(error), sessionId }, 'Error closing transport');
      }
    }
    transports.clear();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

/**
 * Main entry point - initializes server and selects transport mode.
 * Automatically uses HTTP transport if PORT environment variable is set,
 * otherwise falls back to stdio transport.
 */
async function main(): Promise<void> {
  const server = new StackOverflowServer();

  if (USE_HTTP && PORT !== undefined) {
    setupHttpTransport(server, PORT);
  } else if (USE_HTTP) {
    throw new Error('PORT environment variable must be set for HTTP transport mode');
  } else {
    await server.runStdio();
  }
}

main().catch((error) => {
  logger.error({ error }, 'Fatal error');
  process.exit(1);
});
