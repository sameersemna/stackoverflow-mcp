/**
 * Quota tracking tests (B15).
 *
 * Responsibility: prove that the real `quota_remaining`/`quota_max` values from
 * API responses reach the client, both through the `stackoverflow://quota`
 * resource and through the `_meta` of every tool result.
 *
 * Previously those values were logged and discarded, so the resource could only
 * report static constants — useless for the one question that matters when
 * searches start failing: how much allowance is left, and when does it reset.
 */
import { describe, expect, test, afterEach } from "@jest/globals"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { StackOverflowServer } from "../server.js"
import { QuotaTracker, nextQuotaReset } from "../core/quota.js"
import { emptyApiResponse, installFetchHarness, type FetchHarness } from "./helpers/fetchHarness.js"
import { internals } from "./helpers/serverInternals.js"
import { parseToolJson, resourceText } from "./helpers/toolJson.js"

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

describe("quota reset semantics", () => {
  test("the reset is the next 00:00 UTC", () => {
    // 2026-10-17T16:10:00Z -> 2026-10-18T00:00:00Z
    expect(nextQuotaReset(Date.UTC(2026, 9, 17, 16, 10, 0))).toBe("2026-10-18T00:00:00.000Z")
  })

  test("a time just before midnight resets the same day boundary", () => {
    expect(nextQuotaReset(Date.UTC(2026, 9, 17, 23, 59, 59))).toBe("2026-10-18T00:00:00.000Z")
  })
})

describe("quota tracker", () => {
  test("records figures from responses", () => {
    const tracker = new QuotaTracker({ hasApiKey: () => true, now: () => 1000 })
    tracker.update(250, 300)

    expect(tracker.snapshot()).toMatchObject({ remaining: 250, max: 300, observedAt: 1000 })
    expect(tracker.isLow()).toBe(false)
    expect(tracker.isExhausted()).toBe(false)
  })

  test("a partial payload does not wipe known-good values", () => {
    const tracker = new QuotaTracker({ hasApiKey: () => true })
    tracker.update(250, 300)
    tracker.update(undefined, undefined)

    expect(tracker.snapshot().remaining).toBe(250)
    expect(tracker.snapshot().max).toBe(300)
  })

  test("reports low and exhausted states", () => {
    const tracker = new QuotaTracker({ hasApiKey: () => true, warnThreshold: 100 })
    tracker.update(99, 300)
    expect(tracker.isLow()).toBe(true)

    tracker.update(0, 300)
    expect(tracker.isExhausted()).toBe(true)
    expect(tracker.readiness().status).toBe("degraded")
  })

  test("an exhausted quota is degraded, not a failure", () => {
    const tracker = new QuotaTracker({ hasApiKey: () => true })
    tracker.update(0, 300)

    expect(tracker.readiness().status).toBe("degraded")
    expect(tracker.readiness().quota.resetAt).toMatch(/T00:00:00\.000Z$/)
  })

  test("reports whether the anonymous allowance is in use", () => {
    expect(new QuotaTracker({ hasApiKey: () => false }).usesAnonymousQuota()).toBe(true)
    expect(new QuotaTracker({ hasApiKey: () => true }).usesAnonymousQuota()).toBe(false)
  })
})

describe("quota exposure through the MCP surface (B15)", () => {
  let harness: FetchHarness

  afterEach(() => {
    harness?.restore()
  })

  async function connect(server: StackOverflowServer): Promise<Client> {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: "quota-test", version: "1.0.0" })
    await Promise.all([
      client.connect(clientTransport),
      server.getServer().connect(serverTransport),
    ])
    return client
  }

  test("the quota resource reports the figures from the last API response", async () => {
    harness = installFetchHarness({
      routes: {
        "*": { body: emptyApiResponse({ items: [QUESTION], quota_remaining: 42, quota_max: 300 }) },
      },
    })

    const server = new StackOverflowServer()
    const client = await connect(server)

    await (
      server as never as {
        handleSearchByError: (input: unknown) => Promise<unknown>
      }
    ).handleSearchByError({ errorMessage: "TypeError: boom", limit: 1 })

    const resource = await client.readResource({ uri: "stackoverflow://quota" })
    const payload = parseToolJson<{
      quota: { remaining: number; max: number; resetAt: string; observedAt: string | null }
      cache: { size: number }
    }>(resourceText(resource.contents))

    expect(payload.quota.remaining).toBe(42)
    expect(payload.quota.max).toBe(300)
    expect(payload.quota.resetAt).toMatch(/T00:00:00\.000Z$/)
    expect(payload.quota.observedAt).toBeTruthy()
    expect(payload.cache.size).toBeGreaterThan(0)

    await client.close()
  })

  test("the resource reports null figures before any API response", async () => {
    harness = installFetchHarness({ routes: { "*": { body: emptyApiResponse() } } })
    const server = new StackOverflowServer()
    const client = await connect(server)

    const resource = await client.readResource({ uri: "stackoverflow://quota" })
    const payload = parseToolJson<{
      quota: { remaining: number | null; max: number | null; observedAt: string | null }
    }>(resourceText(resource.contents))

    // Honest about not knowing yet, rather than reporting a fake number.
    expect(payload.quota.remaining).toBeNull()
    expect(payload.quota.max).toBeNull()
    expect(payload.quota.observedAt).toBeNull()

    await client.close()
  })

  test("every tool result carries the quota summary in _meta", async () => {
    harness = installFetchHarness({
      routes: {
        "*": { body: emptyApiResponse({ items: [QUESTION], quota_remaining: 77, quota_max: 300 }) },
      },
    })

    const server = new StackOverflowServer()
    const client = await connect(server)

    const result = await client.callTool({
      name: "search_by_question_id",
      arguments: { questionId: 1, includeAnswers: false },
    })

    const meta = result._meta as
      | { quota?: { remaining?: number; max?: number; resetAt?: string; anonymous?: boolean } }
      | undefined

    expect(meta?.quota?.remaining).toBe(77)
    expect(meta?.quota?.max).toBe(300)
    expect(meta?.quota?.resetAt).toMatch(/T00:00:00\.000Z$/)
    expect(meta?.quota?.anonymous).toBe(true)

    await client.close()
  })

  test("error results carry the quota summary too", async () => {
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

    const server = new StackOverflowServer()
    const client = await connect(server)

    const result = await client.callTool({
      name: "search_by_question_id",
      arguments: { questionId: 1 },
    })

    expect(result.isError).toBe(true)
    const meta = result._meta as { quota?: { remaining?: number } } | undefined
    expect(meta?.quota?.remaining).toBe(0)

    await client.close()
  })

  test("a shared tracker keeps every session in agreement", async () => {
    harness = installFetchHarness({
      routes: {
        "*": { body: emptyApiResponse({ items: [QUESTION], quota_remaining: 12, quota_max: 300 }) },
      },
    })

    const shared = new QuotaTracker({ hasApiKey: () => false })
    const first = new StackOverflowServer({ quota: shared })
    const second = new StackOverflowServer({ quota: shared })

    await (
      first as never as {
        handleSearchByQuestionId: (input: unknown) => Promise<unknown>
      }
    ).handleSearchByQuestionId({ questionId: 1, includeAnswers: false })
    await (
      second as never as {
        handleSearchByQuestionId: (input: unknown) => Promise<unknown>
      }
    ).handleSearchByQuestionId({ questionId: 1, includeAnswers: false })

    expect(shared.snapshot().remaining).toBe(12)
    expect(internals(second).quota).toBe(shared)
  })
})
