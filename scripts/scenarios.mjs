#!/usr/bin/env node
/**
 * Scenario measurements against the built artifact.
 *
 * Responsibility: produce the numbers the hardening brief asks for, from the compiled
 * output rather than from the sources or from memory — three scenarios that the original
 * code got wrong and that only appear under concurrency or at scale:
 *
 *   1. Concurrency — 60 simultaneous searches must not all be admitted at once.
 *      The original limiter read the shared timestamp list, awaited, and only then
 *      recorded its own request, so 60 concurrent callers measured **60 admissions in
 *      41 ms** against a 25/s limit. That is B1, and it is the reason admission is
 *      reserved synchronously.
 *   2. Answers at scale — 30 questions with 150 answers must come back complete, and
 *      from one search request rather than one request per question.
 *   3. More than 100 vectorized IDs — the API caps a vectorized request at 100
 *      semicolon-separated IDs, so a set of 180 must be chunked. B2.
 *
 * Upstream traffic is answered by a local stub; this script spends **no** Stack Exchange
 * quota and needs no network. It is deterministic apart from the concurrency timing, which
 * is measured rather than asserted against a hard clock (the assertion is on the number of
 * admissions inside a window, which is the property that matters).
 *
 * Usage:
 *   npm run build && node scripts/scenarios.mjs
 */
import { RateLimiter } from "../build/core/rateLimiter.js"
import { ResponseCache } from "../build/core/cache.js"
import { QuotaTracker } from "../build/core/quota.js"
import { StackOverflowServer } from "../build/server.js"

const RESULTS = []
let failures = 0

function check(label, ok, detail = "") {
  RESULTS.push({ label, ok, detail })
  if (!ok) failures += 1
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`)
}

function heading(text) {
  console.log(`\n${text}`)
}

// ---------------------------------------------------------------------------
// A recording fetch stub, as every suite uses. Intercepts only the upstream API.
// ---------------------------------------------------------------------------

const calls = []
/** Totals the stub actually served, so the API-shape claim can be checked independently
 * of what survives output truncation. */
const served = { questions: 0, answers: 0 }
const realFetch = globalThis.fetch

/** Builds one Stack Exchange response envelope. */
function envelope(items, overrides = {}) {
  return {
    items,
    has_more: false,
    quota_max: 300,
    quota_remaining: 250,
    ...overrides,
  }
}

function question(id) {
  return {
    question_id: id,
    title: `Question ${id}`,
    body: `<p>body ${id}</p>`,
    score: 1,
    answer_count: 5,
    is_answered: true,
    creation_date: 1615000000,
    tags: ["javascript"],
    link: `https://stackoverflow.com/q/${id}`,
  }
}

function answer(id, questionId) {
  return {
    answer_id: id,
    question_id: questionId,
    score: 1,
    is_accepted: id === questionId * 1000 + 1,
    body: `<p>answer ${id}</p>`,
    creation_date: 1615100000,
    link: `https://stackoverflow.com/a/${id}`,
  }
}

const QUESTIONS = 30
const ANSWERS_PER_QUESTION = 5

/** Installs a stub that answers whichever upstream path is requested. */
function installStub() {
  calls.length = 0
  served.questions = 0
  served.answers = 0
  globalThis.fetch = async (input) => {
    const url = new URL(String(input))
    calls.push(url)

    if (url.pathname.endsWith("/search/advanced") || url.pathname.endsWith("/questions")) {
      const asked = Number.parseInt(url.searchParams.get("pagesize") ?? "30", 10)
      const wanted = Math.min(asked, QUESTIONS)
      const items = []
      for (let i = 1; i <= wanted; i += 1) {
        const inline = []
        for (let a = 1; a <= ANSWERS_PER_QUESTION; a += 1) {
          inline.push(answer(i * 1000 + a, i))
        }
        // The baked-in custom filter returns answers inline, which is what makes one
        // search request enough.
        items.push({ ...question(i), answers: inline })
        served.questions += 1
        served.answers += inline.length
      }
      return new Response(JSON.stringify(envelope(items)), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }

    // Vectorized answers and comments, used when a filter path cannot inline them.
    const ids = (url.pathname.split("/").at(-2) ?? "").split(";").filter(Boolean)
    const items = ids.map((raw, index) => {
      const id = Number.parseInt(raw, 10)
      return url.pathname.includes("comments")
        ? {
            comment_id: index + 1,
            post_id: id,
            score: 1,
            body: `<p>comment on ${id}</p>`,
            creation_date: 1615050000,
          }
        : answer(id, id)
    })
    return new Response(JSON.stringify(envelope(items)), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }
}

function restoreStub() {
  globalThis.fetch = realFetch
}

/** A server with its own collaborators, so scenarios cannot affect each other. */
function makeServer(overrides = {}) {
  return new StackOverflowServer({
    limiter: new RateLimiter({ capacity: 25, windowMs: 1000, minDelayMs: 0 }),
    cache: new ResponseCache(),
    quota: new QuotaTracker({ hasApiKey: () => false }),
    ...overrides,
  })
}

// ---------------------------------------------------------------------------
// Scenario 1 — 60 concurrent searches against a 25/s limit
// ---------------------------------------------------------------------------

async function scenarioConcurrency() {
  heading("Scenario 1 — 60 concurrent searches against a 25/s admission limit")

  const limiter = new RateLimiter({ capacity: 25, windowMs: 1000, minDelayMs: 0 })
  const admissions = []
  const startedAt = Date.now()

  const work = Array.from({ length: 60 }, async (_unused, index) => {
    await limiter.acquire(`scenario-${index}`)
    admissions.push(Date.now())
    return index
  })

  const results = await Promise.all(work)
  const elapsed = Date.now() - startedAt

  const windows = [0, 100, 200, 300, 400].map((offset) => {
    const from = startedAt + offset
    return admissions.filter((at) => at >= from && at < from + 1000).length
  })
  const worst = Math.max(...windows)

  check(
    "all 60 calls completed",
    results.length === 60,
    `${results.length} results in ${elapsed} ms`
  )
  check(
    "no 1-second window admitted more than the 25/s limit",
    worst <= 25,
    `worst window=${worst}, measured over 5 offsets from the first admission`
  )
  console.log(
    `      measured: ${admissions.length} admissions in ${elapsed} ms ` +
      `(baseline was 60 admissions in 41 ms — every caller passed)`
  )
}

// ---------------------------------------------------------------------------
// Scenario 2 — 30 questions with 150 answers
// ---------------------------------------------------------------------------

async function scenarioAnswersAtScale() {
  heading(`Scenario 2 — ${QUESTIONS} questions with ${QUESTIONS * ANSWERS_PER_QUESTION} answers`)

  installStub()
  try {
    const server = makeServer()

    // (a) A full page: 30 questions, five answers each. The upstream response offers all
    // of it in one request; the 25,000-character output budget then drops trailing rows,
    // which the payload must admit rather than hide.
    const large = await server.handleSearchByQuery({
      query: "TypeError: x is not a function",
      limit: QUESTIONS,
      responseFormat: "json",
    })
    const largePayload = JSON.parse(large.content[0].text)
    const searchCalls = calls.filter((url) => url.pathname.includes("search")).length
    const perQuestionCalls = calls.filter((url) => url.pathname.includes("/answers")).length

    check(
      "one upstream request served every question and answer",
      served.questions === QUESTIONS &&
        served.answers === QUESTIONS * ANSWERS_PER_QUESTION &&
        calls.length === 1,
      `served ${served.questions} questions / ${served.answers} answers in ${calls.length} request(s)`
    )
    check(
      "no per-question answers request was needed",
      perQuestionCalls === 0,
      `answers requests=${perQuestionCalls}, search requests=${searchCalls}`
    )
    check(
      "output truncation is reported, not silent",
      largePayload.truncated === true &&
        largePayload.results.length < QUESTIONS &&
        typeof largePayload.message === "string",
      `results=${largePayload.results.length}/${QUESTIONS}, truncated=${largePayload.truncated}`
    )

    // (b) A page that fits the budget: every answer offered must be present, and the
    // payload must say it was not truncated. This is the half that catches an artificial
    // per-question answer cap.
    calls.length = 0
    served.questions = 0
    served.answers = 0
    const small = await server.handleSearchByQuery({
      query: "TypeError: x is not a function",
      limit: 3,
      responseFormat: "json",
    })
    const smallPayload = JSON.parse(small.content[0].text)
    const answersReturned = smallPayload.results.reduce(
      (sum, row) => sum + (row.answers?.length ?? 0),
      0
    )

    check(
      "every answer of the returned questions is present",
      answersReturned === smallPayload.results.length * ANSWERS_PER_QUESTION,
      `${answersReturned} answers across ${smallPayload.results.length} questions`
    )
    check(
      "a page that fits the budget is not marked truncated",
      smallPayload.truncated !== true,
      `truncated=${smallPayload.truncated ?? false}, ${calls.length} request(s)`
    )
    console.log(
      `      measured: large page = 1 request, truncated to ${largePayload.results.length} of ` +
        `${QUESTIONS} questions and reported as such; small page = ${calls.length} request, complete`
    )
  } finally {
    restoreStub()
  }
}

// ---------------------------------------------------------------------------
// Scenario 3 — more than 100 vectorized IDs
// ---------------------------------------------------------------------------

async function scenarioVectorLimit() {
  heading("Scenario 3 — more than 100 vectorized IDs in one logical request")

  installStub()
  try {
    const server = makeServer()
    // `acceptedOnly` deliberately uses the built-in filter, which cannot inline answers,
    // so the answers path must fetch them by ID. With 30 questions that is 30 IDs; force
    // the vectorized path across a larger set by asking for comments on questions plus
    // every answer, which is the case B2 describes (505 IDs at the old default page size).
    const result = await server.handleSearchByQuery({
      query: "TypeError: x is not a function",
      limit: QUESTIONS,
      includeComments: true,
      acceptedOnly: true,
      responseFormat: "json",
    })

    check("the call succeeded", result.isError !== true)

    const vectorized = calls.filter((url) => /\/[\d;]+\//.test(url.pathname))
    const sizes = vectorized.map((url) => url.pathname.split("/").at(-2).split(";").length)
    const largest = sizes.length > 0 ? Math.max(...sizes) : 0

    check(
      "no vectorized request exceeded the 100-ID cap",
      largest <= 100,
      `largest=${largest}, requests=${vectorized.length}, sizes=[${sizes.join(", ")}]`
    )
    console.log(
      `      measured: ${calls.length} upstream request(s), ` +
        `largest vector=${largest} IDs (cap is 100)`
    )
  } finally {
    restoreStub()
  }
}

// ---------------------------------------------------------------------------

console.log("Scenario measurements against build/ (no Stack Exchange quota consumed)")
await scenarioConcurrency()
await scenarioAnswersAtScale()
await scenarioVectorLimit()

console.log(`\n${RESULTS.length - failures}/${RESULTS.length} checks passed`)
if (failures > 0) {
  console.error(`${failures} check(s) failed`)
  process.exitCode = 1
}
