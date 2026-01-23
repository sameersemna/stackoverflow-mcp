#!/usr/bin/env node
/**
 * Stack Overflow MCP Server
 *
 * Provides MCP tools for searching Stack Overflow questions, answers, and comments.
 * Supports both stdio and HTTP (streamable-http) transport modes.
 *
 * @module stackoverflow-mcp
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { TextContent } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import * as z from 'zod';
import express, { type Request, type Response as ExpressResponse } from 'express';
import {
  SearchByErrorInput,
  SearchByTagsInput,
  StackTraceInput,
  SearchResult,
  StackOverflowQuestion,
  StackOverflowAnswer,
  StackOverflowComment,
  SearchResultComments,
  ApiErrorResponse,
  ApiResponse,
} from './types/index.js';

// ============================================================================
// Configuration Constants
// ============================================================================

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

// ============================================================================
// Transport Configuration
// ============================================================================

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : undefined;
const USE_HTTP = PORT !== undefined;

// Session management for HTTP transport (one transport per MCP session)
const transports = new Map<string, StreamableHTTPServerTransport>();

// ============================================================================
// Helper Functions
// ============================================================================

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
 * Sends a JSON-RPC error response
 */
function sendErrorResponse(
  res: ExpressResponse,
  statusCode: number,
  errorCode: number,
  message: string
): void {
  res.status(statusCode).json({
    jsonrpc: '2.0',
    error: {
      code: errorCode,
      message,
    },
    id: null,
  });
}


// ============================================================================
// StackOverflowServer Class
// ============================================================================

/**
 * MCP Server for Stack Overflow API integration
 *
 * Provides tools for searching Stack Overflow by error messages, tags, and stack traces.
 * Implements rate limiting, backoff handling, and quota monitoring.
 */
export class StackOverflowServer {
  private server: McpServer;
  private apiKey?: string;
  private requestTimestamps: number[] = [];
  private backoffUntil: Map<string, number> = new Map();
  private lastRequestTime: number = 0;

  constructor() {
    this.apiKey = process.env.STACKOVERFLOW_API_KEY;
    this.server = new McpServer(
      {
        name: 'stackoverflow-mcp',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupTools();
    this.setupErrorHandling();
  }

  // ========================================================================
  // Setup Methods
  // ========================================================================

  private setupErrorHandling(): void {
    this.server.server.onerror = (error) => console.error('[MCP Error]', error);
  }

  private setupTools(): void {
    this.registerSearchByErrorTool();
    this.registerSearchByTagsTool();
    this.registerAnalyzeStackTraceTool();
  }

  private registerSearchByErrorTool(): void {
    this.server.registerTool(
      'search_by_error',
      {
        description: 'Search Stack Overflow for error-related questions',
        inputSchema: {
          errorMessage: z.string().describe('Error message to search for'),
          language: z.string().optional().describe('Programming language'),
          technologies: z.array(z.string()).optional().describe('Related technologies'),
          minScore: z.number().optional().describe('Minimum score threshold'),
          includeComments: z.boolean().optional().describe('Include comments in results'),
          responseFormat: z.enum(['json', 'markdown']).optional().describe('Response format'),
          limit: z.number().optional().describe('Maximum number of results'),
        },
      },
      async (args) => {
        try {
          const input = args as SearchByErrorInput;
          if (!input.errorMessage) {
            return this.createErrorResponse('Error: errorMessage is required');
          }
          return await this.handleSearchByError(input);
        } catch (error) {
          return this.createErrorResponse(
            error instanceof Error ? error.message : String(error)
          );
        }
      }
    );
  }

  private registerSearchByTagsTool(): void {
    this.server.registerTool(
      'search_by_tags',
      {
        description: 'Search Stack Overflow questions by tags',
        inputSchema: {
          tags: z.array(z.string()).describe('Tags to search for'),
          minScore: z.number().optional().describe('Minimum score threshold'),
          includeComments: z.boolean().optional().describe('Include comments in results'),
          responseFormat: z.enum(['json', 'markdown']).optional().describe('Response format'),
          limit: z.number().optional().describe('Maximum number of results'),
        },
      },
      async (args) => {
        try {
          const input = args as SearchByTagsInput;
          if (!input.tags || input.tags.length === 0) {
            return this.createErrorResponse('Error: tags are required');
          }
          return await this.handleSearchByTags(input);
        } catch (error) {
          return this.createErrorResponse(
            error instanceof Error ? error.message : String(error)
          );
        }
      }
    );
  }

  private registerAnalyzeStackTraceTool(): void {
    this.server.registerTool(
      'analyze_stack_trace',
      {
        description: 'Analyze stack trace and find relevant solutions',
        inputSchema: {
          stackTrace: z.string().describe('Stack trace to analyze'),
          language: z.string().describe('Programming language'),
          includeComments: z.boolean().optional().describe('Include comments in results'),
          responseFormat: z.enum(['json', 'markdown']).optional().describe('Response format'),
          limit: z.number().optional().describe('Maximum number of results'),
        },
      },
      async (args) => {
        try {
          const input = args as StackTraceInput;
          if (!input.stackTrace || !input.language) {
            return this.createErrorResponse('Error: stackTrace and language are required');
          }
          return await this.handleAnalyzeStackTrace(input);
        } catch (error) {
          return this.createErrorResponse(
            error instanceof Error ? error.message : String(error)
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
        console.warn(
          `API requested backoff of ${data.backoff}s for method ${method}`
        );
      }

      // Warn if quota is running low
      if (data.quota_remaining < QUOTA_WARNING_THRESHOLD) {
        console.warn(
          `⚠️  Low API quota: ${data.quota_remaining}/${data.quota_max} remaining`
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
        console.warn(
          `Rate limit hit (429), retrying after ${backoffTime}ms...`
        );
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
    const params = this.createApiParams({
      site: 'stackoverflow',
      sort: 'votes',
      order: 'desc',
      filter: DEFAULT_FILTER,
      q: query,
      ...(tags && { tagged: tags.join(';') }),
      ...(options.limit && { pagesize: options.limit.toString() }),
    });

    try {
      const data = await this.withRateLimit<StackOverflowQuestion>(
        () => fetch(`${STACKOVERFLOW_API}/search/advanced?${params}`),
        'search/advanced'
      );

      return this.processSearchResults(data.items, options);
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

      results.push({
        question,
        answers,
        ...(options.includeComments && { comments }),
      });
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
    args: SearchByErrorInput
  ): Promise<{ content: TextContent[] }> {
    const tags = [
      ...(args.language ? [args.language.toLowerCase()] : []),
      ...(args.technologies || []),
    ];

    const results = await this.searchStackOverflow(
      args.errorMessage,
      tags.length > 0 ? tags : undefined,
      {
        minScore: args.minScore,
        limit: args.limit,
        includeComments: args.includeComments,
      }
    );

    return {
      content: [
        {
          type: 'text' as const,
          text: this.formatResponse(results, args.responseFormat),
        },
      ],
    };
  }

  /**
   * Handles search_by_tags tool requests
   */
  private async handleSearchByTags(
    args: SearchByTagsInput
  ): Promise<{ content: TextContent[] }> {
    const params = this.createApiParams({
      site: 'stackoverflow',
      sort: 'votes',
      order: 'desc',
      filter: DEFAULT_FILTER,
      tagged: args.tags.join(';'),
      ...(args.limit && { pagesize: args.limit.toString() }),
    });

    try {
      const data = await this.withRateLimit<StackOverflowQuestion>(
        () => fetch(`${STACKOVERFLOW_API}/questions?${params}`),
        'questions'
      );

      const results = await this.processSearchResults(data.items, {
        minScore: args.minScore,
        includeComments: args.includeComments,
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: this.formatResponse(results, args.responseFormat),
          },
        ],
      };
    } catch (error) {
      throw new Error(
        `Failed to search Stack Overflow: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  /**
   * Handles analyze_stack_trace tool requests
   */
  private async handleAnalyzeStackTrace(
    args: StackTraceInput
  ): Promise<{ content: TextContent[] }> {
    const errorLines = args.stackTrace.split('\n');
    const errorMessage = errorLines[0];

    const results = await this.searchStackOverflow(
      errorMessage,
      [args.language.toLowerCase()],
      {
        minScore: 0,
        limit: args.limit,
        includeComments: args.includeComments,
      }
    );

    return {
      content: [
        {
          type: 'text' as const,
          text: this.formatResponse(results, args.responseFormat),
        },
      ],
    };
  }

  // ========================================================================
  // Response Formatting
  // ========================================================================

  /**
   * Formats search results as JSON or Markdown
   */
  private formatResponse(
    results: SearchResult[],
    format: 'json' | 'markdown' = 'json'
  ): string {
    if (format === 'json') {
      return JSON.stringify(results, null, 2);
    }

    return results
      .map((result) => {
        let markdown = `# ${result.question.title}\n\n`;
        markdown += `**Score:** ${result.question.score} | **Answers:** ${result.question.answer_count}\n\n`;
        markdown += `## Question\n\n${result.question.body}\n\n`;

        if (result.comments?.question) {
          markdown += '### Question Comments\n\n';
          result.comments.question.forEach((comment: StackOverflowComment) => {
            markdown += `- ${comment.body} *(Score: ${comment.score})*\n`;
          });
          markdown += '\n';
        }

        markdown += '## Answers\n\n';
        result.answers.forEach((answer: StackOverflowAnswer) => {
          markdown += `### ${answer.is_accepted ? '✓ ' : ''}Answer (Score: ${
            answer.score
          })\n\n`;
          markdown += `${answer.body}\n\n`;

          if (result.comments?.answers[answer.answer_id]) {
            markdown += '#### Answer Comments\n\n';
            result.comments.answers[answer.answer_id].forEach(
              (comment: StackOverflowComment) => {
                markdown += `- ${comment.body} *(Score: ${comment.score})*\n`;
              }
            );
            markdown += '\n';
          }
        });

        markdown += `---\n\n[View on Stack Overflow](${result.question.link})\n\n`;
        return markdown;
      })
      .join('\n\n');
  }

  /**
   * Creates a standardized error response
   */
  private createErrorResponse(message: string): {
    content: TextContent[];
    isError: true;
  } {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Error: ${message}`,
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

  hasApiKey(): boolean {
    return !!this.apiKey;
  }

  /**
   * Runs the server with stdio transport (default mode)
   */
  async runStdio(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    const apiKeyStatus = this.hasApiKey()
      ? 'with API key (increased rate limits)'
      : 'without API key (standard rate limits)';
    console.error(`Stack Overflow MCP server running on stdio ${apiKeyStatus}`);
  }
}

// ============================================================================
// HTTP Transport Setup
// ============================================================================

/**
 * Sets up HTTP transport with Express server
 * @param server - The StackOverflowServer instance
 * @param port - The port number to listen on (must be defined)
 */
function setupHttpTransport(server: StackOverflowServer, port: number): void {
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  // Health check endpoint
  app.get('/health', (_req: Request, res: ExpressResponse) => {
    res.json({
      status: 'ok',
      service: 'mcp-stackoverflow',
      activeSessions: transports.size,
    });
  });

  // Main MCP endpoint (POST /mcp)
  app.post('/mcp', async (req: Request, res: ExpressResponse) => {
    try {
      const sessionId = getSessionId(req.headers);

      // Handle existing session
      if (sessionId) {
        const transport = transports.get(sessionId);
        if (transport) {
          await transport.handleRequest(req, res, req.body);
          return;
        }
        sendErrorResponse(res, 404, -32000, 'Session not found');
        return;
      }

      // No session ID - only allow initialize requests to create new sessions
      const isInitialize =
        typeof req.body === 'object' &&
        req.body !== null &&
        'method' in req.body &&
        req.body.method === 'initialize';

      if (!isInitialize) {
        sendErrorResponse(
          res,
          400,
          -32000,
          'Bad Request: No session ID provided'
        );
        return;
      }

      // Create new session for initialize request
      const newServer = new StackOverflowServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (sessionId: string) => {
          console.log(`Session initialized: ${sessionId}`);
          transports.set(sessionId, transport);
        },
      });

      newServer.getServer().server.onclose = async () => {
        const sid = transport.sessionId;
        if (sid && transports.has(sid)) {
          console.log(`Session closed: ${sid}`);
          transports.delete(sid);
        }
      };

      await newServer.getServer().connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error('Error handling MCP request:', errorMessage);
      if (!res.headersSent) {
        sendErrorResponse(res, 500, -32603, 'Internal server error');
      }
    }
  });

  app.listen(port, '0.0.0.0', () => {
    const apiKeyStatus = server.hasApiKey()
      ? 'with API key (increased rate limits)'
      : 'without API key (standard rate limits)';
    console.log(
      `Stack Overflow MCP server running on port ${port} ${apiKeyStatus}`
    );
  });
}

// ============================================================================
// Main Entry Point
// ============================================================================

/**
 * Main entry point - initializes server and selects transport mode
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

main().catch(console.error);
