#!/usr/bin/env node
/**
 * Legacy executable entry point.
 *
 * Responsibility: preserve `node build/index.js` as a working stdio entry point
 * for the currently deployed systemd unit, `run.sh`, the Dockerfile and any
 * saved MCP client configuration. It only delegates to `cli.ts`, which owns all
 * process-level concerns.
 *
 * Tests and libraries must not import this module (it starts a transport).
 * Import `./server.js` for the pure, side-effect-free server implementation.
 */
import './cli.js';
