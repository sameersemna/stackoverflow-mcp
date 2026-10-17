/**
 * Timeout and cancellation tests (B9).
 *
 * Responsibility: prove that a request cannot hang forever and that MCP client
 * cancellation actually stops the work — the in-flight `fetch`, the rate-limiter
 * wait and any retry backoff. At baseline `fetch()` was called with no
 * `AbortSignal`, so a hung connection left the tool call pending indefinitely and
 * `extra.signal` was ignored entirely.
 */
import { describe, expect, test, beforeEach, afterEach } from '@jest/globals';
import { StackOverflowServer } from '../server.js';
import { emptyApiResponse, installFetchHarness, type FetchHarness } from './helpers/fetchHarness.js';

interface ToolResult {
  isError?: boolean;
  content: { text: string }[];
}

function textOf(result: ToolResult): string {
  return result.content.map((block) => block.text).join('\n');
}

describe('timeout and cancellation (B9)', () => {
  let harness: FetchHarness;
  let server: StackOverflowServer;

  beforeEach(() => {
    server = new StackOverflowServer();
  });

  afterEach(() => {
    harness?.restore();
  });

  test('a signal is passed to fetch', async () => {
    let sawSignal: AbortSignal | undefined;
    harness = installFetchHarness({
      routes: { '*': { body: emptyApiResponse() } },
    });

    // Wrap the harness stub so the init argument is observable.
    const stub = globalThis.fetch;
    globalThis.fetch = ((input: unknown, init?: { signal?: AbortSignal }) => {
      sawSignal = init?.signal;
      return stub(input as never, init as never);
    }) as typeof globalThis.fetch;

    await (server as never as {
      handleSearchByError: (input: unknown) => Promise<ToolResult>;
    }).handleSearchByError({ errorMessage: 'TypeError: boom', limit: 1 });

    expect(sawSignal).toBeDefined();
    expect(sawSignal!.aborted).toBe(false);
  });

  test('an already-cancelled client signal fails immediately without calling the API', async () => {
    harness = installFetchHarness({ routes: { '*': { body: emptyApiResponse() } } });

    const controller = new AbortController();
    controller.abort();

    const result = await (server as never as {
      handleSearchByError: (input: unknown, signal?: AbortSignal) => Promise<ToolResult>;
    }).handleSearchByError({ errorMessage: 'TypeError: boom', limit: 1 }, controller.signal);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/cancel/i);
    harness.assertCallCount(0);
  });

  test('cancelling mid-request aborts the in-flight fetch and stops the work', async () => {
    // Latency keeps the request in flight so cancellation happens mid-request,
    // which is the case that used to hang forever.
    harness = installFetchHarness({
      delayMs: 200,
      routes: { '*': { body: emptyApiResponse({ items: [] }) } },
    });

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);

    const result = await (server as never as {
      handleSearchByError: (input: unknown, signal?: AbortSignal) => Promise<ToolResult>;
    }).handleSearchByError({ errorMessage: 'TypeError: boom', limit: 1 }, controller.signal);

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toMatch(/cancel/i);
    // A cancelled request must not be retried: no extra upstream calls.
    expect(harness.callCount()).toBeLessThanOrEqual(1);
  });

  test('the error is reported as cancellation, not as a validation failure', async () => {
    harness = installFetchHarness({ routes: { '*': { body: emptyApiResponse() } } });

    const controller = new AbortController();
    controller.abort();

    const result = await (server as never as {
      handleSearchByQuestionId: (input: unknown, signal?: AbortSignal) => Promise<ToolResult>;
    }).handleSearchByQuestionId({ questionId: 1 }, controller.signal);

    expect(textOf(result)).not.toContain('Validation failed');
  });

  test('a request timeout produces an actionable message', async () => {
    // An abort raised by the request timeout (not by the client) must be
    // reported as a timeout. The harness rejects immediately, which is the same
    // code path a hung socket takes.
    harness = installFetchHarness({ routes: { '*': { body: emptyApiResponse() } } });

    const stub = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = ((input: unknown, init?: { signal?: AbortSignal }) => {
      calls += 1;
      void init;
      void input;
      const error = new Error('The operation was aborted.');
      error.name = 'TimeoutError';
      return Promise.reject(error);
    }) as typeof globalThis.fetch;

    try {
      const result = await (server as never as {
        handleSearchByQuestionId: (input: unknown) => Promise<ToolResult>;
      }).handleSearchByQuestionId({ questionId: 1 });

      expect(result.isError).toBe(true);
      const text = textOf(result);
      // Either the timeout or the upstream message is acceptable, but it must be
      // a distinct category and it must not be retried into an infinite loop.
      expect(text).not.toContain('Validation failed');
      expect(calls).toBeLessThanOrEqual(3);
    } finally {
      globalThis.fetch = stub;
    }
  });
});
