/**
 * Rate limiter concurrency tests (B1).
 *
 * Responsibility: prove the limiter cannot be over-admitted under concurrency.
 *
 * The B1 failure: `checkRateLimit` read the shared timestamp list, `await`ed, and
 * only then pushed its own timestamp, so with 60 concurrent callers *all 60*
 * observed "under the limit" and passed — measured at 60 admissions in 41 ms
 * against a 25/s limit. An asynchronous check-then-act cannot be made correct by
 * lowering the limit; admission has to be reserved synchronously.
 *
 * The limiter takes an injected clock, so these tests are deterministic rather
 * than dependent on real timers.
 */
import { describe, expect, test } from '@jest/globals';
import { RateLimiter } from '../core/rateLimiter.js';
import { CancelledError } from '../errors.js';
import { FakeClock } from './helpers/fakeClock.js';

function makeLimiter(clock: FakeClock, overrides: Partial<{ capacity: number; windowMs: number; minDelayMs: number }> = {}) {
  return new RateLimiter({
    capacity: overrides.capacity ?? 25,
    windowMs: overrides.windowMs ?? 1000,
    minDelayMs: overrides.minDelayMs ?? 0,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
}

/** Resolves after pending microtasks and timers of the fake clock have settled. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('rate limiter concurrency (B1)', () => {
  test('100 concurrent acquisitions admit exactly `capacity` before time advances', async () => {
    const clock = new FakeClock();
    const limiter = makeLimiter(clock, { capacity: 25 });

    let admitted = 0;
    const pending = Array.from({ length: 100 }, () =>
      limiter.acquire().then(() => {
        admitted += 1;
      })
    );
    await flush();

    // This is the B1 regression assertion: 100 callers arrive at once, and only
    // the capacity may pass without the clock moving. The old implementation let
    // every caller through because it read the timestamp list before awaiting.
    expect(admitted).toBe(25);

    await clock.advance(1000);
    expect(admitted).toBe(50);

    await clock.advance(2000);
    expect(admitted).toBe(100);

    await Promise.all(pending);
    expect(admitted).toBe(100);
  });

  test('the window accounting never exceeds `capacity`', async () => {
    const clock = new FakeClock();
    const limiter = makeLimiter(clock, { capacity: 25 });

    const startedAt = clock.now();
    const pending = Array.from({ length: 100 }, () => limiter.acquire());
    await flush();

    // Immediately after a 100-call burst, only the capacity is accounted for.
    expect(limiter.admissionsInWindow()).toBe(25);
    expect(limiter.admissionCount).toBe(25);
    expect(limiter.queuedCount).toBe(75);

    for (let step = 0; step < 6; step += 1) {
      await clock.advance(1000);
      // Never more than one window's worth inside the window, at any instant.
      expect(limiter.admissionsInWindow()).toBeLessThanOrEqual(25);
    }

    await Promise.all(pending);
    expect(limiter.admissionCount).toBe(100);
    expect(limiter.queuedCount).toBe(0);

    // 100 admissions at 25 per second need at least three further windows; this
    // is the invariant that the old implementation violated (60 admissions in
    // 41 ms, i.e. almost no virtual time consumed).
    expect(clock.now() - startedAt).toBeGreaterThanOrEqual(3000);
  });

  test('the min-delay is enforced between consecutive admissions', async () => {
    const clock = new FakeClock();
    const limiter = makeLimiter(clock, { capacity: 25, minDelayMs: 40 });

    let admitted = 0;
    const pending = Array.from({ length: 5 }, () =>
      limiter.acquire().then(() => {
        admitted += 1;
      })
    );
    await flush();
    expect(admitted).toBe(1);

    // 39ms is not enough; the 40ms boundary is.
    await clock.advance(39);
    expect(admitted).toBe(1);
    await clock.advance(1);
    expect(admitted).toBe(2);
    await clock.advance(40);
    expect(admitted).toBe(3);
    await clock.advance(80);
    expect(admitted).toBe(5);

    await Promise.all(pending);
  });

  test('a per-method backoff delays admission until it expires', async () => {
    const clock = new FakeClock();
    const limiter = makeLimiter(clock, { capacity: 25 });

    limiter.applyBackoff('search/advanced', 5000);

    let admitted = false;
    const pending = limiter.acquire('search/advanced').then(() => {
      admitted = true;
    });

    await clock.advance(4000);
    expect(admitted).toBe(false);

    await clock.advance(1500);
    await pending;
    expect(admitted).toBe(true);
  });

  test('backoff is tracked per method, with a fallback for the default key', async () => {
    const clock = new FakeClock();
    const limiter = makeLimiter(clock);

    limiter.applyBackoff('questions/answers', 1000);

    expect(limiter.activeBackoffs().map((entry) => entry.method)).toEqual(['questions/answers']);

    await clock.advance(1500);
    expect(limiter.activeBackoffs()).toEqual([]);
  });

  test('cancelling a waiter removes it and rejects with a cancellation error', async () => {
    const clock = new FakeClock();
    const limiter = makeLimiter(clock, { capacity: 1 });

    // Consume the only slot, then queue a waiter that will be cancelled.
    await limiter.acquire();

    const controller = new AbortController();
    const queued = limiter.acquire(undefined, controller.signal);
    controller.abort();

    await expect(queued).rejects.toBeInstanceOf(CancelledError);
    // The cancelled waiter must not consume a slot or hold a timer.
    expect(clock.pending()).toBeLessThanOrEqual(1);
  });

  test('cancelling an already-aborted signal fails immediately', async () => {
    const clock = new FakeClock();
    const limiter = makeLimiter(clock);
    const controller = new AbortController();
    controller.abort();

    await expect(limiter.acquire(undefined, controller.signal)).rejects.toBeInstanceOf(CancelledError);
  });

  test('the limiter leaves no pending timers once every waiter is served', async () => {
    const clock = new FakeClock();
    const limiter = makeLimiter(clock, { capacity: 2 });

    const pending = Array.from({ length: 6 }, () => limiter.acquire());
    await clock.advance(10_000);
    await Promise.all(pending);

    expect(clock.pending()).toBe(0);
  });
});
