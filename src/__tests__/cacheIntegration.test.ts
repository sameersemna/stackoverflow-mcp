/**
 * Cache integration tests through the tool surface.
 *
 * Responsibility: prove the cache properties hold where they actually matter —
 * across tool calls — and that a shared cache lets two sessions avoid duplicate
 * upstream requests (the reason the cache becomes injectable in Phase 3).
 *
 * `cache.test.ts` covers the cache in isolation; this suite covers its wiring.
 */
import { describe, expect, test, afterEach } from "@jest/globals"
import { StackOverflowServer } from "../server.js"
import { ResponseCache } from "../core/cache.js"
import { emptyApiResponse, installFetchHarness, type FetchHarness } from "./helpers/fetchHarness.js"
import { FakeClock } from "./helpers/fakeClock.js"

const QUESTION = {
  question_id: 1,
  title: "Q",
  body: "b",
  score: 1,
  answer_count: 0,
  is_answered: false,
  creation_date: 1,
  tags: ["javascript"],
  link: "https://stackoverflow.com/q/1",
}

interface ToolResult {
  isError?: boolean
  content: { text: string }[]
}

function call(server: StackOverflowServer, args: Record<string, unknown>): Promise<ToolResult> {
  return (
    server as never as {
      handleSearchByError: (input: unknown) => Promise<ToolResult>
    }
  ).handleSearchByError(args)
}

describe("cache integration", () => {
  let harness: FetchHarness

  afterEach(() => {
    harness?.restore()
  })

  function install(): void {
    harness = installFetchHarness({
      routes: { "*": { body: emptyApiResponse({ items: [QUESTION] }) } },
    })
  }

  test("a repeated identical search costs no extra quota", async () => {
    install()
    const server = new StackOverflowServer()
    const args = { errorMessage: "TypeError: boom", limit: 1 }

    await call(server, args)
    const afterFirst = harness.callCount()
    await call(server, args)

    expect(harness.callCount()).toBe(afterFirst)
  })

  test("argument key order does not defeat the cache", async () => {
    install()
    const server = new StackOverflowServer()

    await call(server, { errorMessage: "TypeError: boom", limit: 1, language: "javascript" })
    const afterFirst = harness.callCount()
    // Same logical request, different property insertion order.
    await call(server, { language: "javascript", limit: 1, errorMessage: "TypeError: boom" })

    expect(harness.callCount()).toBe(afterFirst)
  })

  test("concurrent identical searches share one upstream request", async () => {
    install()
    const server = new StackOverflowServer()
    const args = { errorMessage: "TypeError: boom", limit: 1 }

    const results = await Promise.all([call(server, args), call(server, args), call(server, args)])

    expect(results.every((result) => !result.isError)).toBe(true)
    // One search + one answers call, no matter how many callers asked.
    harness.assertCallsTo("/search/advanced", 1)
  })

  test("a shared cache means a second server instance reuses the first response", async () => {
    install()
    // This models two HTTP sessions of the same process.
    const shared = new ResponseCache()
    const first = new StackOverflowServer({ cache: shared })
    const second = new StackOverflowServer({ cache: shared })
    const args = { errorMessage: "TypeError: boom", limit: 1 }

    await call(first, args)
    const afterFirst = harness.callCount()
    await call(second, args)

    expect(harness.callCount()).toBe(afterFirst)
    expect(shared.stats().hits).toBeGreaterThan(0)
  })

  test("private caches keep separate server instances independent", async () => {
    install()
    const first = new StackOverflowServer()
    const second = new StackOverflowServer()
    const args = { errorMessage: "TypeError: boom", limit: 1 }

    await call(first, args)
    const afterFirst = harness.callCount()
    await call(second, args)

    // No sharing without an injected cache, which is what keeps the unit
    // suites isolated (docs/adr/0002-shared-state.md).
    expect(harness.callCount()).toBeGreaterThan(afterFirst)
  })

  test("an expired entry causes a fresh upstream request", async () => {
    install()
    const clock = new FakeClock()
    const cache = new ResponseCache({ now: clock.now, ttls: { search: 1000 } })
    const server = new StackOverflowServer({ cache })
    const args = { errorMessage: "TypeError: boom", limit: 1 }

    await call(server, args)
    const afterFirst = harness.callCount()

    await clock.advance(1001)
    await call(server, args)

    expect(harness.callCount()).toBeGreaterThan(afterFirst)
    expect(cache.stats().expirations).toBeGreaterThan(0)
  })

  test("the cache never outgrows its bound across many distinct searches", async () => {
    install()
    const cache = new ResponseCache({ maxEntries: 5 })
    const server = new StackOverflowServer({ cache })

    for (let index = 0; index < 20; index += 1) {
      await call(server, { errorMessage: `TypeError: unique ${index}`, limit: 1 })
    }

    expect(cache.stats().size).toBeLessThanOrEqual(5)
  })

  test("cancelling while waiting on a shared result does not cancel the others", async () => {
    install()
    const shared = new ResponseCache()
    const server = new StackOverflowServer({ cache: shared })
    const args = { errorMessage: "TypeError: boom", limit: 1 }

    const controller = new AbortController()
    const cancelled = (
      server as never as {
        handleSearchByError: (input: unknown, signal?: AbortSignal) => Promise<ToolResult>
      }
    ).handleSearchByError(args, controller.signal)
    const sibling = (
      server as never as {
        handleSearchByError: (input: unknown, signal?: AbortSignal) => Promise<ToolResult>
      }
    ).handleSearchByError(args)

    controller.abort()

    await expect(cancelled).resolves.toBeDefined()
    const siblingResult = await sibling
    expect(siblingResult.isError).toBeFalsy()
  })
})
