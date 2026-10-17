#!/usr/bin/env node
/**
 * Opt-in live check against the real Stack Exchange API.
 *
 * Responsibility: prove the deployed artifact still talks to the real API, and
 * prove it does so within a **hard API-call budget**. This is the only script
 * that spends quota, so it is opt-in and refuses to run without an explicit
 * acknowledgement.
 *
 * Why a budget assertion: the anonymous allowance is roughly 300 requests per day
 * per IP, shared by everything that runs from this address. A live check that
 * silently grew from 3 calls to 30 would be a real cost, so the script reads the
 * server's own quota resource before and after and fails if it overspent.
 *
 * Usage:
 *   SO_LIVE=1 npm run test:live          # spends up to 10 Stack Exchange requests
 *
 * Environment:
 *   SO_LIVE=1          required, the acknowledgement that real quota will be used
 *   SO_LIVE_BUDGET     optional, max upstream requests (default 10)
 *   STACKOVERFLOW_API_KEY  optional, raises the daily allowance from ~300 to ~10,000
 *   site               fixed to stackoverflow
 *
 * Exit codes:
 *   0  checks passed (or the run was skipped because SO_LIVE was not set)
 *   1  a check failed, or the call budget was exceeded
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"

if (process.env.SO_LIVE !== "1") {
  console.log("Skipping live check: set SO_LIVE=1 to spend real Stack Exchange quota.")
  process.exit(0)
}

const BUDGET = Number.parseInt(process.env.SO_LIVE_BUDGET ?? "10", 10)
const RESULTS = []
let failures = 0

function check(label, ok, detail = "") {
  RESULTS.push({ label, ok, detail })
  if (!ok) {
    failures += 1
  }
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`)
}

/**
 * Reads the server's own quota resource.
 *
 * @returns `{ remaining, max }`, both `null` until the process has seen a response.
 */
async function readQuota(client) {
  const resource = await client.readResource({ uri: "stackoverflow://quota" })
  const first = resource.contents[0]
  const text = typeof first?.text === "string" ? first.text : "{}"
  const payload = JSON.parse(text)
  return {
    remaining: payload.quota?.remaining ?? null,
    max: payload.quota?.max ?? null,
  }
}

/**
 * The environment handed to the child.
 *
 * `StdioClientTransport` does **not** inherit the parent environment: without
 * `env` it passes only the SDK's safe default subset, so `STACKFLOW_API_KEY`
 * never reached the server and a "live check with a key" silently spent the
 * anonymous per-IP allowance instead. Passing the defined variables through
 * explicitly is what makes the key take effect.
 */
const childEnv = Object.fromEntries(
  Object.entries(process.env).filter(([, value]) => value !== undefined)
)

const transport = new StdioClientTransport({
  command: "node",
  args: ["build/index.js"],
  env: childEnv,
})
const client = new Client({ name: "live-check", version: "1.0.0" })

try {
  await client.connect(transport)
  console.log(
    `Live check against the real API (budget: ${BUDGET} requests, key ${
      process.env.STACKOVERFLOW_API_KEY ? "configured" : "absent"
    })`
  )

  const before = await readQuota(client)
  // A null reading means the process has not seen an API response yet, which is
  // exactly the state a fresh process starts in.
  check(
    "quota is unknown before the first API call",
    before.remaining === null,
    `remaining=${before.remaining}`
  )

  const errorSearch = await client.callTool({
    name: "search_by_error",
    arguments: { errorMessage: "TypeError: cannot read property of undefined", limit: 2 },
  })
  check(
    "search_by_error returns results",
    errorSearch.isError !== true && errorSearch.content.length > 0
  )

  // Baseline for the budget assertion. Taken *after* the first call, because a
  // figure only exists once a response has been seen; the delta therefore covers
  // the calls that follow it.
  const baseline = await readQuota(client)

  const tagged = await client.callTool({
    name: "search_by_tags",
    arguments: { tags: ["javascript", "promises"], limit: 2 },
  })
  check("search_by_tags returns results", tagged.isError !== true && tagged.content.length > 0)

  const question = await client.callTool({
    name: "search_by_question_id",
    arguments: { questionId: 11227809, includeAnswers: true },
  })
  check(
    "search_by_question_id returns a question with answers",
    question.isError !== true && question.structuredContent?.results !== undefined
  )

  const after = await readQuota(client)
  const spent =
    baseline.remaining === null || after.remaining === null
      ? null
      : baseline.remaining - after.remaining
  check(
    "a quota figure is reported after the calls",
    typeof after.remaining === "number",
    `remaining=${after.remaining}/${after.max}`
  )
  // Only the upper bound is asserted. Stack Exchange reports `quota_remaining`
  // with some lag for a keyed request, so a lower bound would fail spuriously;
  // the exact per-tool call counts are pinned instead by `fetchCounts.test.ts`.
  check(
    `spent no more than ${BUDGET} requests`,
    spent !== null && spent >= 0 && spent <= BUDGET,
    spent === null ? "delta unknown" : `spent=${spent}, ${baseline.remaining} -> ${after.remaining}`
  )
  if (process.env.STACKOVERFLOW_API_KEY) {
    // The keyed allowance is 10,000/day and the anonymous one ~300/day, so a
    // reported maximum above 300 proves the key reached the child process.
    check("the API key reached the server", (after.max ?? 0) > 300, `max=${after.max}`)
  }
} catch (error) {
  check("live run completed without throwing", false, String(error))
} finally {
  await client.close().catch(() => undefined)
}

console.log(`\n${RESULTS.length - failures}/${RESULTS.length} checks passed`)
if (failures > 0) {
  console.error(`${failures} check(s) failed`)
  process.exitCode = 1
}
