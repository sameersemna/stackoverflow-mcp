/**
 * Request admission control for the Stack Exchange API.
 *
 * Responsibility: decide when a request may be sent, and make that decision
 * safely under concurrency. Stack Exchange throttles per IP, so the limit is a
 * property of the process, not of a session or a tool call.
 *
 * ## Why admission is reserved synchronously
 *
 * The previous implementation read the shared timestamp list, `await`ed, and only
 * then pushed its own timestamp. With 60 concurrent callers all 60 observed
 * "under the limit" and passed, measured at **60 admissions in 41 ms** against a
 * 25/s limit. Any asynchronous check-then-act has that failure mode, so `acquire`
 * decides and *records* the slot before it awaits anything: a caller either
 * consumes a token immediately, or joins a FIFO queue of waiters.
 *
 * ## Shape of the algorithm
 *
 * Three constraints are enforced together, matching the API's documented
 * behaviour:
 *
 * 1. at most `capacity` admissions per sliding `windowMs`, and
 * 2. at least `minDelayMs` between consecutive admissions, and
 * 3. any per-method `backoff` the API asked for, honoured before reservation.
 *
 * A single pump timer wakes the FIFO queue, so N waiters cost one timer rather
 * than N. The clock and timers are injected for deterministic tests.
 */
import { CancelledError } from '../errors.js';

/** Injected time source and scheduler. */
export interface LimiterClock {
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

export interface RateLimiterOptions {
  /** Maximum admissions per sliding window. */
  capacity: number;
  /** Sliding window length in milliseconds. */
  windowMs: number;
  /** Minimum delay between consecutive admissions in milliseconds. */
  minDelayMs: number;
  /** Time source; defaults to `Date.now`. */
  now?: () => number;
  /** Timer functions; default to the global ones. */
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

interface Waiter {
  method: string;
  resolve: () => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/** The production clock. */
const defaultClock: LimiterClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class RateLimiter {
  private readonly capacity: number;
  private readonly windowMs: number;
  private readonly minDelayMs: number;
  private readonly clock: LimiterClock;

  /** Admission timestamps inside the current window, oldest first. */
  private admissions: number[] = [];
  /** Method -> timestamp (ms) until which that method must wait. */
  private readonly backoffUntil = new Map<string, number>();
  private readonly waiters: Waiter[] = [];
  private pumpHandle: unknown;
  private lastAdmissionAt = Number.NEGATIVE_INFINITY;
  private totalAdmissions = 0;

  constructor(options: RateLimiterOptions) {
    this.capacity = Math.max(1, Math.floor(options.capacity));
    this.windowMs = Math.max(1, Math.floor(options.windowMs));
    this.minDelayMs = Math.max(0, Math.floor(options.minDelayMs));
    this.clock = {
      now: options.now ?? defaultClock.now,
      setTimeout: options.setTimeout ?? defaultClock.setTimeout,
      clearTimeout: options.clearTimeout ?? defaultClock.clearTimeout,
    };
  }

  /**
   * Waits until this request is allowed to be sent.
   *
   * The admission decision happens synchronously, so concurrent callers cannot
   * all pass together.
   *
   * @param method - API method, used for per-method backoff.
   * @param signal - Cancellation signal; aborting removes the waiter from the
   *   queue without consuming a slot.
   */
  acquire(method: string = 'default', signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(new CancelledError('The request was cancelled before it completed.'));
    }

    // Fast path: reserve a slot now, before yielding to the event loop.
    if (this.tryReserve(method)) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { method, resolve, reject };
      if (signal) {
        waiter.signal = signal;
        waiter.onAbort = (): void => {
          const index = this.waiters.indexOf(waiter);
          if (index !== -1) {
            this.waiters.splice(index, 1);
          }
          reject(new CancelledError('The request was cancelled before it completed.'));
          this.schedulePump();
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
      this.schedulePump();
    });
  }

  /** Records a backoff requested by the API for one method. */
  applyBackoff(method: string, delayMs: number): void {
    if (delayMs <= 0) {
      return;
    }
    const until = this.clock.now() + delayMs;
    const existing = this.backoffUntil.get(method) ?? 0;
    this.backoffUntil.set(method, Math.max(existing, until));
    this.schedulePump();
  }

  /**
   * Number of admissions currently counted inside the sliding window.
   *
   * Exposed for tests and for the quota resource: it is the observable form of
   * the limiter's own accounting, so a concurrency regression is visible without
   * having to infer it from request timings.
   */
  admissionsInWindow(): number {
    this.pruneAdmissions(this.clock.now());
    return this.admissions.length;
  }

  /** Total number of admissions since construction. */
  get admissionCount(): number {
    return this.totalAdmissions;
  }

  /** Waiters currently queued for admission. */
  get queuedCount(): number {
    return this.waiters.length;
  }

  /** Backoffs still in force, for reporting through `stackoverflow://quota`. */
  activeBackoffs(): { method: string; until: number }[] {
    const now = this.clock.now();
    const active: { method: string; until: number }[] = [];
    for (const [method, until] of this.backoffUntil) {
      if (until > now) {
        active.push({ method, until });
      } else {
        this.backoffUntil.delete(method);
      }
    }
    return active;
  }

  /**
   * Attempts to take a slot without awaiting.
   *
   * @returns True when the slot was reserved; false when the caller must queue.
   */
  private tryReserve(method: string): boolean {
    const now = this.clock.now();
    this.pruneAdmissions(now);

    const backoffUntil = this.backoffUntil.get(method);
    if (backoffUntil !== undefined && backoffUntil > now) {
      return false;
    }

    if (this.admissions.length >= this.capacity) {
      return false;
    }
    if (now - this.lastAdmissionAt < this.minDelayMs) {
      return false;
    }

    this.admissions.push(now);
    this.lastAdmissionAt = now;
    this.totalAdmissions += 1;
    return true;
  }

  /** Drops admission timestamps that have fallen out of the window. */
  private pruneAdmissions(now: number): void {
    const cutoff = now - this.windowMs;
    const firstKept = this.admissions.findIndex((at) => at > cutoff);
    if (firstKept === -1) {
      this.admissions = [];
    } else if (firstKept > 0) {
      this.admissions = this.admissions.slice(firstKept);
    }
  }

  /** Milliseconds until the next slot could become available. */
  private waitForNextSlot(method: string): number {
    const now = this.clock.now();
    const backoffUntil = this.backoffUntil.get(method);
    if (backoffUntil !== undefined && backoffUntil > now) {
      return backoffUntil - now;
    }

    const waits: number[] = [];
    if (this.admissions.length >= this.capacity) {
      const oldest = this.admissions[0]!;
      waits.push(Math.max(0, oldest + this.windowMs - now));
    }
    if (this.minDelayMs > 0) {
      waits.push(Math.max(0, this.lastAdmissionAt + this.minDelayMs - now));
    }
    // Nothing is blocking, or the blocking reason just expired: wake promptly.
    return waits.length > 0 ? Math.max(1, Math.min(...waits)) : 1;
  }

  /** Schedules a single pump that serves as many queued waiters as possible. */
  private schedulePump(): void {
    if (this.pumpHandle !== undefined || this.waiters.length === 0) {
      return;
    }

    const nextMethod = this.waiters[0]!.method;
    const delay = this.waitForNextSlot(nextMethod);
    this.pumpHandle = this.clock.setTimeout(() => {
      this.pumpHandle = undefined;
      this.pump();
    }, delay);
  }

  private pump(): void {
    // Serve the queue in FIFO order, stopping at the first waiter that cannot be
    // admitted so that no later caller can jump the queue.
    while (this.waiters.length > 0) {
      const waiter = this.waiters[0]!;
      if (waiter.signal?.aborted) {
        this.waiters.shift();
        waiter.reject(new CancelledError('The request was cancelled before it completed.'));
        continue;
      }
      if (!this.tryReserve(waiter.method)) {
        break;
      }
      this.waiters.shift();
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener('abort', waiter.onAbort);
      }
      waiter.resolve();
    }

    this.schedulePump();
  }
}
