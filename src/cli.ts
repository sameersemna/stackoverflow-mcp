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
import { StackOverflowServer } from './server.js';
import { setupHttpTransport } from './transports/http.js';
import { VERSION } from './version.js';
import { PORT, USE_HTTP_TRANSPORT } from './config.js';

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
