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
  SearchResultOutput,
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
  private readonly responseCache = new Map<string, { expiresAt: number; value: SearchResult[] }>();

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
        },
        outputSchema: {
          query: z.string(),
          pagination: z.object({
            page: z.number(),
            pageSize: z.number(),
            totalCount: z.number(),
            hasMore: z.boolean(),
          }),
          results: z.array(z.object({
            questionId: z.number(),
            title: z.string(),
            score: z.number(),
            answerCount: z.number(),
            isAnswered: z.boolean(),
            link: z.string(),
          })),
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
        },
        outputSchema: {
          query: z.string(),
          pagination: z.object({
            page: z.number(),
            pageSize: z.number(),
            totalCount: z.number(),
            hasMore: z.boolean(),
          }),
          results: z.array(z.object({
            questionId: z.number(),
            title: z.string(),
            score: z.number(),
            answerCount: z.number(),
            isAnswered: z.boolean(),
            link: z.string(),
          })),
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
          'Extracts the error message from the first line of the stack trace and searches for matching questions. ' +
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
        },
        outputSchema: {
          query: z.string(),
          pagination: z.object({
            page: z.number(),
            pageSize: z.number(),
            totalCount: z.number(),
            hasMore: z.boolean(),
          }),
          results: z.array(z.object({
            questionId: z.number(),
            title: z.string(),
            score: z.number(),
            answerCount: z.number(),
            isAnswered: z.boolean(),
            link: z.string(),
          })),
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
        },
        outputSchema: {
          query: z.string(),
          pagination: z.object({
            page: z.number(),
            pageSize: z.number(),
            totalCount: z.number(),
            hasMore: z.boolean(),
          }),
          results: z.array(z.object({
            questionId: z.number(),
            title: z.string(),
            score: z.number(),
            answerCount: z.number(),
            isAnswered: z.boolean(),
            link: z.string(),
          })),
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
        outputSchema: {
          questionId: z.number(),
          title: z.string(),
          score: z.number(),
          answerCount: z.number(),
          isAnswered: z.boolean(),
          link: z.string(),
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
   * Wraps API requests with rate limiting, backoff handling, and error retry logic
   */
  private async withRateLimit<T>(
    fn: () => Promise<globalThis.Response>,
    method: string = 'default',
    retries = 3
  ): Promise<ApiResponse<T>> {
    await this.checkRateLimit(method);

    try {
      const response = await fn();

      if (!response.ok) {
        const errorData = (await response.json()) as ApiErrorResponse;
        throw new Error(
          `Stack Overflow API error: ${errorData.error_message} (${errorData.error_id})`
        );
      }

      const data = (await response.json()) as ApiResponse<T>;

      // Handle backoff from API response
      if (data.backoff) {
        const backoffUntil = Date.now() + data.backoff * 1000;
        this.backoffUntil.set(method, backoffUntil);
        logger.warn({ backoff: data.backoff, method }, 'API requested backoff');
      }

      // Warn if quota is running low
      if (data.quota_remaining < QUOTA_WARNING_THRESHOLD) {
        logger.warn(
          { quotaRemaining: data.quota_remaining, quotaMax: data.quota_max },
          'Low API quota'
        );
      }

      return data;
    } catch (error) {
      // Retry on 429 (rate limit) errors with exponential backoff
      if (
        retries > 0 &&
        ((error instanceof Error && error.message.includes('429')) ||
          (typeof error === 'object' &&
            error !== null &&
            'status' in error &&
            error.status === 429))
      ) {
        const backoffTime = RETRY_AFTER_MS * (4 - retries);
        logger.warn({ backoffTime, retries }, 'Rate limit hit (429), retrying');
        await new Promise((resolve) => setTimeout(resolve, backoffTime));
        return this.withRateLimit(fn, method, retries - 1);
      }
      throw error;
    }
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
   * Searches Stack Overflow using the advanced search endpoint
   */
  private async searchStackOverflow(
    query: string,
    tags?: string[],
    options: {
      minScore?: number;
      limit?: number;
      includeComments?: boolean;
    } = {}
  ): Promise<SearchResult[]> {
    const safeQuery = query.trim().slice(0, 500);
    const cacheKey = JSON.stringify({ query: safeQuery, tags: tags ?? [], options });
    const cachedEntry = this.responseCache.get(cacheKey);
    const now = Date.now();

    if (cachedEntry && cachedEntry.expiresAt > now) {
      return cachedEntry.value;
    }

    const params = this.createApiParams({
      site: 'stackoverflow',
      sort: 'votes',
      order: 'desc',
      filter: DEFAULT_FILTER,
      q: safeQuery,
      ...(tags && { tagged: tags.join(';') }),
      ...(options.limit && { pagesize: options.limit.toString() }),
    });

    try {
      const data = await this.withRateLimit<StackOverflowQuestion>(
        () => fetch(`${STACKOVERFLOW_API}/search/advanced?${params}`),
        'search/advanced'
      );

      const results = await this.processSearchResults(data.items, options);
      this.responseCache.set(cacheKey, {
        expiresAt: now + this.cacheTtlMs,
        value: results,
      });
      return results;
    } catch (error) {
      throw new Error(
        `Failed to search Stack Overflow: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  /**
   * Fetches answers for a specific question
   */
  private async fetchAnswers(
    questionId: number
  ): Promise<StackOverflowAnswer[]> {
    const params = this.createApiParams({
      site: 'stackoverflow',
      filter: ANSWER_FILTER,
      sort: 'votes',
      order: 'desc',
    });

    try {
      const data = await this.withRateLimit<StackOverflowAnswer>(
        () => fetch(`${STACKOVERFLOW_API}/questions/${questionId}/answers?${params}`),
        'questions/answers'
      );
      return data.items || [];
    } catch (error) {
      throw new Error(
        `Failed to fetch answers: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  /**
   * Fetches comments for a post (question or answer)
   */
  private async fetchComments(postId: number): Promise<StackOverflowComment[]> {
    const params = this.createApiParams({
      site: 'stackoverflow',
      filter: COMMENT_FILTER,
      sort: 'votes',
      order: 'desc',
    });

    try {
      const data = await this.withRateLimit<StackOverflowComment>(
        () => fetch(`${STACKOVERFLOW_API}/posts/${postId}/comments?${params}`),
        'posts/comments'
      );
      return data.items || [];
    } catch (error) {
      throw new Error(
        `Failed to fetch comments: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  /**
   * Processes search results, fetching answers and optionally comments
   */
  private async processSearchResults(
    questions: StackOverflowQuestion[],
    options: {
      minScore?: number;
      includeComments?: boolean;
    }
  ): Promise<SearchResult[]> {
    const results: SearchResult[] = [];

    for (const question of questions) {
      // Filter by minimum score if specified
      if (options.minScore && question.score < options.minScore) {
        continue;
      }

      const answers = await this.fetchAnswers(question.question_id);
      let comments: SearchResultComments | undefined;

      if (options.includeComments) {
        const answersMap: { [key: number]: StackOverflowComment[] } = {};
        comments = {
          question: await this.fetchComments(question.question_id),
          answers: answersMap,
        };

        for (const answer of answers) {
          if (answer.answer_id !== undefined) {
            comments.answers[answer.answer_id] = await this.fetchComments(
              answer.answer_id
            );
          }
        }
      }

      const searchResult: SearchResult = {
        question,
        answers,
      };

      if (options.includeComments && comments) {
        searchResult.comments = comments;
      }

      results.push(searchResult);
    }

    return results;
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

      const results = await this.searchStackOverflow(
        input.errorMessage,
        tags.length > 0 ? tags : undefined,
        {
          ...(input.minScore !== undefined ? { minScore: input.minScore } : {}),
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
          ...(input.includeComments !== undefined ? { includeComments: input.includeComments } : {}),
        }
      );

      return {
        content: [
          {
            type: 'text' as const,
            text: this.formatResponse(results, input.responseFormat),
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
            text: this.formatResponse(results, input.responseFormat),
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
      const errorLines = input.stackTrace.split('\n');
      const errorMessage = errorLines[0];

      const results = await this.searchStackOverflow(
        errorMessage,
        [input.language.toLowerCase()],
        {
          minScore: 0,
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
          ...(input.includeComments !== undefined ? { includeComments: input.includeComments } : {}),
        }
      );

      return {
        content: [
          {
            type: 'text' as const,
            text: this.formatResponse(results, input.responseFormat),
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

      const results = await this.searchStackOverflow(
        input.query,
        input.tags,
        {
          ...(input.minScore !== undefined ? { minScore: input.minScore } : {}),
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
          ...(input.includeComments !== undefined ? { includeComments: input.includeComments } : {}),
        }
      );

      let filteredResults = results;
      if (input.acceptedOnly) {
        filteredResults = results.filter((r) => r.question.is_answered);
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: this.formatResponse(filteredResults, input.responseFormat),
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
        return {
          content: [
            {
              type: 'text' as const,
              text: `No question found with ID: ${input.questionId}`,
            },
          ],
        };
      }

      const question = data.items[0];
      const includeAnswers = input.includeAnswers !== false; // default true
      const answers = includeAnswers
        ? await this.fetchAnswers(question.question_id)
        : [];

      let comments: SearchResultComments | undefined;
      if (input.includeComments) {
        const answersMap: { [key: number]: StackOverflowComment[] } = {};
        comments = {
          question: await this.fetchComments(question.question_id),
          answers: answersMap,
        };
        for (const answer of answers) {
          if (answer.answer_id !== undefined) {
            comments.answers[answer.answer_id] = await this.fetchComments(answer.answer_id);
          }
        }
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
   * Formats search results as JSON or Markdown with pagination metadata and truncation
   */
  private formatResponse(
    results: SearchResult[],
    format: 'json' | 'markdown' = 'json'
  ): string {
    const pagination: PaginationMeta = {
      page: 1,
      pageSize: results.length,
      totalCount: results.length,
      hasMore: false,
    };

    if (format === 'json') {
      const output = {
        pagination,
        results: results.map((result) => ({
          question: {
            question_id: result.question.question_id,
            title: result.question.title,
            score: result.question.score,
            answer_count: result.question.answer_count,
            is_answered: result.question.is_answered,
            link: result.question.link,
            tags: result.question.tags,
          },
          answers: result.answers.map((answer) => ({
            answer_id: answer.answer_id,
            score: answer.score,
            is_accepted: answer.is_accepted,
            link: answer.link,
          })),
          comments: result.comments
            ? {
                question: result.comments.question.slice(0, 3).map((comment) => ({
                  score: comment.score,
                  body: comment.body.slice(0, 220),
                })),
              }
            : undefined,
        })),
      };
      return truncateText(JSON.stringify(output, null, 2));
    }

    const markdown = results
      .map((result) => {
        let md = `# ${result.question.title}\n\n`;
        md += `**Score:** ${result.question.score} | **Answers:** ${result.question.answer_count} | **Tags:** ${result.question.tags.join(', ')}\n\n`;
        md += `## Question\n\n${result.question.body.slice(0, 5000)}\n\n`;

        if (result.comments?.question && result.comments.question.length > 0) {
          md += '### Question Comments\n\n';
          result.comments.question.slice(0, 5).forEach((comment: StackOverflowComment) => {
            md += `- ${comment.body.slice(0, 300)} *(Score: ${comment.score})*\n`;
          });
          md += '\n';
        }

        md += '## Answers\n\n';
        result.answers.slice(0, 5).forEach((answer: StackOverflowAnswer) => {
          md += `### ${answer.is_accepted ? '✓ ' : ''}Answer (Score: ${answer.score})\n\n`;
          md += `${answer.body.slice(0, 3000)}\n\n`;

          if (result.comments?.answers[answer.answer_id]) {
            md += '#### Answer Comments\n\n';
            result.comments.answers[answer.answer_id].slice(0, 3).forEach(
              (comment: StackOverflowComment) => {
                md += `- ${comment.body.slice(0, 200)} *(Score: ${comment.score})*\n`;
              }
            );
            md += '\n';
          }
        });

        md += `---\n\n[View on Stack Overflow](${result.question.link})\n\n`;
        return md;
      })
      .join('\n\n');

    return truncateText(markdown);
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
