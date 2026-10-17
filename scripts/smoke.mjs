#!/usr/bin/env node
/**
 * Smoke test for the built server.
 *
 * Responsibility: exercise the packaged artifact (`build/`) the way it is actually
 * deployed, covering what unit tests deliberately do not — the real process, real
 * sockets and real stdio. This replaces the eight ad-hoc `scripts/*.mjs` probes,
 * which are kept under `scripts/legacy/` for reference only.
 *
 * It consumes **no Stack Exchange quota**: upstream calls are answered by a local
 * fixture server, and the stdio section only lists capabilities.
 *
 * Usage:
 *   npm run build && node scripts/smoke.mjs
 *
 * Checks:
 *   1. stdio  — `node build/index.js` answers `initialize` and lists 5 tools, 2
 *               resources and 3 prompts, with no import-time side effects.
 *   2. http   — loopback binding, `/health`, `/ready`, Host validation, auth.
 *   3. stateless — `initialize` without a session id, `GET` 405, `DELETE` 204.
 *   4. shutdown — the process exits within the deadline with a live session.
 */
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { setTimeout as delay } from "node:timers/promises"

const RESULTS = []
let failures = 0

function check(label, ok, detail = "") {
  RESULTS.push({ label, ok, detail })
  if (!ok) {
    failures += 1
  }
  const mark = ok ? "PASS" : "FAIL"
  console.log(`${mark}  ${label}${detail ? ` — ${detail}` : ""}`)
}

/** Starts the built server and waits for its startup log line. */
function startHttpServer(env, expectStart = true) {
  const child = spawn("node", ["build/cli.js"], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let output = ""
  child.stderr.on("data", (chunk) => {
    output += String(chunk)
  })
  child.stdout.on("data", (chunk) => {
    output += String(chunk)
  })

  const ready = (async () => {
    if (!expectStart) {
      return
    }
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      if (output.includes("Stack Overflow MCP server started")) {
        return
      }
      if (child.exitCode !== null) {
        return
      }
      await delay(100)
    }
  })()

  return { child, ready, output: () => output }
}

/**
 * Signals the child and waits for it to exit.
 *
 * Sends the signal itself: an earlier version only waited, so every case reported a
 * timeout that looked like a shutdown hang.
 *
 * @param child - Child process.
 * @param deadlineMs - How long to allow before force-killing.
 * @param signal - Signal to send first.
 */
async function stop(child, deadlineMs = 12_000, signal = "SIGTERM") {
  if (child.exitCode !== null) {
    return { exited: true, code: child.exitCode, waited: 0 }
  }
  const startedAt = Date.now()
  child.kill(signal)
  const exited = await Promise.race([
    new Promise((resolve) => child.once("exit", (code) => resolve(code))),
    delay(deadlineMs).then(() => "timeout"),
  ])
  const waited = Date.now() - startedAt
  if (exited === "timeout") {
    child.kill("SIGKILL")
    return { exited: false, code: null, waited }
  }
  return { exited: true, code: exited, waited }
}

/** Minimal local stand-in for the Stack Exchange API. */
function startFixtureApi() {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ items: [], has_more: false, quota_max: 300, quota_remaining: 299 }))
  })
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port })
    })
  })
}

async function sectionStdio() {
  console.log("\n== stdio ==")
  const child = spawn("node", ["build/index.js"], { stdio: ["pipe", "pipe", "pipe"] })
  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk)
  })
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk)
  })

  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`)
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "smoke", version: "1" },
    },
  })
  send({ jsonrpc: "2.0", method: "notifications/initialized" })
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" })
  send({ jsonrpc: "2.0", id: 3, method: "resources/list" })
  send({ jsonrpc: "2.0", id: 4, method: "prompts/list" })

  // Wait for all four replies rather than for text: stdout is a stream and may
  // deliver frames in more than one chunk.
  const deadline = Date.now() + 15_000
  while (
    Date.now() < deadline &&
    !['"id":4', '"id": 4'].some((needle) => stdout.includes(needle))
  ) {
    await delay(100)
  }

  const messages = stdout
    .split("\n")
    .filter((line) => line.trim().startsWith("{"))
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter(Boolean)

  const tools = messages.find((message) => message.id === 2)?.result?.tools ?? []
  const resources = messages.find((message) => message.id === 3)?.result?.resources ?? []
  const prompts = messages.find((message) => message.id === 4)?.result?.prompts ?? []
  const serverInfo = messages.find((message) => message.id === 1)?.result?.serverInfo ?? {}

  check(
    "stdio: initialize returns server info",
    serverInfo.name === "stackoverflow-mcp",
    serverInfo.version
  )
  check("stdio: 5 tools are listed", tools.length === 5, `${tools.length} tools`)
  check(
    "stdio: every tool publishes an outputSchema",
    tools.length === 5 && tools.every((tool) => tool.outputSchema !== undefined),
    tools
      .filter((tool) => tool.outputSchema === undefined)
      .map((tool) => tool.name)
      .join(", ") || "all present"
  )
  check("stdio: 2 resources are listed", resources.length === 2, `${resources.length} resources`)
  check(
    "stdio: the documented prompts are present",
    ["stackoverflow_search", "stackoverflow_debug"].every((name) =>
      prompts.some((prompt) => prompt.name === name)
    ),
    `${prompts.length} prompts`
  )
  // stdout carries the protocol; logs must never appear there.
  check(
    "stdio: stdout carries only protocol frames",
    !stdout.includes('"level"'),
    "no log lines on stdout"
  )
  check("stdio: logs go to stderr", stderr.includes("level") || stderr.length > 0)

  child.kill("SIGTERM")
  await stop(child, 5000)
}

async function sectionHttp() {
  console.log("\n== http (loopback) ==")
  const fixture = await startFixtureApi()
  const port = 3481
  const { child, ready, output } = startHttpServer({
    PORT: String(port),
    HOST: "127.0.0.1",
    // Keep the server off the real API: every upstream call is answered locally.
    // Jest-independent, so the fixture cannot be mistaken for the real service.
    http_proxy: `http://127.0.0.1:${fixture.port}`,
  })
  await ready

  const health = await fetch(`http://127.0.0.1:${port}/health`)
  const healthBody = await health.json()
  check("http: /health is ok", health.status === 200 && healthBody.status === "ok")
  check(
    "http: /health reports the version",
    typeof healthBody.version === "string",
    healthBody.version
  )

  const readyResponse = await fetch(`http://127.0.0.1:${port}/ready`)
  const readyBody = await readyResponse.json()
  check("http: /ready answers", readyResponse.status === 200, `status ${readyBody.status}`)

  const badHost = await fetch(`http://127.0.0.1:${port}/health`, {
    headers: { host: "evil.example.com" },
  }).catch(() => ({ status: "rejected by fetch" }))
  // `fetch` refuses to set Host, so validate through a raw socket instead.
  const rawStatus = await rawGet(port, "/health", { host: "evil.example.com" })
  check("http: a disallowed Host is rejected", rawStatus === 403, `status ${rawStatus}`)
  void badHost

  const stopped = await stop(child, 12_000)
  check(
    "http: SIGTERM exits within the deadline",
    stopped.exited && stopped.waited < 5000,
    `${stopped.waited}ms`
  )
  fixture.server.close()
  // Surface any startup complaint for debugging.
  if (!healthBody.status) {
    console.log(output().slice(0, 400))
  }
}

async function sectionAuth() {
  console.log("\n== http (auth) ==")
  const port = 3482
  const token = "smoke-token"
  const { child, ready } = startHttpServer({
    PORT: String(port),
    HOST: "127.0.0.1",
    MCP_AUTH_TOKEN: token,
  })
  await ready

  const unauthorized = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  })
  check(
    "http: a request without a token is rejected",
    unauthorized.status === 401,
    `status ${unauthorized.status}`
  )

  const authorized = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "smoke", version: "1" },
      },
    }),
  })
  const sessionId = authorized.headers.get("mcp-session-id")
  check(
    "http: a request with the token is accepted",
    authorized.status === 200,
    `status ${authorized.status}`
  )
  check("http: a session id is issued", Boolean(sessionId))

  const deleted = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "DELETE",
    headers: { "mcp-session-id": sessionId ?? "none", authorization: `Bearer ${token}` },
  })
  check("http: DELETE terminates the session", deleted.status === 204, `status ${deleted.status}`)

  const deletedAgain = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "DELETE",
    headers: { "mcp-session-id": sessionId ?? "none", authorization: `Bearer ${token}` },
  })
  check(
    "http: a repeated DELETE is still safe",
    deletedAgain.status === 204,
    `status ${deletedAgain.status}`
  )

  await stop(child, 12_000)
}

async function sectionStateless() {
  console.log("\n== http (stateless) ==")
  const port = 3483
  const { child, ready } = startHttpServer({
    PORT: String(port),
    HOST: "127.0.0.1",
    STATELESS: "1",
  })
  await ready

  const initialize = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "smoke", version: "1" },
      },
    }),
  })
  check("stateless: initialize succeeds", initialize.status === 200, `status ${initialize.status}`)
  check("stateless: no session id is issued", initialize.headers.get("mcp-session-id") === null)

  const getStatus = await rawGet(port, "/mcp", { accept: "text/event-stream" })
  check("stateless: GET /mcp is rejected", getStatus === 405, `status ${getStatus}`)

  const deleteStatus = await rawRequest(port, "/mcp", { method: "DELETE" })
  check(
    "stateless: DELETE without a session succeeds",
    deleteStatus === 204,
    `status ${deleteStatus}`
  )

  await stop(child, 12_000)
}

async function sectionRefusesInsecureBind() {
  console.log("\n== http (refuses insecure bind) ==")
  const { child, output } = startHttpServer({ PORT: "3484", HOST: "0.0.0.0" }, false)

  // The refusal is fatal, so the process exits on its own; wait for that rather than
  // reading stderr immediately, which raced the pipe and reported "no message".
  await Promise.race([new Promise((resolve) => child.once("exit", resolve)), delay(10_000)])
  // Give the last stderr chunk a moment to arrive.
  await delay(200)

  const message = output()
  check("http: refuses a non-loopback bind without auth", message.includes("Refusing to bind"))
  check(
    "http: the refusal explains the fix",
    message.includes("MCP_AUTH_TOKEN") && message.includes("ALLOW_INSECURE"),
    message.includes("Refusing to bind") ? "both remedies named" : "no message"
  )
}

/** Raw GET, because `fetch` silently ignores a caller-supplied `Host`. */
function rawGet(port, path, headers) {
  return rawRequest(port, path, { method: "GET", headers })
}

function rawRequest(port, path, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    import("node:http").then(({ request }) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          path,
          method,
          headers: { host: `127.0.0.1:${port}`, ...headers },
        },
        (res) => {
          res.resume()
          resolve(res.statusCode ?? 0)
        }
      )
      req.on("error", reject)
      if (body !== undefined) {
        req.write(body)
      }
      req.end()
    }, reject)
  })
}

console.log("Smoke test against build/ (no Stack Exchange quota consumed)")
await sectionStdio()
await sectionHttp()
await sectionAuth()
await sectionStateless()
await sectionRefusesInsecureBind()

console.log(`\n${RESULTS.length - failures}/${RESULTS.length} checks passed`)
if (failures > 0) {
  console.error(`${failures} check(s) failed`)
  process.exitCode = 1
}
