/**
 * Error-classification and retry-policy tests (B7, B8).
 *
 * Responsibility: prove that every failure category reaches the client with an
 * accurate, actionable message, and that the number of upstream requests matches
 * the retry policy.
 *
 * B7: all failures used to be reported as `Validation failed: …`.
 * B8: `error_id 502` (throttle *and* quota exhaustion) was retried after
 * 100/200/400 ms, which cannot fix either condition, burns quota, and can
 * extend an IP ban; HTTP 429 without an `error_id` body was not retried at all.
 */
import { describe, expect, test, beforeEach, afterEach } from "@jest/globals"
import { StackOverflowServer } from "../server.js"
import { emptyApiResponse, installFetchHarness, type FetchHarness } from "./helpers/fetchHarness.js"
import { computeRetryDelayMs } from "../server.js"
import { retryAfterMs, sleep } from "../core/http.js"
import { CancelledError } from "../errors.js"

/** Keeps the real backoff code path but avoids multi-second test runs. */
const TEST_RETRY_BASE_DELAY_MS = "1"

const QUESTION = {
  question_id: 1,
  title: "Q",
  body: "body",
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

function textOf(result: ToolResult): string {
  return result.content.map((block) => block.text).join("\n")
}

describe("error classification and retries (B7, B8)", () => {
  let harness: FetchHarness
  let server: StackOverflowServer

  beforeEach(() => {
    process.env.RETRY_BASE_DELAY_MS = TEST_RETRY_BASE_DELAY_MS
  })

  afterEach(() => {
    delete process.env.RETRY_BASE_DELAY_MS
    harness?.restore()
  })

  function callSearch(): Promise<ToolResult> {
    server = new StackOverflowServer()
    return (
      server as never as {
        handleSearchByError: (input: unknown) => Promise<ToolResult>
      }
    ).handleSearchByError({ errorMessage: "TypeError: boom", limit: 2 })
  }

  test("quota exhaustion fails fast with an actionable message and no retries", async () => {
    harness = installFetchHarness({
      routes: {
        "*": {
          status: 200,
          body: {
            error_id: 502,
            error_name: "throttle_violation",
            error_message: "Violation of backoff parameter",
            quota_remaining: 0,
            quota_max: 300,
          },
        },
      },
    })

    const result = await callSearch()
    const text = textOf(result)

    expect(result.isError).toBe(true)
    expect(text).toMatch(/quota/i)
    // Must not be mislabelled as a validation problem.
    expect(text).not.toContain("Validation failed")
    // The key insight: exactly one request, because retrying cannot help.
    harness.assertCallCount(1)
  })

  test("quota exhaustion without a key suggests setting STACKOVERFLOW_API_KEY", async () => {
    harness = installFetchHarness({
      routes: {
        "*": {
          body: {
            error_id: 502,
            error_name: "throttle_violation",
            error_message: "Violation of backoff parameter",
            quota_remaining: 0,
            quota_max: 300,
          },
        },
      },
    })

    const text = textOf(await callSearch())

    expect(text).toContain("STACKOVERFLOW_API_KEY")
  })

  test("a throttle with an error_id body is retried a bounded number of times", async () => {
    harness = installFetchHarness({
      routes: {
        "*": {
          body: {
            error_id: 502,
            error_name: "throttle_violation",
            error_message: "Violation of backoff parameter",
            quota_remaining: 250,
            quota_max: 300,
          },
        },
      },
    })

    const result = await callSearch()

    expect(result.isError).toBe(true)
    // 1 initial attempt + at most 2 retries.
    expect(harness.callCount()).toBeLessThanOrEqual(3)
    expect(harness.callCount()).toBeGreaterThan(1)
    expect(textOf(result)).toMatch(/rate limit|throttl/i)
  })

  test("HTTP 429 without an error_id body is retried (previously it was not)", async () => {
    let calls = 0
    harness = installFetchHarness({
      routes: {
        "*": () => {
          calls += 1
          if (calls === 1) {
            return { status: 429, rawBody: "Too many requests" }
          }
          return { status: 200, body: emptyApiResponse({ items: [QUESTION] }) }
        },
      },
    })

    const result = await callSearch()

    expect(result.isError).toBeFalsy()
    // Two search attempts: the 429, then the successful retry. (The separate
    // answers request is not part of the retry policy under test.)
    expect(harness.callsTo("/search/advanced")).toHaveLength(2)
  })

  test("a persistent 429 eventually reports a rate-limit error, not a validation error", async () => {
    harness = installFetchHarness({
      routes: { "*": { status: 429, rawBody: "Too many requests" } },
    })

    const result = await callSearch()
    const text = textOf(result)

    expect(result.isError).toBe(true)
    expect(text).not.toContain("Validation failed")
    expect(text).toMatch(/rate limit|throttl|429/i)
  })

  test("a deterministic API error is not retried", async () => {
    harness = installFetchHarness({
      routes: {
        "*": {
          body: {
            error_id: 400,
            error_name: "bad_parameter",
            error_message: "sort parameter is not valid",
            quota_remaining: 250,
            quota_max: 300,
          },
        },
      },
    })

    const result = await callSearch()

    expect(result.isError).toBe(true)
    expect(harness.callCount()).toBe(1)
    expect(textOf(result)).toContain("sort parameter is not valid")
  })

  test("a network failure is retried and then reported as an upstream error", async () => {
    harness = installFetchHarness({
      routes: {
        "*": () => {
          throw new Error("ECONNRESET")
        },
      },
    })

    const result = await callSearch()
    const text = textOf(result)

    expect(result.isError).toBe(true)
    expect(harness.callCount()).toBeLessThanOrEqual(3)
    expect(text).not.toContain("Validation failed")
  })

  test("invalid arguments are still reported as a validation error, compactly", async () => {
    harness = installFetchHarness({ routes: { "*": { body: emptyApiResponse() } } })

    const server2 = new StackOverflowServer()
    const invalid = await (
      server2 as never as {
        handleSearchByError: (input: unknown) => Promise<ToolResult>
      }
    ).handleSearchByError({ errorMessage: "boom", limit: -1, page: 0 })

    expect(invalid.isError).toBe(true)
    const text = textOf(invalid)
    expect(text).toContain("Validation failed")
    // Compact rendering: a model can read it, and it is not a raw JSON blob.
    expect(text).not.toContain('"code":')
    expect(text).not.toContain('"path":')
    // Validation must happen before any request is made.
    harness.assertCallCount(0)
  })

  test("the API error message is preserved for the caller", async () => {
    harness = installFetchHarness({
      routes: {
        "*": {
          body: {
            error_id: 400,
            error_name: "bad_parameter",
            error_message: "min parameter is not valid with sort=relevance",
            quota_remaining: 250,
            quota_max: 300,
          },
        },
      },
    })

    expect(textOf(await callSearch())).toContain("min parameter is not valid with sort=relevance")
  })
})

describe("retry delay computation (B8)", () => {
  test("parses Retry-After seconds and HTTP dates, ignoring invalid values", () => {
    const response = (value: string | null): { headers: { get: () => string | null } } => ({
      headers: { get: () => value },
    })
    expect(retryAfterMs(response("2"))).toBe(2_000)
    expect(retryAfterMs(response("not a date"))).toBeUndefined()
    expect(retryAfterMs(response(null))).toBeUndefined()
    expect(retryAfterMs(response("Thu, 01 Jan 1970 00:00:00 GMT"))).toBe(0)
    expect(retryAfterMs(response("Fri, 01 Jan 2100 00:00:00 GMT"))).toBeGreaterThan(0)
  })

  test("cancels a pending retry delay", async () => {
    const controller = new AbortController()
    const pending = sleep(10_000, controller.signal)
    controller.abort()
    await expect(pending).rejects.toBeInstanceOf(CancelledError)
    await expect(sleep(10, controller.signal)).rejects.toBeInstanceOf(CancelledError)
    await expect(sleep(0)).resolves.toBeUndefined()
  })

  test("follows `Retry-After` when the API supplies one", () => {
    expect(computeRetryDelayMs(1, 5_000)).toBeGreaterThanOrEqual(5_000)
  })

  test("grows exponentially with the attempt number", () => {
    const first = computeRetryDelayMs(1, undefined)
    const second = computeRetryDelayMs(2, undefined)

    expect(first).toBeGreaterThan(0)
    expect(second).toBeGreaterThan(first)
  })

  test("is capped so a pathological response cannot stall a tool call", () => {
    expect(computeRetryDelayMs(10, undefined)).toBeLessThanOrEqual(30_000)
  })
})
