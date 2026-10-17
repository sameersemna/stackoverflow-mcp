#!/usr/bin/env node
/**
 * Creates the custom Stack Exchange API filter used by this server.
 *
 * The official docs state (https://api.stackexchange.com/docs/filters):
 *
 *   "Filters are immutable and non-expiring. An application can safely 'bake in'
 *    any filters that are created, it is not necessary (or advisable) to create
 *    filters at runtime."
 *
 * and for /filters/create: "It is not expected that many applications will call
 * this method at runtime, filters should be pre-calculated and 'baked in'."
 *
 * So this script is run **once, by hand**, and its output is committed as a
 * constant in `src/stackexchange/filters.ts`. It is deliberately not part of the
 * server, the test suite, or CI.
 *
 * Usage:
 *   node scripts/create-filter.mjs            # uses STACKOVERFLOW_API_KEY from the env
 *   node scripts/create-filter.mjs --verify   # also proves the filter inlines answers
 *
 * Costs 1 API request to create, plus 1 more with --verify.
 */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const API = "https://api.stackexchange.com/2.3"

/** Fields the server needs in a single response instead of several round trips. */
const INCLUDE = [
  "question.body",
  "question.answers",
  "question.comments",
  "answer.body",
  "comment.body",
  "question.accepted_answer_id",
  "total",
].join(";")

function loadApiKey() {
  if (process.env.STACKOVERFLOW_API_KEY) {
    return process.env.STACKOVERFLOW_API_KEY
  }
  try {
    const envFile = readFileSync(fileURLToPath(new URL("../.env", import.meta.url)), "utf8")
    const match = /^STACKOVERFLOW_API_KEY=(.*)$/m.exec(envFile)
    return match ? match[1].replace(/^['"]|['"]$/g, "") : undefined
  } catch {
    return undefined
  }
}

const apiKey = loadApiKey()
const withKey = (params) => {
  if (apiKey) {
    params.set("key", apiKey)
  }
  return params
}

async function createFilter() {
  const params = withKey(
    new URLSearchParams({ include: INCLUDE, base: "default", unsafe: "false" })
  )
  const response = await fetch(`${API}/filters/create?${params}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    // The docs recommend POST when the parameter list grows large.
    body: params.toString(),
  })
  const payload = await response.json()

  if (payload.error_id) {
    throw new Error(`filter creation failed: ${payload.error_message} (${payload.error_id})`)
  }
  const filter = payload.items?.[0]
  if (!filter?.filter) {
    throw new Error(`unexpected response: ${JSON.stringify(payload).slice(0, 400)}`)
  }
  return filter.filter
}

async function verify(filter) {
  const params = withKey(new URLSearchParams({ site: "stackoverflow", filter, pagesize: "3" }))
  const response = await fetch(`${API}/search/advanced?${params}&q=pandas+dataframe`)
  const payload = await response.json()
  const question = payload.items?.[0]
  const answers = Array.isArray(question?.answers) ? question.answers : []

  console.log(`  quota: ${payload.quota_remaining}/${payload.quota_max}`)
  console.log(`  items: ${payload.items?.length ?? 0}`)
  console.log(`  first question has ${answers.length} inline answer(s)`)
  console.log(`  answer body inlined: ${answers.some((answer) => typeof answer.body === "string")}`)
  console.log(`  question body inlined: ${typeof question?.body === "string"}`)
  console.log(`  comments inlined: ${Array.isArray(question?.comments)}`)
  console.log(`  total returned: ${payload.total ?? "(absent)"}`)
}

const filter = await createFilter()
console.log(`filter id: ${filter}`)
console.log(`include:   ${INCLUDE}`)

if (process.argv.includes("--verify")) {
  console.log("verifying with one search request...")
  await verify(filter)
}
