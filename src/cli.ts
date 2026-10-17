#!/usr/bin/env node
/**
 * Stack Overflow MCP Server — entry point.
 *
 * Responsibility: process-level concerns only. Suppresses one benign transitive
 * deprecation warning, reads configuration from the environment, selects the
 * transport (stdio by default, HTTP when `PORT` is set), wires signal handling
 * and starts the server. Contains no business logic, so importing any other
 * module never has the side effect of starting a server or exiting the process.
 */

// Suppress DEP0169 url.parse() deprecation warning emitted by transitive deps
// (e.g. parseurl used by express). This is a harmless warning with no CVE.
const __origEmitWarning = process.emitWarning;
process.emitWarning = ((msg: string | Error, ...args: unknown[]) => {
  if (typeof msg === 'string' && msg.includes('url.parse()')) return;
  return __origEmitWarning.apply(process, [msg, ...args] as Parameters<typeof process.emitWarning>);
}) as typeof process.emitWarning;

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { randomUUID } from 'node:crypto';
import express, { type Request, type Response as ExpressResponse } from 'express';
import { logger } from './utils/logger.js';
import { StackOverflowServer } from './server.js';
import { VERSION } from './version.js';
import { PORT, USE_HTTP_TRANSPORT } from './config.js';

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
      version: VERSION,
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

  // `USE_HTTP_TRANSPORT` and `PORT` move together: the former is defined as the
  // latter being present, so this branch is exhaustive by construction.
  if (USE_HTTP_TRANSPORT && PORT !== undefined) {
    setupHttpTransport(server, PORT);
  } else {
    await server.runStdio();
  }
}

main().catch((error) => {
  logger.error({ error }, 'Fatal error');
  process.exit(1);
});
