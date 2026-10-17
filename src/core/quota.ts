/**
 * Stack Exchange quota tracking.
 *
 * Responsibility: remember the quota figures the API reports so the server can
 * tell a client how much allowance is left instead of only stating static
 * constants (B15).
 *
 * The API returns `quota_max` and `quota_remaining` on every response, and the
 * previous implementation logged them and discarded them, so
 * `stackoverflow://quota` could not answer the one question that matters when a
 * search starts failing: how much is left, and when does it reset?
 *
 * Reset semantics: quota is counted per day and resets at **00:00 UTC**. The
 * tracker therefore reports the next UTC midnight as the reset time rather than
 * inventing a client-side window.
 */
import { buildQuotaMessage } from './messages.js';

/** Latest quota figures observed from the API. */
export interface QuotaSnapshot {
  /** Requests remaining, or `undefined` before the first response. */
  remaining: number | undefined;
  /** Daily allowance, or `undefined` before the first response. */
  max: number | undefined;
  /** When the figures were last updated (epoch ms), 0 if never. */
  observedAt: number;
}

/** The next UTC midnight, i.e. the documented quota reset. */
export function nextQuotaReset(now: number = Date.now()): string {
  const date = new Date(now);
  const reset = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate() + 1,
    0,
    0,
    0,
    0
  );
  return new Date(reset).toISOString();
}

export class QuotaTracker {
  private remaining: number | undefined;
  private max: number | undefined;
  private observedAt = 0;
  private readonly hasApiKey: () => boolean;
  private readonly now: () => number;
  /** Levels below which a caller should warn, in remaining requests. */
  private readonly warnThreshold: number;

  constructor(options: { hasApiKey: () => boolean; warnThreshold?: number; now?: () => number }) {
    this.hasApiKey = options.hasApiKey;
    this.warnThreshold = options.warnThreshold ?? 100;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Records the figures from one API response.
   *
   * Ignores responses that carry neither field, so a partial payload cannot wipe
   * known-good values.
   */
  update(remaining: number | undefined, max: number | undefined): void {
    if (remaining === undefined && max === undefined) {
      return;
    }
    this.remaining = remaining ?? this.remaining;
    this.max = max ?? this.max;
    this.observedAt = this.now();
  }

  snapshot(): QuotaSnapshot {
    return { remaining: this.remaining, max: this.max, observedAt: this.observedAt };
  }

  /** True when the last observed response said the allowance is spent. */
  isExhausted(): boolean {
    return this.remaining === 0;
  }

  /** True when the remaining allowance has fallen to the warning threshold. */
  isLow(): boolean {
    return this.remaining !== undefined && this.remaining < this.warnThreshold;
  }

  /** True while the server is running on the anonymous per-IP allowance. */
  usesAnonymousQuota(): boolean {
    return !this.hasApiKey();
  }

  /** The next reset instant, ISO-8601 UTC. */
  resetAt(): string {
    return nextQuotaReset(this.now());
  }

  /**
   * Health summary for the `/ready` endpoint.
   *
   * `degraded` rather than failing, because an exhausted quota still serves
   * cached responses and is a normal end-of-day state, not an outage.
   */
  readiness(): { status: 'ok' | 'degraded'; quota: QuotaSnapshot & { resetAt: string } } {
    return {
      status: this.isExhausted() ? 'degraded' : 'ok',
      quota: { ...this.snapshot(), resetAt: this.resetAt() },
    };
  }

  /** The actionable message used when a request fails because quota ran out. */
  exhaustedMessage(): string {
    return buildQuotaMessage(this.remaining, this.max, this.hasApiKey());
  }
}
