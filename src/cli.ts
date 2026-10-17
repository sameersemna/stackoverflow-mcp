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

import { logger } from './utils/logger.js';
import { StackOverflowServer, type ServerDeps } from './server.js';
import { setupHttpTransport } from './transports/http.js';
import { VERSION } from './version.js';
import {
  MIN_DELAY_BETWEEN_REQUESTS_MS,
  MAX_REQUESTS_PER_SECOND,
  PORT,
  RATE_LIMIT_WINDOW_MS,
  USE_HTTP_TRANSPORT,
} from './config.js';
import { RateLimiter } from './core/rateLimiter.js';
import { ResponseCache } from './core/cache.js';
import { QuotaTracker } from './core/quota.js';

/**
 * Shared collaborators for the whole process.
 *
 * Stack Exchange throttles per IP, so the rate limiter is a property of the
 * process, not of a session: without sharing, N HTTP sessions each send up to
 * capacity requests/second from the same address and get throttled sooner. The
 * cache and quota tracker are shared for the same reason — one allowance, one
 * budget, and no reason to fetch the same question twice
 * (see docs/adr/0002-shared-state.md).
 *
 * Rate limiting is disabled in stdio mode: that mode serves a single local
 * client, so there is no cross-session multiplication to defend against.
 */
function buildDeps(): ServerDeps {
  const quota = new QuotaTracker({
    hasApiKey: () => Boolean(process.env.STACKOVERFLOW_API_KEY),
  });

  if (!USE_HTTP_TRANSPORT) {
    return { cache: new ResponseCache(), quota };
  }

  return {
    limiter: new RateLimiter({
      capacity: MAX_REQUESTS_PER_SECOND,
      windowMs: RATE_LIMIT_WINDOW_MS,
      minDelayMs: MIN_DELAY_BETWEEN_REQUESTS_MS,
    }),
    cache: new ResponseCache(),
    quota,
  };
}

/**
 * Main entry point - initializes server and selects transport mode.
 * Automatically uses HTTP transport if PORT environment variable is set,
 * otherwise falls back to stdio transport.
 */
async function main(): Promise<void> {
  const deps = buildDeps();
  const server = new StackOverflowServer(deps);

  // Release memory from expired cache entries without waiting for a lookup on
  // the same key; `unref` keeps this from holding the process open.
  const sweeper = setInterval(
    () => {
      deps.cache?.prune();
    },
    5 * 60 * 1000
  );
  sweeper.unref();

  // `USE_HTTP_TRANSPORT` and `PORT` move together: the former is defined as the
  // latter being present, so this branch is exhaustive by construction.
  if (USE_HTTP_TRANSPORT && PORT !== undefined) {
    setupHttpTransport(server, PORT, deps);
  } else {
    await server.runStdio();
  }
}

main().catch((error) => {
  logger.error({ error }, 'Fatal error');
  process.exit(1);
});
