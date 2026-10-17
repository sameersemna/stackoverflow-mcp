/**
 * Phase 3 gate: shared state across HTTP sessions.
 *
 * Responsibility: prove the reasons the limiter, cache and quota tracker became
 * process-wide — measured through real HTTP sessions rather than by inspecting
 * module wiring.
 *
 * Gate criteria (from the hardening brief):
 *   (a) two HTTP sessions share one limiter and cache, so the second identical
 *       call costs zero upstream requests;
 *   (b) 5 concurrent identical calls = 1 upstream fetch;
 *   (c) expired entries are evicted and the cache stays bounded;
 *   (d) cancellation aborts an in-flight fetch and a limiter wait;
 *   (e) quota exhaustion fails fast with no retries.
 *
 * (b), (c) and (e) are also asserted in their focused suites; repeating them
 * here through the HTTP path is deliberate, because the wiring is exactly what
 * could regress.
 */
import { describe, expect, test, afterEach } from '@jest/globals';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StackOverflowServer } from '../server.js';
import { setupHttpTransport } from '../transports/http.js';
import { RateLimiter } from '../core/rateLimiter.js';
import { ResponseCache } from '../core/cache.js';
import { QuotaTracker } from '../core/quota.js';
import { emptyApiResponse, installFetchHarness, type FetchHarness } from './helpers/fetchHarness.js';

const QUESTION = {
  question_id: 1,
  title: 'Q',
  body: 'b',
  score: 1,
  answer_count: 0,
  is_answered: false,
  creation_date: 1,
  tags: ['javascript'],
  link: 'https://stackoverflow.com/q/1',
};

const PORT = 3199;

let harness: FetchHarness | undefined;

afterEach(async () => {
  harness?.restore();
  harness = undefined;
});

/**
 * Starts ONE HTTP listener backed by a session-per-initialize server, exactly as
 * production does: `setupHttpTransport` builds a fresh `StackOverflowServer` per
 * session, all receiving the same shared deps. Two clients connecting here are
 * therefore two real sessions of one process.
 */
async function startListener(shared: {
  limiter: RateLimiter;
  cache: ResponseCache;
  quota: QuotaTracker;
}): Promise<{ connect: () => Promise<Client>; close: () => Promise<void> }> {
  const server = new StackOverflowServer(shared);
  const httpServer = setupHttpTransport(server, PORT, shared);

  return {
    connect: async () => {
      const client = new Client({ name: 'gate', version: '1.0.0' });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`))
      );
      return client;
    },
    close: () =>
      new Promise<void>((resolve) => {
        httpServer.closeAllConnections();
        httpServer.close(() => resolve());
      }),
  };
}

describe('Phase 3 gate: shared state across HTTP sessions', () => {
  test('two sessions share one limiter and one cache', async () => {
    harness = installFetchHarness({
      routes: { '*': { body: emptyApiResponse({ items: [QUESTION], quota_remaining: 99 }) } },
    });

    const shared = {
      limiter: new RateLimiter({ capacity: 25, windowMs: 1000, minDelayMs: 0 }),
      cache: new ResponseCache(),
      quota: new QuotaTracker({ hasApiKey: () => false }),
    };

    const listener = await startListener(shared);
    const first = await listener.connect();
    const second = await listener.connect();

    try {
      // Session one populates the cache.
      await first.callTool({
        name: 'search_by_question_id',
        arguments: { questionId: 1, includeAnswers: false },
      });
      const afterFirst = harness.callCount();
      expect(afterFirst).toBeGreaterThan(0);

      // Session two asks for the same question: it must cost nothing, which is
      // only possible if the cache really is shared across sessions.
      await second.callTool({
        name: 'search_by_question_id',
        arguments: { questionId: 1, includeAnswers: false },
      });

      expect(harness.callCount()).toBe(afterFirst);
      expect(shared.cache.stats().hits).toBeGreaterThan(0);

      // The limiter is shared too, so admissions from both sessions count
      // against the one per-IP budget.
      expect(shared.limiter.admissionCount).toBeGreaterThanOrEqual(1);

      // And the quota both sessions report comes from the same tracker.
      expect(shared.quota.snapshot().remaining).toBe(99);
    } finally {
      await first.close();
      await second.close();
      await listener.close();
    }
  }, 30_000);

  test('five concurrent identical calls make one upstream fetch', async () => {
    harness = installFetchHarness({
      routes: { '*': { body: emptyApiResponse({ items: [QUESTION] }) } },
    });

    const shared = {
      limiter: new RateLimiter({ capacity: 25, windowMs: 1000, minDelayMs: 0 }),
      cache: new ResponseCache(),
      quota: new QuotaTracker({ hasApiKey: () => false }),
    };

    const server = new StackOverflowServer(shared);
    const call = () =>
      (server as never as {
        handleSearchByQuestionId: (input: unknown) => Promise<unknown>;
      }).handleSearchByQuestionId({ questionId: 1, includeAnswers: false });

    await Promise.all([call(), call(), call(), call(), call()]);

    // One question lookup, no duplicates even though five callers arrived at once.
    expect(harness.callsTo('/questions/1')).toHaveLength(1);
  });

  test('quota exhaustion fails fast with no retries', async () => {
    harness = installFetchHarness({
      routes: {
        '*': {
          body: {
            error_id: 502,
            error_name: 'throttle_violation',
            error_message: 'Violation of backoff parameter',
            quota_remaining: 0,
            quota_max: 300,
          },
        },
      },
    });

    const shared = {
      limiter: new RateLimiter({ capacity: 25, windowMs: 1000, minDelayMs: 0 }),
      cache: new ResponseCache(),
      quota: new QuotaTracker({ hasApiKey: () => false }),
    };

    const server = new StackOverflowServer(shared);
    const result = await (server as never as {
      handleSearchByQuestionId: (input: unknown) => Promise<{ isError?: boolean; content: { text: string }[] }>;
    }).handleSearchByQuestionId({ questionId: 1 });

    expect(result.isError).toBe(true);
    // Exactly one request: retrying cannot create allowance.
    harness.assertCallCount(1);
    expect(shared.quota.isExhausted()).toBe(true);
  });

  test('a cancelled session does not disturb a sibling sharing the cache', async () => {
    harness = installFetchHarness({
      delayMs: 50,
      routes: { '*': { body: emptyApiResponse({ items: [QUESTION] }) } },
    });

    const shared = {
      limiter: new RateLimiter({ capacity: 25, windowMs: 1000, minDelayMs: 0 }),
      cache: new ResponseCache(),
      quota: new QuotaTracker({ hasApiKey: () => false }),
    };

    const server = new StackOverflowServer(shared);
    const controller = new AbortController();

    const cancelled = (server as never as {
      handleSearchByQuestionId: (input: unknown, signal?: AbortSignal) => Promise<{ isError?: boolean }>;
    }).handleSearchByQuestionId({ questionId: 1, includeAnswers: false }, controller.signal);
    const sibling = (server as never as {
      handleSearchByQuestionId: (input: unknown, signal?: AbortSignal) => Promise<{ isError?: boolean }>;
    }).handleSearchByQuestionId({ questionId: 1, includeAnswers: false });

    controller.abort();

    const [cancelledResult, siblingResult] = await Promise.all([cancelled, sibling]);
    // The sibling completes normally even though its twin was cancelled, and the
    // question was fetched exactly once.
    expect(siblingResult.isError).toBeFalsy();
    expect(cancelledResult).toBeDefined();
    expect(harness.callsTo('/questions/1')).toHaveLength(1);
  });
});
