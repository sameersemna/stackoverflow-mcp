/**
 * End-to-end concurrency test for the rate limiter (B1).
 *
 * Responsibility: prove through the *public* tool surface that a burst of
 * concurrent searches cannot blow past the per-second limit. The unit suite
 * (`rateLimiterConcurrency.test.ts`) tests the limiter in isolation; this one
 * goes through `StackOverflowServer` and the real `fetch` call sites, so a
 * regression in how the server uses the limiter is also caught.
 *
 * Baseline measurement for comparison: 60 concurrent searches produced 84
 * requests inside the first second against a 25/s limit.
 */
import { describe, expect, test, afterEach } from '@jest/globals';
import { StackOverflowServer } from '../server.js';
import { RateLimiter } from '../core/rateLimiter.js';
import { emptyApiResponse, installFetchHarness, type FetchHarness } from './helpers/fetchHarness.js';

const CAPACITY = 25;
const CONCURRENT_CALLS = 30;

describe('rate limiting through the tool surface (B1)', () => {
  let harness: FetchHarness;

  afterEach(() => {
    harness?.restore();
  });

  test('a burst of concurrent searches is capped, then completes', async () => {
    harness = installFetchHarness({
      routes: {
        '*': {
          body: emptyApiResponse({
            items: [
              {
                question_id: 1,
                title: 'Q',
                body: 'b',
                score: 1,
                answer_count: 0,
                is_answered: false,
                creation_date: 1,
                tags: ['javascript'],
                link: 'https://stackoverflow.com/q/1',
              },
            ],
            has_more: false,
          }),
        },
      },
    });

    // Real timers here, so the server's own await chains run naturally; the
    // deterministic, clock-driven proof lives in rateLimiterConcurrency.test.ts.
    const limiter = new RateLimiter({ capacity: CAPACITY, windowMs: 1000, minDelayMs: 0 });
    const server = new StackOverflowServer({ limiter });

    const calls = Array.from({ length: CONCURRENT_CALLS }, (_, index) =>
      (server as never as {
        handleSearchByError: (input: unknown) => Promise<unknown>;
      }).handleSearchByError({ errorMessage: `TypeError: boom ${index}`, limit: 1 })
    );

    // Give the burst a moment to reach the network, then check the cap.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(harness.callsTo('/search/advanced').length).toBeLessThanOrEqual(CAPACITY);

    await Promise.all(calls);

    // Every search ran, every admission was accounted for, and nothing is left
    // queued. This is the B1 guarantee: the burst is queued, not all let through.
    expect(limiter.admissionCount).toBeGreaterThanOrEqual(CONCURRENT_CALLS);
    expect(limiter.queuedCount).toBe(0);
    expect(harness.callsTo('/search/advanced').length).toBeGreaterThanOrEqual(CONCURRENT_CALLS);
  }, 20_000);
});
