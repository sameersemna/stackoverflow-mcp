/**
 * Secret-redaction tests (B6).
 *
 * Responsibility: guarantee that the Stack Exchange API key never appears in a
 * tool error message, in a log record, or in structured output. The API key
 * travels as the `key` query parameter, which the original redaction regex
 * (`api[_-]?key|token|authorization`) did not match — so `...&key=SECRET123`
 * was returned to the client verbatim.
 */
import { describe, expect, test } from "@jest/globals"
import pino from "pino"
import { StackOverflowServer, redactSecrets } from "../server.js"
import { REDACT_PATHS } from "../utils/logger.js"

const SECRET = "SECRET123abcDEF456"

interface ErrorCapableServer {
  createErrorResponse: (message: string) => { content: { text: string }[]; isError: true }
}

/** Every form the key could plausibly take in a message or URL. */
const LEAKY_MESSAGES = [
  `GET https://api.stackexchange.com/2.3/search?site=stackoverflow&key=${SECRET} failed`,
  `GET https://api.stackexchange.com/2.3/search?key=${SECRET}&site=stackoverflow failed`,
  `GET https://api.stackexchange.com/2.3/search?site=stackoverflow&key=${SECRET}`,
  `Request to https://api.stackexchange.com/2.3/questions/1?pagesize=5&&key=${SECRET} timed out`,
  `fetch failed: https://api.stackexchange.com/2.3/search?tagged=js&key=${SECRET}`,
]

describe("secret redaction (B6)", () => {
  const server = new StackOverflowServer() as never as ErrorCapableServer

  test("the `key` query parameter is redacted from error messages", () => {
    for (const message of LEAKY_MESSAGES) {
      const response = server.createErrorResponse(message)
      const text = response.content.map((block) => block.text).join("\n")

      expect(text).not.toContain(SECRET)
      expect(text).toContain("***")
      expect(response.isError).toBe(true)
    }
  })

  test("legacy api_key/token/authorization forms are still redacted", () => {
    const response = server.createErrorResponse(
      `failed: api_key=${SECRET} token=${SECRET} authorization=${SECRET} apiKey=${SECRET}`
    )
    const text = response.content.map((block) => block.text).join("\n")

    expect(text).not.toContain(SECRET)
  })

  test("a bearer token is redacted", () => {
    const response = server.createErrorResponse(
      `failed with header Authorization: Bearer ${SECRET}`
    )
    const text = response.content.map((block) => block.text).join("\n")

    expect(text).not.toContain(SECRET)
  })

  test("ordinary error text is preserved", () => {
    const response = server.createErrorResponse("No question found with ID: 12345")
    const text = response.content.map((block) => block.text).join("\n")

    expect(text).toContain("No question found with ID: 12345")
  })

  test("pino redaction paths censor the key wherever it is a field", () => {
    const records: string[] = []
    const stream = { write: (line: string) => void records.push(line) }
    const testLogger = pino(
      { redact: { paths: [...REDACT_PATHS], censor: "***" } },
      stream as never
    )

    testLogger.info({ key: SECRET }, "top level")
    testLogger.info({ key: SECRET, requestKey: "not-a-redacted-name" }, "nested")
    testLogger.info({ deep: { nested: { key: SECRET } } }, "deep")
    testLogger.info({ apiKey: SECRET }, "camel case")
    testLogger.info({ authorization: `Bearer ${SECRET}` }, "authorization")
    testLogger.info({ req: { headers: { authorization: SECRET } } }, "request headers")

    const serialized = records.join("\n")
    expect(serialized).not.toContain(SECRET)
    expect(serialized).toContain("***")
  })

  test("redactSecrets covers the values pino cannot reach (logged URLs)", () => {
    // pino redacts fields, not substrings: a URL logged as a string keeps the
    // key unless it is passed through redactSecrets first.
    const records: string[] = []
    const stream = { write: (line: string) => void records.push(line) }
    const testLogger = pino(
      { redact: { paths: [...REDACT_PATHS], censor: "***" } },
      stream as never
    )

    testLogger.info({
      url: redactSecrets(`https://api.stackexchange.com/2.3/search?key=${SECRET}&site=so`),
    })

    expect(records.join("\n")).not.toContain(SECRET)
    expect(records.join("\n")).toContain("key=***")
  })
})
