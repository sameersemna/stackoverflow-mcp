## Current phase: 3 — Shared core (rate limiter, cache, quota, HTTP client)
## Current step: 3.1 — sequential-thinking + architect → ADR 0002, then B1 (rate limiter)
## Status: in-progress
## Last green commit: `e327883` (19 suites, 103 passed, 1 skipped, 2 snapshots; tsc ✓; build ✓)

### Phase 2 gate: PASSED (2026-10-17)

Pure refactor, verified by construction: the **contract snapshot and the
fetch-count budget passed unchanged after every commit**, which is what a
behaviour-preserving move looks like. `src/server.ts` went from 2,089 to 1,389
lines.

| Commit | Move |
|---|---|
| `86ad09d` | `src/format/` — html, truncate, limits, json, markdown; `formatResponse` is now a dispatcher |
| `408d346` | `src/stackexchange/query.ts` — query variants, error extraction, stack-trace tables |
| `22ea165` | `src/config.ts` (single source of env) + `src/stackexchange/filters.ts` |
| `6677bf3` | `src/resources.ts`, `src/prompts.ts`, `src/transports/http.ts`; `cli.ts` 258 → 46 lines |
| `e327883` | `src/core/http.ts` (redaction + retry timing), `src/tools/schemas.ts` |

**How the refactor was proven to be output-preserving.** A golden dump of the
formatter output was generated from a pristine `git worktree` at the parent
commit and from the refactored tree, for seven scenarios (JSON with/without
notes and `totalCount`, Markdown with/without notes, empty results, and both
truncation paths). The two 29 KB dumps are **identical** (`diff` clean). The
semantics are now pinned permanently by `formattingFidelity.test.ts` (9 tests),
which must not be regenerated casually: a failure there means the output contract
changed and needs a CHANGELOG entry.

**Two decisions worth remembering:**

1. All 17 existing test suites still import from `server.ts`, which re-exports
   the moved symbols. This is the facade decision in ADR 0001; it means a Phase 2
   regression could never be confused with an import-path mistake.
2. `core/rateLimiter.ts`, `core/cache.ts`, `core/quota.ts` and
   `stackexchange/client.ts` were **not** created as wrappers. They are authored
   in Phase 3 as real modules, when the limiter/cache/quota become process-wide
   singletons with injected dependencies. ADR 0001 records this as a deliberate
   choice to avoid writing throwaway code twice.

**New in Phase 2:** `config.ts` validates environment variables and reports
violations with the variable name and rule. Verified:
`PORT=abc node build/cli.js` → `Invalid environment configuration: PORT: must be
a non-negative integer`. Also verified by smoke test: HTTP mode on `:3099`
answered `/health` and a valid `initialize`, and stdio mode still returns live
results.

## Phase checklist

- [x] Phase 0 — Baseline and safety net (branch, ledger, inventory, baseline green, contract snapshot, fetch harness)
- [x] Phase 1 — Remove import side effect and fix isolated bugs (B2, B3, B4, B5, B6, B7, B8, B9, B10, B12, B14)
- [x] Phase 2 — Modularize (pure refactor) — see ADR 0001
- [ ] Phase 3 — Shared core (rate limiter, cache, quota, HTTP client)
- [ ] Phase 4 — API-call reduction
- [ ] Phase 5 — MCP protocol polish
- [ ] Phase 6 — HTTP transport hardening
- [ ] Phase 7 — Config, logging, security pass
- [ ] Phase 8 — Tooling and CI
- [ ] Phase 9 — Packaging and deployment artifacts
- [ ] Phase 10 — Documentation
- [ ] Phase 11 — Final verification and handoff

## Environment

- Repo: `/home/sameer/Shared/Sync/Private/Apps/services/mcp/stackoverflow-mcp`
- Branch: `hardening/v0.3` (off `main` @ `ec00d96`)
- Node v26.3.0, npm 9.2.0 (systemd unit pins node 26.3.0)
- `node_modules` present, `package-lock.json` present (208 KB). No yarn/pnpm lock.
- Baseline (verified 2026-10-17): `npx tsc --noEmit` exit 0; `npm test` → **8 suites, 30 passed, 1 skipped, 0 failed**.

## Surface inventory (baseline `ec00d96`)

Verified by reading `src/index.ts` (1,877 lines, single file) and `src/types/index.ts`.

### Tools (5) — all `readOnlyHint: true, idempotentHint: true, openWorldHint: true`, no `destructiveHint`

| Tool | Params (registration `inputSchema`) | Strictness actually enforced |
|---|---|---|
| `search_by_error` | `errorMessage` (req), `language?`, `technologies?[]`, `minScore?`, `includeComments?`, `responseFormat?`, `limit?`, `page?` | zod in `types/` adds trim/min(1)/max(2000), int/positive/max(100), nonnegative |
| `search_by_tags` | `tags` (req, string[]), `minScore?`, `includeComments?`, `responseFormat?`, `limit?`, `page?` | `tags` min(1) |
| `analyze_stack_trace` | `stackTrace` (req), `language` (req), `includeComments?`, `responseFormat?`, `limit?`, `page?` | max(10000) |
| `search_by_query` | `query` (req), `tags?[]`, `minScore?`, `acceptedOnly?`, `includeComments?`, `responseFormat?`, `limit?`, `page?` | max(2000) |
| `search_by_question_id` | `questionId` (req), `includeAnswers?` (default true), `includeComments?`, `responseFormat?` | int/positive |

**3.5 confirmed:** the registration `inputSchema` is a hand-written duplicate that does **not** advertise `max(100)`, `int()`, `positive()`, `nonnegative()`, `min(1)`, `max(2000)`, `max(10000)`. LLMs cannot see the limits.

### Resources (2)
- `server-status` → `stackoverflow://status` (service, version, transport, apiKeyConfigured, timestamp)
- `api-quota` → `stackoverflow://quota` (maxRequestsPerSecond, minDelayBetweenRequestsMs, quotaWarningThreshold, cacheTtlMs, activeBackoffs, timestamp)
- Server capabilities declare `tools/resources/prompts` only — **no `notifications`**, so resource-updated notifications are not advertised.

### Prompts (2)
- `stackoverflow_search` (`query` req, `language` opt)
- `stackoverflow_debug` (`errorMessage` req, `language` req)

### Baseline constants
`MAX_REQUESTS_PER_SECOND=25`, `RATE_LIMIT_WINDOW_MS=1000`, `MIN_DELAY_BETWEEN_REQUESTS_MS=40`, `RETRY_AFTER_MS=100`, `QUOTA_WARNING_THRESHOLD=100`, `CHARACTER_LIMIT=25000`, `MAX_ANSWERS=5`, `MAX_QUESTION_BODY_CHARS=5000`, `MAX_ANSWER_BODY_CHARS=3000`, `cacheTtlMs=5*60*1000`.
Filters: `DEFAULT_FILTER='withbody'`, `ANSWER_FILTER='withbody'`, `COMMENT_FILTER='default'`.

## API-call budget table (tool → calls per invocation)

Baseline numbers read from source. "worst" = every query variant empty until the last, plus tag relaxation.

| Tool | Search | Answers | Comments | Worst total | Best total | Notes |
|---|---|---|---|---|---|---|
| `search_by_error` | ≤5 | 1 | 0–1 | **7** | **2** | 4 query variants + 1 tag-relax attempt |
| `analyze_stack_trace` | ≤5 | 1 | 0–1 | **7** | **2** | same variant ladder |
| `search_by_query` | ≤5 | 1 | 0–1 | **7** | **2** | same |
| `search_by_tags` | 1 | 1 | 0–1 | **3** | **2** | no variant ladder |
| `search_by_question_id` | 1 | 1 | 0–1 | **3** | **2** | `includeAnswers:false` → 1 |

**With `includeComments:true` the worst case is unbounded today** because comment IDs (questions + *all* answers) are passed in one vectorized call and are not chunked (B2). At 5 results whose questions each return up to 100 answers, `postIds.length` reaches 505 in a single request.

**After (targets, Phase 4):** typical `search_by_error` ≤1–2 calls; `includeComments` ≤2; `search_by_question_id` ≤1.

### Verified upstream limits (to confirm against official docs in Phase 4)
- Vectorized requests (`/questions/{ids}/answers`, `/posts/{ids}/comments`): **max 100 semicolon-separated IDs per call** (source of B2).
- Default `pagesize` when unset: **30** (source of B5).
- Quota: ~300/day per IP without a key, ~10,000 with a key.
- Concurrency throttle: 30 req/s.
- `min` is rejected together with `sort=relevance` (`error_id 400`) — already handled in code.

## Bug evidence — measured at baseline (not assumed)

A temporary probe suite was run against `ec00d96` and deleted afterwards. Raw results:

| ID | Claim | Measured at baseline | Verdict |
|---|---|---|---|
| ★B1 | `checkRateLimit` not concurrency-safe | **60 concurrent admissions in 41 ms** with a 25/s limit (task's independent measurement: 84 in the first second) | **CONFIRMED** |
| ★B2 | Comment ID list not chunked to ≤100 | **1 request with 144 semicolon-separated IDs** (4 questions + 160 answers) to `/posts/…/comments` | **CONFIRMED** (real API would reject) |
| ★B6 | `createErrorResponse` doesn't redact `key=` | `…&key=SECRET123` **passed through verbatim** (`leaks SECRET123: true`) | **CONFIRMED** |
| B5 | No default `limit` | `limit` unset → **no `pagesize` param at all**, so the API default of 30 applies: `site=stackoverflow&sort=relevance&order=desc&filter=withbody&q=boom` | **CONFIRMED** |

## Additional Phase 0 findings (new, not in the original audit)

- **Config is frozen at module load.** `runtimeEnvSchema.parse(...)` runs at import time, so `STACKFLOW_API_KEY`/`PORT` cannot be injected per instance; a test that sets the env var after import gets no key. `fetchCounts.test.ts` documents this and works around it with `jest.resetModules()`. Fixing it properly is Phase 7 (`config.ts` + injected deps). This is what blocks the "dependencies injected (clock, fetch, config)" style rule in §6.
- **The contract snapshot revealed a third published field:** the SDK advertises `execution: { taskSupport: 'forbidden' }` for every tool. Harmless, but it must stay in the snapshot baseline.
- **Schema drift confirmed with evidence:** the published `search_by_error` schema shows `errorMessage: { type: 'string' }` with **no `maxLength`**, and `limit: { type: 'number' }` with **no `integer`/`minimum`/`maximum`** — so the zod constraints in `src/types/index.ts` are invisible to clients (finding 3.5).


### MCP TypeScript SDK `@modelcontextprotocol/sdk@1.30.0` (verified against installed `.d.ts`/`.js`; context7 unavailable — see "Known issues")
- `McpServer.registerTool<OutputArgs, InputArgs>(name, config, cb)` with
  `config = { title?, description?, inputSchema?, outputSchema?, annotations?, _meta? }`.
  `inputSchema`/`outputSchema` accept `ZodRawShapeCompat | AnySchema`.
  Source: `node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.d.ts:150-157`.
- `ToolCallback` signature: `(args, extra: RequestHandlerExtra<ServerRequest, ServerNotification>) => CallToolResult | Promise<CallToolResult>` (`mcp.d.ts:250-261`).
- `RequestHandlerExtra.signal: AbortSignal` — **non-optional**; "used to communicate if the request was cancelled from the sender's side" (`shared/protocol.d.ts:173-177`). Also `authInfo?`, `sessionId?`, `_meta?`, `requestId`.
- `CallToolResult.structuredContent?: Record<string, unknown>` (`types.d.ts:2601` etc.). Docs comment at `mcp.d.ts:257-258`: return `structuredContent` if the tool has an `outputSchema`, `content` if not.
- `InMemoryTransport.createLinkedPair(): [InMemoryTransport, InMemoryTransport]` → `[client, server]` (`esm/inMemory.d.ts`).
- `createMcpExpressApp(options?: { host?: string; allowedHosts?: string[] }): Express` — defaults `host='127.0.0.1'`; auto-applies `localhostHostValidation()` when host is `127.0.0.1|localhost|::1`; applies `hostHeaderValidation(allowedHosts)` when `allowedHosts` given.
  **Important:** its implementation does `app.use(express.json())` with the **default 100 KB limit** — we must account for that (Phase 6).
- `hostHeaderValidation(allowedHostnames: string[]): RequestHandler` — matches hostname **port-agnostically**; rejects with HTTP 403 + JSON-RPC `-32000`. `localhostHostValidation()` allows `localhost`, `127.0.0.1`, `[::1]`.
- `StreamableHTTPServerTransport` options confirmed present: `sessionIdGenerator`, `enableJsonResponse`, `onsessioninitialized`, `onsessionclosed`, `eventStore` (already used: `sessionIdGenerator`, `enableJsonResponse`, `onsessioninitialized`).

### pino
- `utils/logger.ts` already writes to fd 2 (`pino.destination(2)`) → stderr-only is already satisfied; `redact` list is top-level only (B6 gap).

## Decisions (link ADRs)

_(none yet — ADRs start in Phase 2: `docs/adr/0001-module-layout.md`)_

## Test-harness facts (needed by every later phase)

- `jest.config.js`: preset `ts-jest/presets/default-esm`; `extensionsToTreatAsEsm: ['.ts']`; `moduleNameMapper` strips `.js` from relative imports; `testMatch: ["**/src/__tests__/**/*.test.ts"]`; `resolver: "jest-ts-webcompat-resolver"`; **deprecated `globals['ts-jest']`** block (warns 3× per run).
- `npm test` = `NODE_OPTIONS=--experimental-vm-modules jest`.
- Every test file imports `../index.js`, which **runs `main()` on import** → each test file boots a real stdio server (B10). Visible in baseline logs.
- Tests fake `fetch` by assigning `global.fetch` and restore it in `afterEach`.
- 8 suites / 31 tests. `rateLimiting.test.ts` has one `test.skip` (the real concurrency test) — to be rewritten in Phase 3.
- **Contract tension:** `regressionFixes.test.ts` contains `"tool handlers must not return structuredContent"`, which directly contradicts B11/Phase 5 (restoring `structuredContent`). It must be rewritten in Phase 5 with a CHANGELOG "Changed" entry. `git show 4115cb1` holds the removed implementation for reference.
- `apiIntegration.test.ts` monkey-patches `(server as any).server = { connect, close }` to avoid connecting. New tests should prefer a real `InMemoryTransport` pair instead of monkey-patching.

## Known issues / deferred

- **context7 is unavailable in this environment** (`Invalid API key … should start with 'ctx7sk'`). Fallback per the task's own instruction: grep-github + the installed package's own `.d.ts`/`.js` (authoritative for the installed version) + official docs via fetch. Recorded, not blocking.
- `build/` is committed? No — `build/` is gitignored but present on disk (from `prepare`).
- `service.log` (root-owned, 313 KB) and `my.db` exist in the working tree but are correctly gitignored (`.gitignore` covers `*.log`, `*.db`, `.env*`). **Never commit these.** Tracked files verified clean.
- Pre-existing oddity: `scripts/verify.mjs` and `scripts/probe.mjs` spawn `node build/index.js` — they depend on the built output.

## Questions for the owner (batch — do not block work)

1. **Default `limit` of 5 when unset (B5):** acceptable? It changes default output size. *(Default chosen: 5; recorded in CHANGELOG.)*
2. **npm package name/scope and maintainer metadata** (Phase 9): keep `@gscalzo/stackoverflow-mcp` (upstream scope, cannot publish), or rename to `@sameersemna/stackoverflow-mcp` + fix `repository`/`bugs`/`homepage` to `sameersemna/stackoverflow-mcp`?
3. **Replace the `mcp-proxy` wrapper** with the native streamable-HTTP transport in the systemd unit and `run.sh`? (Owner's current unit must keep working until they approve.)
4. **Delete or archive the 8 legacy `scripts/*.mjs`** after consolidating into `scripts/smoke.mjs`? (Plan: move to `scripts/legacy/` meanwhile.)
5. **Enable the persistent on-disk cache by default** for the systemd deployment? (Plan: off by default, opt-in via `SO_MCP_CACHE_DIR`.)

## Next action (exact)

**Phase 3.1 — rate limiter (B1), then the rest of the shared core.**

1. **sequential-thinking + architect** → `docs/adr/0002-shared-state.md`. The
   decision to record: limiter, cache, quota tracker and backoff map become
   **process-wide singletons injected into each per-session `McpServer`**, because
   today every HTTP `initialize` builds a new `StackOverflowServer` and therefore
   its own limiter — N sessions means N x 25 req/s out of one IP, and zero cache
   sharing.
2. **B1 first**, because it is already measured: `checkRateLimit` reads the shared
   timestamp list, awaits, then pushes, so concurrent callers all pass together.
   Baseline probe: **60 admissions in 41 ms** against a 25/s limit. Replace it
   with a token bucket whose `acquire()` **reserves a slot synchronously** before
   awaiting, with FIFO waiters, abort-aware waits, and per-method `backoff`
   honoured before reservation. Rewrite the `test.skip`ped test in
   `rateLimiting.test.ts` using fake timers, and add a 100-concurrent-call test
   asserting at most 25 admissions per sliding second.
3. Then, in order: `core/cache.ts` (canonical keys, bounded LRU + TTL,
   singleflight, frozen values, errors never cached), `core/quota.ts` (B15:
   expose the tracked quota in `stackoverflow://quota` and in `_meta`),
   `core/http.ts` (inject clock/fetch/config), and the `deps` object built once in
   `cli.ts`.

Gate for Phase 3 (from the brief): (a) two HTTP sessions share one limiter and
cache, (b) 5 concurrent identical calls = 1 upstream fetch, (c) expired entries
evicted and cache size bounded, (d) cancellation aborts an in-flight fetch and a
limiter wait, (e) quota exhaustion fails fast with no retries.
