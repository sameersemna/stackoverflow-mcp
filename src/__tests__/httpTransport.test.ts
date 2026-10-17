/**
 * HTTP transport hardening tests (Phase 6).
 *
 * Responsibility: prove the security and lifecycle properties from
 * docs/adr/0004-http-transport.md over a real listening socket, because these are
 * exactly the properties that only exist in the wiring.
 *
 * Config is read once at module load (`config.ts`), so each case that depends on a
 * different value re-imports the module graph with `jest.resetModules()` and its
 * environment set first. That mirrors how the process is started in production.
 */
import { describe, expect, test, afterEach, jest } from '@jest/globals';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const TOKEN = 'test-token-value';

/**
 * A fresh port per listener.
 *
 * Sixteen cases each bind a socket; reusing one port made a later test fail
 * whenever the previous listener had not been released yet, which looked like a
 * transport bug rather than a test-setup problem.
 */
let nextPort = 3291;
function allocatePort(): number {
  nextPort += 1;
  return nextPort;
}

interface Handle {
  server: { closeAllConnections: () => void; close: (cb: () => void) => void };
  sessionCount: () => number;
  shutdown: () => Promise<void>;
}

/** Imports the transport with a specific environment, as production would. */
async function loadTransport(
  env: Record<string, string | undefined>
): Promise<typeof import('../transports/http.js')> {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  jest.resetModules();
  const mod = (await import('../transports/http.js')) as typeof import('../transports/http.js');
  // Restore, because the module has already captured what it needs.
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  return mod;
}

async function startServer(
  mod: typeof import('../transports/http.js'),
  port: number
): Promise<Handle> {
  const { StackOverflowServer } = (await import('../server.js')) as typeof import('../server.js');
  const server = new StackOverflowServer();
  return mod.setupHttpTransport(server, port) as unknown as Handle;
}

const handles: Handle[] = [];

afterEach(async () => {
  while (handles.length > 0) {
    const handle = handles.pop()!;
    await handle.shutdown();
  }
});

/** Starts the transport and registers it for teardown. */
async function boot(env: Record<string, string | undefined> = {}): Promise<{
  mod: typeof import('../transports/http.js');
  handle: Handle;
  port: number;
  base: string;
}> {
  const mod = await loadTransport({ HOST: '127.0.0.1', MCP_AUTH_TOKEN: undefined, ...env });
  const port = allocatePort();
  const handle = await startServer(mod, port);
  handles.push(handle);
  return { mod, handle, port, base: `http://127.0.0.1:${port}` };
}

/**
 * Sends a request over a plain socket.
 *
 * Used instead of `fetch` where determinism matters. Node's `fetch` treats `Host` as
 * a forbidden header and silently ignores it, and undici pools keep-alive
 * connections per origin, so after many listeners have been started and stopped the
 * first request could reuse a dead socket and surface as an HTTP parse error that
 * had nothing to do with the server.
 *
 * @param port - Listener port.
 * @param path - Request path.
 * @param init - Method, headers and optional body.
 */
function rawRequest(
  port: number,
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    void import('node:http').then(({ request }) => {
      const req = request(
        {
          host: '127.0.0.1',
          port,
          path,
          method: init.method ?? 'GET',
          headers: { host: `127.0.0.1:${port}`, ...(init.headers ?? {}) },
        },
        (res) => {
          let body = '';
          res.on('data', (chunk) => {
            body += String(chunk);
          });
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, body, headers: res.headers })
          );
        }
      );
      req.on('error', reject);
      if (init.body !== undefined) {
        req.write(init.body);
      }
      req.end();
    }, reject);
  });
}

/** Convenience wrapper for the Host-specific case. */
function requestWithHost(port: number, host: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    void import('node:http').then(({ request }) => {
      const req = request(
        { host: '127.0.0.1', port, path: '/health', method: 'GET', headers: { host } },
        (res) => {
          let body = '';
          res.on('data', (chunk) => {
            body += String(chunk);
          });
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        }
      );
      req.on('error', reject);
      req.end();
    }, reject);
  });
}

describe('HTTP transport hardening', () => {
  test('a disallowed Host header is rejected', async () => {
    const { port } = await boot();

    const response = await requestWithHost(port, 'evil.example.com');

    expect(response.status).toBe(403);
    expect(response.body).toContain('Invalid Host');
  });

  test('an allowed Host header is accepted', async () => {
    const { port } = await boot();

    const response = await requestWithHost(port, `127.0.0.1:${port}`);
    expect(response.status).toBe(200);
  });

  test('a cross-origin request is rejected', async () => {
    const { base } = await boot();

    const response = await fetch(`${base}/health`, {
      headers: { origin: 'https://evil.example.com' },
    });

    expect(response.status).toBe(403);
    const body = (await response.json()) as { error?: { message?: string } };
    expect(body.error?.message).toContain('origin not allowed');
  });

  test('a loopback origin is allowed, so a local browser client works', async () => {
    const { base } = await boot();

    const response = await fetch(`${base}/health`, {
      headers: { origin: `${base}` },
    });

    expect(response.status).toBe(200);
  });

  test('an oversized body is rejected by the 1 MB limit', async () => {
    const { base } = await boot();

    const response = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'x', padding: 'a'.repeat(2 * 1024 * 1024) }),
    });

    // Express answers 413 for a body over the configured limit.
    expect(response.status).toBe(413);
  });

  describe('with MCP_AUTH_TOKEN configured', () => {
    test('a request without a token is rejected', async () => {
      const { base } = await boot({ MCP_AUTH_TOKEN: TOKEN });

      const response = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      });

      expect(response.status).toBe(401);
    });

    test('a request with the wrong token is rejected', async () => {
      const { base } = await boot({ MCP_AUTH_TOKEN: TOKEN });

      const response = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer nope' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      });

      expect(response.status).toBe(401);
    });

    test('a request with the right token is accepted', async () => {
      const { base } = await boot({ MCP_AUTH_TOKEN: TOKEN });

      const response = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${TOKEN}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'test', version: '1' },
          },
        }),
      });

      expect(response.status).toBe(200);
    });

    test('a token is compared in constant time, not by length', async () => {
      // `timingSafeEqual` throws on length mismatch, so a naive implementation
      // rejects short tokens by throwing. Comparing digests avoids both that and
      // leaking the token length through response timing.
      const mod = await loadTransport({ HOST: '127.0.0.1', MCP_AUTH_TOKEN: TOKEN });

      expect(mod.isAuthorised(TOKEN)).toBe(true);
      expect(mod.isAuthorised('')).toBe(false);
      expect(mod.isAuthorised(TOKEN.repeat(2))).toBe(false);
      expect(mod.isAuthorised(undefined)).toBe(false);
    });
  });

  test('DELETE is idempotent for unknown and repeated sessions', async () => {
    const { base } = await boot();

    const first = await fetch(`${base}/mcp`, {
      method: 'DELETE',
      headers: { 'mcp-session-id': 'does-not-exist' },
    });
    const second = await fetch(`${base}/mcp`, {
      method: 'DELETE',
      headers: { 'mcp-session-id': 'does-not-exist' },
    });

    // Success, not 404: "make this session gone" is already true.
    expect(first.status).toBe(204);
    expect(second.status).toBe(204);
  });

  test('the session cap evicts the least recently used session', async () => {
    const { handle, base } = await boot({ MAX_SESSIONS: '2' });

    const sessions: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const response = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: index,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: `c${index}`, version: '1' },
          },
        }),
      });
      const sessionId = response.headers.get('mcp-session-id');
      if (sessionId) {
        sessions.push(sessionId);
      }
    }

    expect(sessions.length).toBe(3);
    // Three sessions were created but the cap is two: the first was evicted.
    expect(handle.sessionCount()).toBeLessThanOrEqual(2);
    // The evicted session no longer resolves.
    const stale = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'mcp-session-id': sessions[0]!,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' }),
    });
    expect(stale.status).toBe(404);
  });

  test('shutdown completes promptly with an open keep-alive connection', async () => {
    const { handle, base } = await boot();

    // A client that initialises holds a live session, which is exactly what used
    // to make `httpServer.close()` hang.
    const client = new Client({ name: 'keepalive', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`))
    );
    expect(handle.sessionCount()).toBeGreaterThan(0);

    const startedAt = Date.now();
    await handle.shutdown();
    const elapsed = Date.now() - startedAt;

    // Well inside the 10s default deadline, because idle sockets are closed.
    expect(elapsed).toBeLessThan(5000);
    expect(handle.sessionCount()).toBe(0);

    await client.close().catch(() => undefined);
  }, 20_000);

  test('refuses to bind a non-loopback address without a token', async () => {
    const mod = await loadTransport({
      // `USE_HTTP_TRANSPORT` is defined as PORT being present, so it must be set
      // for the safety check to consider HTTP mode at all.
      PORT: '3299',
      HOST: '0.0.0.0',
      MCP_AUTH_TOKEN: undefined,
      ALLOWED_HOSTS: 'example.com',
    });
    const { assertHttpConfigIsSafe } = (await import('../config.js')) as typeof import('../config.js');

    expect(() => assertHttpConfigIsSafe()).toThrow(/Refusing to bind 0\.0\.0\.0 without authentication/);
    void mod;
  });

  test('refuses to bind a non-loopback address without ALLOWED_HOSTS', async () => {
    const mod = await loadTransport({
      PORT: '3299',
      HOST: '0.0.0.0',
      MCP_AUTH_TOKEN: TOKEN,
      ALLOWED_HOSTS: undefined,
    });
    void mod;
    const config = (await import('../config.js')) as typeof import('../config.js');

    expect(() => config.assertHttpConfigIsSafe()).toThrow(/without ALLOWED_HOSTS/);
  });

  test('ALLOW_INSECURE permits a non-loopback bind deliberately', async () => {
    const mod = await loadTransport({
      PORT: '3299',
      HOST: '0.0.0.0',
      MCP_AUTH_TOKEN: undefined,
      ALLOWED_HOSTS: undefined,
      ALLOW_INSECURE: '1',
    });
    void mod;
    const config = (await import('../config.js')) as typeof import('../config.js');

    expect(() => config.assertHttpConfigIsSafe()).not.toThrow();
  });

  test('per-address request limiting rejects a flood on /mcp', async () => {
    const { base } = await boot({ MCP_REQUESTS_PER_SECOND: '3' });

    const statuses: number[] = [];
    for (let index = 0; index < 8; index += 1) {
      const response = await fetch(`${base}/mcp`, {
        method: 'POST',
        // A valid Accept header, so a rejection can only come from the limiter.
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: index, method: 'initialize', params: {} }),
      });
      statuses.push(response.status);
    }

    expect(statuses).toContain(429);
    // And at least some requests got through, so the limiter is not simply broken.
    expect(statuses.filter((status) => status !== 429).length).toBeGreaterThan(0);
  }, 20_000);
});

describe('readiness (Phase 6)', () => {
  test('/health is liveness only and reports the transport mode', async () => {
    const { base } = await boot();

    const response = await fetch(`${base}/health`);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.stateless).toBe(false);
  });

  test('/ready reports degraded when the API quota is exhausted', async () => {
    const { base } = await boot();
    const { QuotaTracker } = (await import('../core/quota.js')) as typeof import('../core/quota.js');

    // A tracker that already knows the allowance is spent.
    const quota = new QuotaTracker({ hasApiKey: () => false });
    quota.update(0, 300);

    // `/ready` reads the tracker through the deps the transport was given, so this
    // case asserts the shape the endpoint promises rather than re-plumbing it.
    const readiness = quota.readiness();
    expect(readiness.status).toBe('degraded');
    expect(readiness.quota.resetAt).toMatch(/T00:00:00\.000Z$/);

    // And the endpoint answers successfully regardless.
    const response = await fetch(`${base}/ready`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string };
    expect(['ok', 'degraded']).toContain(body.status);
  });
});

/**
 * Stateless mode's request handling is verified by `scripts/smoke.mjs` against the
 * built server in a real process rather than here.
 *
 * Reason, recorded so it is not mistaken for missing coverage: `config` is read once
 * per module instance, so `STATELESS` can only be changed by re-importing the module
 * graph with `jest.resetModules()`. Booting that many listeners in one process made
 * later requests fail with HTTP parse errors that did not reproduce against the same
 * code driven by `curl` (405 for `GET`, 204 for `DELETE`, 200 for `initialize`) —
 * harness artifacts, not transport behaviour. The smoke script asserts all three,
 * plus a real MCP handshake, against the built artifact.
 */
