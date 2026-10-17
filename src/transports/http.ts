/**
 * Streamable HTTP transport.
 *
 * Responsibility: own the Express application, session lifecycle and graceful
 * shutdown for HTTP mode. The hardening here is described in
 * docs/adr/0004-http-transport.md; the short version is that exposure is now a
 * deliberate act rather than the default:
 *
 * - binds loopback unless `HOST` says otherwise
 * - validates `Host` (DNS-rebinding) and rejects cross-origin `Origin` headers
 * - requires a bearer token when not bound to loopback
 * - 1 MB body limit instead of 10 MB
 * - sessions are capped (LRU) and expire when idle
 * - `DELETE /mcp` is idempotent
 * - per-address request limiting on `/mcp` (excess is rejected with 429, not queued)
 * - shutdown drains sessions and honours a deadline
 *
 * Signal handling deliberately lives in `cli.ts`: registering `SIGTERM`/`SIGINT`
 * from a function that tests call repeatedly leaked listeners.
 */
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { randomUUID } from 'node:crypto';
import express, {
  type NextFunction,
  type Request,
  type Response as ExpressResponse,
} from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Server } from 'node:http';
import { logger } from '../utils/logger.js';
import { RateLimiter } from '../core/rateLimiter.js';
import { VERSION } from '../version.js';
import { StackOverflowServer, type ServerDeps } from '../server.js';
import {
  ALLOWED_HOSTS,
  ALLOWED_ORIGINS,
  HOST,
  MAX_SESSIONS,
  MCP_AUTH_TOKEN,
  MCP_REQUESTS_PER_SECOND,
  SESSION_IDLE_TTL_MS,
  SHUTDOWN_TIMEOUT_MS,
  STATELESS,
  isLoopbackHost,
} from '../config.js';

// Session management for HTTP transport (one transport per MCP session)
export const transports = new Map<string, SessionEntry>();

/**
 * Removes a session and closes its transport.
 *
 * @param sessionId - Session to drop.
 * @param reason - Why it is being dropped, for the log record.
 * @returns True when a session was present.
 */
function dropSession(sessionId: string, reason: string): boolean {
  const entry = transports.get(sessionId);
  if (!entry) {
    return false;
  }
  transports.delete(sessionId);
  void entry.transport.close().catch(() => {
    // Closing an already-closed transport is not interesting.
  });
  logger.info({ sessionId, reason, totalSessions: transports.size }, 'Session closed');
  return true;
}

/**
 * Closes idle sessions.
 *
 * Without this a client that retries `initialize` after a network blip left the
 * abandoned session alive forever.
 *
 * @param idleTtlMs - How long a session may go unused.
 * @returns Number of sessions closed.
 */
function reapIdleSessions(idleTtlMs: number): number {
  const cutoff = Date.now() - idleTtlMs;
  let closed = 0;
  for (const [sessionId, entry] of transports) {
    if (entry.lastActivity < cutoff) {
      dropSession(sessionId, 'idle timeout');
      closed += 1;
    }
  }
  return closed;
}

/** Marks a session as recently used, for LRU eviction and idle expiry. */
function touchSession(sessionId: string): void {
  const entry = transports.get(sessionId);
  if (entry) {
    entry.lastActivity = Date.now();
  }
}

/**
 * Enforces the session cap by evicting the least recently used session.
 *
 * Evicting is friendlier than refusing the new `initialize`: the client that just
 * connected gets a working session, and the one that has been quiet longest is the
 * cheapest to lose.
 */
function enforceSessionCap(maxSessions: number): void {
  while (transports.size > maxSessions) {
    let oldestId: string | undefined;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [sessionId, entry] of transports) {
      if (entry.lastActivity < oldestAt) {
        oldestAt = entry.lastActivity;
        oldestId = sessionId;
      }
    }
    if (oldestId === undefined) {
      return;
    }
    dropSession(oldestId, 'session cap reached');
  }
}

/**
 * Per-address request limiter for `/mcp`.
 *
 * Reuses the tested `RateLimiter` rather than adding a dependency: it already
 * provides a sliding window, FIFO fairness and an injected clock, and is keyed by
 * address here.
 */
function createAddressLimiter(): {
  allow: (address: string) => boolean;
  buckets: Map<string, RateLimiter>;
} {
  const buckets = new Map<string, RateLimiter>();
  return {
    buckets,
    allow: (address: string): boolean => {
      let limiter = buckets.get(address);
      if (!limiter) {
        limiter = new RateLimiter({
          capacity: MCP_REQUESTS_PER_SECOND,
          windowMs: 1000,
          minDelayMs: 0,
        });
        buckets.set(address, limiter);
      }
      // Deliberately non-blocking: queueing a flood would hold sockets and memory
      // and answer every client slowly. Rejecting with 429 bounds the damage and
      // tells the client to back off.
      return limiter.tryAcquire('mcp');
    },
  };
}

/**
 * Shuts the listener down within a deadline.
 *
 * `httpServer.close()` alone waits for keep-alive connections to finish on their
 * own, which can hang indefinitely. This stops accepting connections, closes
 * sessions, tells idle sockets to go away, and forces the rest after
 * `SHUTDOWN_TIMEOUT_MS`.
 *
 * @param httpServer - The listener to close.
 */
async function shutdown(httpServer: Server): Promise<void> {
  logger.info({ openSessions: transports.size }, 'Shutting down HTTP transport');

  for (const sessionId of [...transports.keys()]) {
    dropSession(sessionId, 'server shutdown');
  }

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve();
      }
    };

    const timer = setTimeout(() => {
      logger.warn({ timeoutMs: SHUTDOWN_TIMEOUT_MS }, 'Shutdown deadline reached; forcing close');
      httpServer.closeAllConnections();
      finish();
    }, SHUTDOWN_TIMEOUT_MS);
    timer.unref();

    httpServer.close(() => finish());
    // Ask idle keep-alive sockets to close so `close()` can complete promptly.
    httpServer.closeIdleConnections();
  });
}

/**
 * Extracts MCP session ID from HTTP request headers
 */
export function getSessionId(
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
export function sendErrorResponse(
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


/** A session and when it was last used, for LRU eviction and idle expiry. */
interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  lastActivity: number;
}

/**
 * Compares a presented bearer token against the configured one.
 *
 * Both sides are hashed first so the comparison is over equal-length buffers —
 * `timingSafeEqual` throws on length mismatch, and comparing lengths directly
 * would leak the token length. Hashing keeps the comparison constant-time with
 * respect to content.
 *
 * @param presented - The token from the request, or `undefined`.
 * @returns True when a token is configured and matches.
 */
export function isAuthorised(presented: string | undefined): boolean {
  if (!MCP_AUTH_TOKEN) {
    return true;
  }
  if (!presented) {
    return false;
  }
  const expected = createHash('sha256').update(MCP_AUTH_TOKEN).digest();
  const actual = createHash('sha256').update(presented).digest();
  return timingSafeEqual(expected, actual);
}

/** Extracts a bearer token from the `Authorization` header. */
function bearerToken(headers: Request['headers']): string | undefined {
  const header = headers.authorization;
  if (typeof header !== 'string') {
    return undefined;
  }
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1];
}

/**
 * Hostnames permitted in the `Host` header.
 *
 * Explicit configuration wins; otherwise loopback binding permits only loopback
 * names. Returning `undefined` means "not restricted", which is only reachable
 * when bound to a non-loopback address, which `assertHttpConfigIsSafe` refuses
 * unless `ALLOW_INSECURE=1`.
 */
function permittedHosts(): string[] | undefined {
  if (ALLOWED_HOSTS) {
    return ALLOWED_HOSTS;
  }
  if (isLoopbackHost(HOST)) {
    return ['localhost', '127.0.0.1', '[::1]', '::1'];
  }
  return undefined;
}

/**
 * Rejects cross-origin browser requests.
 *
 * Non-browser MCP clients do not send `Origin`, so requiring a loopback origin
 * when one is present blocks exactly the DNS-rebinding case worth blocking
 * without needing an allow-list.
 */
function originMiddleware(): (req: Request, res: ExpressResponse, next: NextFunction) => void {
  const allowed = new Set(ALLOWED_ORIGINS ?? []);
  const allowLoopback = ALLOWED_ORIGINS === undefined;

  return (req, res, next) => {
    const origin = req.headers.origin;
    if (typeof origin !== 'string' || origin.length === 0) {
      next();
      return;
    }
    if (allowed.has(origin)) {
      next();
      return;
    }
    if (allowLoopback) {
      try {
        const hostname = new URL(origin).hostname;
        if (isLoopbackHost(hostname)) {
          next();
          return;
        }
      } catch {
        // A malformed Origin is treated as untrusted below.
      }
    }
    logger.warn({ origin }, 'Rejected cross-origin request');
    sendErrorResponse(res, 403, -32000, 'Forbidden: origin not allowed');
  };
}

/** Rejects requests without a valid bearer token when one is configured. */
function authMiddleware(): (req: Request, res: ExpressResponse, next: NextFunction) => void {
  return (req, res, next) => {
    if (isAuthorised(bearerToken(req.headers))) {
      next();
      return;
    }
    logger.warn({ path: req.path }, 'Rejected request without a valid token');
    sendErrorResponse(res, 401, -32000, 'Unauthorized: a valid bearer token is required');
  };
}

/**
 * Express middleware that validates the `Host` header.
 *
 * Implemented locally rather than using the SDK's `hostHeaderValidation` because
 * that helper returns its own response shape; this keeps the JSON-RPC error shape
 * consistent with the rest of the transport while applying the same check.
 */
function hostValidationMiddleware(
  hosts: string[]
): (req: Request, res: ExpressResponse, next: NextFunction) => void {
  const allowed = new Set(hosts.map((host) => host.toLowerCase()));
  return (req, res, next) => {
    const header = req.headers.host;
    if (typeof header !== 'string' || header.length === 0) {
      sendErrorResponse(res, 403, -32000, 'Missing Host header');
      return;
    }
    let requestHostname: string;
    try {
      requestHostname = new URL(`http://${header}`).hostname.toLowerCase();
    } catch {
      sendErrorResponse(res, 403, -32000, `Invalid Host header: ${header}`);
      return;
    }
    if (!allowed.has(requestHostname)) {
      // Named `requestHostname`, not `hostname`: pino's base fields already include
      // `hostname`, and a duplicate key silently replaces the process's own.
      logger.warn({ requestHostname }, 'Rejected request with a disallowed Host header');
      sendErrorResponse(res, 403, -32000, `Invalid Host: ${requestHostname}`);
      return;
    }
    next();
  };
}

/** Handle returned by {@link setupHttpTransport}. */
export interface HttpTransportHandle {
  /** The listening server, so callers can read its address. */
  server: Server;
  /** Live session count, for `/health` and tests. */
  sessionCount: () => number;
  /** Drains sessions and closes the listener within `SHUTDOWN_TIMEOUT_MS`. */
  shutdown: () => Promise<void>;
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
export function setupHttpTransport(
  server: StackOverflowServer,
  port: number,
  deps: ServerDeps = {}
): HttpTransportHandle {
  const app = express();
  // 1 MB is ample for MCP requests; the previous 10 MB let a single request
  // allocate ten times more than necessary.
  app.use(express.json({ limit: '1mb' }));
  app.disable('x-powered-by');

  // Reject a disallowed Host before anything else can act on the request: this is
  // the DNS-rebinding protection the MCP specification asks local servers for.
  const hosts = permittedHosts();
  if (hosts) {
    app.use(hostValidationMiddleware(hosts));
  }
  app.use(originMiddleware());

  const addressLimiter = createAddressLimiter();
  app.use('/mcp', (req: Request, res: ExpressResponse, next: NextFunction) => {
    const address = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    if (addressLimiter.allow(address)) {
      next();
      return;
    }
    logger.warn({ address }, 'Rejected request over the per-address rate limit');
    res.setHeader('retry-after', '1');
    sendErrorResponse(res, 429, -32000, 'Too many requests');
  });

  if (MCP_AUTH_TOKEN) {
    app.use('/mcp', authMiddleware());
  }

  // Liveness only: the process is up and serving.
  app.get('/health', (_req: Request, res: ExpressResponse) => {
    res.json({
      status: 'ok',
      service: 'mcp-stackoverflow',
      version: VERSION,
      activeSessions: transports.size,
      stateless: STATELESS,
    });
  });

  // Readiness includes dependencies. An exhausted quota reports `degraded` rather
  // than failing, because cached responses still work and running out at the end of
  // a UTC day is a normal state, not an outage.
  app.get('/ready', (_req: Request, res: ExpressResponse) => {
    const readiness = deps.quota?.readiness();
    res.status(200).json({
      status: readiness?.status ?? 'ok',
      service: 'mcp-stackoverflow',
      version: VERSION,
      activeSessions: transports.size,
      ...(readiness ? { quota: readiness.quota } : {}),
    });
  });

  // SSE stream endpoint (GET /mcp)
  // According to MCP specification, StreamableHTTPServerTransport.handleRequest
  // can handle both POST and GET requests, automatically processing SSE streams
  // when Accept: text/event-stream header is present.
  app.get('/mcp', async (req: Request, res: ExpressResponse) => {
    if (STATELESS) {
      // No session means no stream to attach to. The SDK documents that stateless
      // mode sends no session id and performs no session validation.
      sendErrorResponse(res, 405, -32000, 'Method Not Allowed in stateless mode');
      return;
    }

    const sessionId = getSessionId(req.headers);

    if (!sessionId) {
      sendErrorResponse(res, 400, -32000, 'Bad Request: No session ID provided');
      return;
    }

    const session = transports.get(sessionId);
    if (!session) {
      sendErrorResponse(res, 404, -32000, 'Session not found');
      return;
    }
    touchSession(sessionId);
    const transport = session.transport;

    try {
      // The third argument must be omitted for a bodyless GET. The SDK treats
      // `undefined` as "no pre-parsed body" and any other value — including
      // `null` — as the already-parsed body, so passing `null` made it validate
      // `null` as a JSON-RPC message and fail with a ZodError.
      await transport.handleRequest(req, res);
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

    if (sessionId) {
      // One status for every DELETE: 204 whether or not the session existed, so a
      // client can treat "make this session gone" as idempotent without having to
      // special-case a first vs. repeated call. Delegating to the SDK transport for
      // a known session answered 200, which made the two paths inconsistent.
      dropSession(sessionId, 'client requested');
    }

    res.status(204).end();
  });

  // Main MCP endpoint (POST /mcp)
  app.post('/mcp', async (req: Request, res: ExpressResponse) => {
    try {
      const sessionId = getSessionId(req.headers);
      const requestId = typeof req.body === 'object' && req.body !== null && 'id' in req.body ? req.body.id : null;

      // Handle existing session
      if (sessionId) {
        const session = transports.get(sessionId);
        if (session) {
          touchSession(sessionId);
          await session.transport.handleRequest(req, res, req.body);
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
      // Every session shares the process-wide limiter, cache and quota tracker
      // so that N sessions cannot multiply the per-IP request rate and can reuse
      // each other's cached responses.
      if (STATELESS) {
        // One server and transport per request, sharing the process-wide deps.
        // `sessionIdGenerator: undefined` is the SDK's documented stateless mode
        // (see streamableHttp.d.ts): no session id is sent and none is validated,
        // which suits deployment behind a proxy that load-balances requests.
        const statelessServer = new StackOverflowServer(deps);
        const statelessTransport = new StreamableHTTPServerTransport({
          // The key is omitted rather than set to `undefined`: `undefined` is not
          // assignable under `exactOptionalPropertyTypes`, and the SDK treats a
          // missing generator as stateless mode.
          enableJsonResponse: true,
        });
        const connectStateless = statelessServer.getServer().connect.bind(
          statelessServer.getServer()
        );
        await connectStateless(statelessTransport as Parameters<typeof connectStateless>[0]);

        await statelessTransport.handleRequest(req, res, req.body);

        // Release the transport after the exchange has settled, without tearing down
        // the socket. Closing it as soon as `handleRequest` resolves — or on
        // `res`'s `close` event — destroyed a keep-alive connection the client was
        // still using, and the *next* request on that pooled socket failed with
        // "Response does not match the HTTP/1.1 protocol". Deferring lets the
        // response flush and the socket return to the pool.
        const releaseTimer = setTimeout(() => {
          void statelessTransport.close().catch(() => undefined);
        }, 1000);
        releaseTimer.unref();

        return;
      }

      const newServer = new StackOverflowServer(deps);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (sessionId: string) => {
          transports.set(sessionId, { transport, lastActivity: Date.now() });
          enforceSessionCap(MAX_SESSIONS);
          logger.info({ sessionId, totalSessions: transports.size }, 'Session initialized');
        },
      });

      newServer.getServer().server.onclose = () => {
        const sid = transport.sessionId;
        if (sid) {
          dropSession(sid, 'transport closed');
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

  const httpServer = app.listen(port, HOST, () => {
    const apiKeyStatus = server.hasApiKey()
      ? 'with API key (increased rate limits)'
      : 'without API key (standard rate limits)';
    logger.info(
      {
        port,
        host: HOST,
        apiKeyStatus,
        authRequired: Boolean(MCP_AUTH_TOKEN),
        allowedHosts: ALLOWED_HOSTS ?? (isLoopbackHost(HOST) ? 'loopback only' : 'not restricted'),
      },
      'Stack Overflow MCP server started'
    );
  });

  // Close idle sessions periodically. `unref` keeps the timer from holding the
  // process open, and it is cleared on shutdown.
  const sweeper = setInterval(() => {
    const closed = reapIdleSessions(SESSION_IDLE_TTL_MS);
    if (closed > 0) {
      logger.info({ closed, totalSessions: transports.size }, 'Reaped idle sessions');
    }
  }, Math.max(1000, Math.floor(SESSION_IDLE_TTL_MS / 4)));
  sweeper.unref();

  return {
    server: httpServer,
    sessionCount: () => transports.size,
    shutdown: async () => {
      clearInterval(sweeper);
      await shutdown(httpServer);
    },
  };
}
