/**
 * Default page size tests (B5).
 *
 * Responsibility: pin the default `limit`. When `limit` was unset the server sent
 * no `pagesize` at all, so the Stack Exchange default of 30 applied: 30 question
 * bodies, their answers and their comments, which the 25,000 character budget
 * then truncated anyway. That wasted both API quota and context window.
 *
 * The default is a deliberate, documented behaviour change (see CHANGELOG.md).
 */
import { describe, expect, test, beforeEach, afterEach, jest } from "@jest/globals"
import { StackOverflowServer } from "../server.js"
import { emptyApiResponse, installFetchHarness, type FetchHarness } from "./helpers/fetchHarness.js"

const DEFAULT_LIMIT = 5

/** All tools that accept a `limit`, with a minimal valid payload for each. */
const LIMIT_TOOLS: readonly { tool: string; input: Record<string, unknown> }[] = [
  { tool: "handleSearchByError", input: { errorMessage: "TypeError: boom" } },
  { tool: "handleSearchByTags", input: { tags: ["javascript"] } },
  {
    tool: "handleAnalyzeStackTrace",
    input: { stackTrace: "TypeError: boom\n  at f (a.js:1:1)", language: "javascript" },
  },
  { tool: "handleSearchByQuery", input: { query: "pandas dataframe" } },
]

describe("default page size (B5)", () => {
  let harness: FetchHarness

  beforeEach(() => {
    harness = installFetchHarness({ routes: { "*": { body: emptyApiResponse() } } })
  })

  afterEach(() => {
    harness.restore()
  })

  for (const { tool, input } of LIMIT_TOOLS) {
    test(`${tool} sends pagesize=${DEFAULT_LIMIT} when limit is omitted`, async () => {
      // Each tool gets its own server so the response cache cannot mask the call.
      jest.resetModules()
      const { StackOverflowServer: FreshServer } = await import("../server.js")
      const server = new FreshServer()

      await (server as never as Record<string, (i: unknown) => Promise<unknown>>)[tool](input)

      const searchCall = harness.calls.find(
        (call) => call.path === "/search/advanced" || call.path === "/questions"
      )
      expect(searchCall).toBeDefined()
      expect(searchCall!.get("pagesize")).toBe(String(DEFAULT_LIMIT))
    })
  }

  test("an explicit limit is honoured and overrides the default", async () => {
    const server = new StackOverflowServer()

    await (
      server as never as {
        handleSearchByError: (input: unknown) => Promise<unknown>
      }
    ).handleSearchByError({ errorMessage: "TypeError: boom", limit: 12 })

    expect(harness.calls[0].get("pagesize")).toBe("12")
  })

  test("limit 100 is still accepted (existing maximum)", async () => {
    const server = new StackOverflowServer()

    const result = await (
      server as never as {
        handleSearchByError: (input: unknown) => Promise<{ isError?: boolean }>
      }
    ).handleSearchByError({ errorMessage: "TypeError: boom", limit: 100 })

    expect(result.isError).toBeFalsy()
    expect(harness.calls[0].get("pagesize")).toBe("100")
  })
})
