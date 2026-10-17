import { StackOverflowServer } from "../server.js";
import {
  jest,
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
} from "@jest/globals";
import { RateLimiter } from "../core/rateLimiter.js";
import { FakeClock } from "./helpers/fakeClock.js";

// Import constants for testing
const MAX_REQUESTS_PER_SECOND = 25;

// Store the original fetch
const originalFetch = global.fetch;

// Create a custom fetch function type
// @ts-ignore
type FetchFunc = typeof global.fetch;

// We need to make the StackOverflowServer class and its methods accessible for testing
// This requires modifying the original class to export it and make methods public or protected

describe("Rate Limiting", () => {
  let mockFetch: jest.MockedFunction<FetchFunc>;

  beforeEach(() => {
    // Create a fresh mock for each test
    jest.clearAllMocks();
    jest.useFakeTimers();

    // Setup a fetch mock
    mockFetch = jest.fn() as jest.MockedFunction<FetchFunc>;
    global.fetch = mockFetch;
  });

  afterEach(() => {
    jest.resetAllMocks();
    jest.useRealTimers();
    global.fetch = originalFetch;
  });

  test("should respect rate limits", async () => {
    // Replaces the long-skipped placeholder ("skipped due to timing out").
    // Admission is reserved synchronously by the shared limiter, so a burst of
    // concurrent callers is capped without depending on real timers: the
    // injected clock is driven by the test.
    const clock = new FakeClock();
    const limiter = new RateLimiter({
      capacity: MAX_REQUESTS_PER_SECOND,
      windowMs: 1000,
      minDelayMs: 0,
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });

    let admitted = 0;
    const pending = Array.from({ length: MAX_REQUESTS_PER_SECOND * 2 }, () =>
      limiter.acquire("test-method").then(() => {
        admitted += 1;
      })
    );

    // Let the `.then` callbacks run; admission itself was already decided
    // synchronously inside `acquire`.
    await Promise.resolve();
    await Promise.resolve();

    // Only one window's worth may pass before time advances, even though all
    // callers arrived at once.
    expect(admitted).toBe(MAX_REQUESTS_PER_SECOND);

    await clock.advance(1000);
    await Promise.all(pending);
    expect(admitted).toBe(MAX_REQUESTS_PER_SECOND * 2);
  });

  test("should wait when rate limited", async () => {
    const server = new StackOverflowServer();

    // Mock the server to prevent connections
    (server as any).server = {
      // @ts-ignore - Mock implementation for testing
      connect: jest.fn().mockResolvedValue(undefined),
      // @ts-ignore - Mock implementation for testing
      close: jest.fn().mockResolvedValue(undefined),
    };

    // Mock the runStdio method
    jest
      .spyOn(server as any, "runStdio")
      .mockImplementation(() => Promise.resolve());

    // Mock the API response with proper ApiResponse structure
    const mockApiResponse = {
      items: [],
      has_more: false,
      quota_max: 300,
      quota_remaining: 299,
    };

    mockFetch.mockImplementation(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve(mockApiResponse),
      } as Response)
    );

    // Fill up the rate limit by making many requests quickly
    // This will trigger the rate limiting logic
    const requests = [];
    for (let i = 0; i < MAX_REQUESTS_PER_SECOND + 1; i++) {
      requests.push(
        (server as any).withRateLimit(
          () =>
            Promise.resolve({
              ok: true,
              json: () => Promise.resolve(mockApiResponse),
            } as Response),
          "test-method"
        )
      );
    }

    // Fast-forward time to allow rate limiting to complete
    jest.advanceTimersByTime(3000);

    // All requests should eventually complete
    const results = await Promise.all(requests);
    expect(results).toHaveLength(MAX_REQUESTS_PER_SECOND + 1);
    results.forEach((result) => {
      expect(result).toEqual(mockApiResponse);
    });
  });
});
