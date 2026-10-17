/**
 * Deterministic clock for timing tests.
 *
 * Responsibility: let a test control both the current time and scheduled timers,
 * so rate-limit and cache-expiry behaviour can be asserted without real sleeps
 * and without jest fake timers interfering with genuine promise resolution.
 */

/** Deterministic clock whose time only moves when a test moves it. */
export class FakeClock {
  private current = 1_000_000
  private timers: { id: number; at: number; fn: () => void }[] = []
  private nextId = 1

  now = (): number => this.current

  setTimeout = (fn: () => void, ms: number): unknown => {
    const id = this.nextId++
    this.timers.push({ id, at: this.current + Math.max(0, ms), fn })
    return id
  }

  clearTimeout = (handle: unknown): void => {
    this.timers = this.timers.filter((timer) => timer.id !== handle)
  }

  /** Advances time, firing due timers in scheduled order. */
  async advance(ms: number): Promise<void> {
    const target = this.current + ms
    for (;;) {
      const due = this.timers
        .filter((timer) => timer.at <= target)
        .sort((a, b) => a.at - b.at || a.id - b.id)
      if (due.length === 0) {
        break
      }
      const next = due[0]
      this.timers = this.timers.filter((timer) => timer.id !== next.id)
      this.current = next.at
      next.fn()
      await Promise.resolve()
      await Promise.resolve()
    }
    this.current = target
    await Promise.resolve()
    await Promise.resolve()
  }

  /** Pending timer count, for asserting the pump does not leak timers. */
  pending(): number {
    return this.timers.length
  }
}
