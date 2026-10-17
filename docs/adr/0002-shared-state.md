# ADR 0002 — Shared state across sessions

- **Status:** Accepted
- **Date:** 2026-10-17
- **Phase:** 3 (shared core)
- **Deciders:** maintainer (`sameersemna`), implementation by Copilot

## Context

Every HTTP `initialize` request constructs a **new `StackOverflowServer`**
(`src/transports/http.ts`), and each instance owns its own

- rate limiter (`requestTimestamps`, `lastRequestTime`),
- per-method backoff map (`backoffUntil`),
- response cache (`responseCache`, `cacheTtlMs`),
- quota figures.

Stack Exchange throttles **per IP**, so N concurrent sessions do not get N times
the allowance — they get throttled sooner. With N sessions the process sends up
to N x 25 requests/second from one IP, and because the caches are separate there
is no cache sharing at all: two sessions asking the same question each spend
quota.

Two further problems exist inside the limiter itself:

1. **`checkRateLimit` is not concurrency-safe.** It reads the shared timestamp
   list, awaits, then pushes, so concurrent callers all observe "under the limit"
   and pass together. Measured: **60 admissions in 41 ms** against a 25/s limit.
2. `now` is captured before the awaits and reused afterwards, so the recorded
   timestamps describe a time that has already passed.

## Decision

1. **The limiter, cache, quota tracker and backoff map become shared, injectable
   objects.** `cli.ts` builds one `deps` object and every per-session
   `McpServer` receives those same instances.
2. **They are NOT process-wide by default.** `new StackOverflowServer()` with no
   arguments still creates its own state. Reason: 17 test suites depend on
   per-instance isolation (a fresh cache, a fresh limiter), and a shared default
   would make them order- and history-dependent. Production shares state because
   `cli.ts` passes it in, not because a module happens to be a singleton.
3. **The limiter reserves a slot synchronously**, before any `await`. A call
   either consumes a token immediately or joins a FIFO waiter queue. This is the
   B1 fix: an asynchronous check-then-act cannot be made correct by lowering the
   limit.
4. **The clock and timers are injected** (`now`, `setTimeout`, `clearTimeout`)
   with production defaults, so timing behaviour is deterministic in tests instead
   of relying on real wall-clock sleeps.
5. Per-method `backoff` is honoured **before** reservation, and both the backoff
   wait and the admission wait are abort-aware.

## Consequences

- Correctness under concurrency becomes assertable: "at most `capacity`
  admissions per window with 100 concurrent callers" is a plain unit test.
- HTTP mode stops multiplying the request rate by the session count, and session
  two reuses session one's cache entries.
- The `deps` object is the same seam Phase 7 needs to make configuration fully
  injectable.
- Cost: the limiter needs a small internal pump to wake FIFO waiters, which is
  more code than the previous timestamp array. That is the price of correctness.

## Alternatives considered

1. **Make the module export a singleton by default.** Rejected: it silently
   couples otherwise-independent unit tests and makes failures depend on
   execution order.
2. **A mutex around the existing check-then-act.** Rejected: it serialises the
   *decision* correctly but is strictly weaker than synchronous reservation —
   each waiter still has to re-check after waking, and it cannot express FIFO
   fairness or per-method backoff cleanly.
3. **Use `p-limit` or `bottleneck`.** Rejected for now: the requirement (fixed
   window, FIFO, per-key backoff, abort-aware, injected clock) is specific enough
   that a dependency would need as much configuration as the ~100 lines it
   replaces, and §6 of the brief says to prefer the standard library and an ADR
   for every new runtime dependency.
