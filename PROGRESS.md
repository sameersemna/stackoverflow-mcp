## Current phase: 5 — MCP protocol polish
## Current step: 5.1 — single-source schemas (published constraints) + restore structured output (B11)
## Status: in-progress
## Last green commit: `555c092` (27 suites, 174 passed, 0 skipped, 2 snapshots; tsc ✓; build ✓)

### Phase 4 gate: PASSED (2026-10-17)

| Commit | Work |
|---|---|
| `bacd066` | Baked-in custom filter; one search request instead of up to seven |
| `555c092` | B13 — tag normalization + lazy synonym resolution |

**Budget table, measured live through the server (not estimated):**

| Tool call | Baseline | After Phase 3 | **After Phase 4** |
|---|---|---|---|
| `search_by_error` (no comments) | 2 | 2 (cold) / 0 (cached) | **1** |
| `search_by_error` (`includeComments`) | 3 | 3 / 0 | **1** |
| `search_by_tags` (with comments) | 2–3 | 2–3 / 0 | **1** |
| `search_by_question_id` | 2–3 | 2–3 / 0 | 1–3 (unchanged) |
| Worst case incl. fallback ladder | 7 | 7 / 0 | **1–2** |
| Repeated identical request | 2–7 | **0** | **0** |
| Concurrent identical requests | each | **1 total** | **1 total** |

Verified with a live request counter around the server: `search_by_error` with
`includeComments` issues exactly **1** call to `/search/advanced` carrying the
combined filter, and the response contains answers and comments.

### Verified upstream limits (from the official docs — no longer assumed)

| Fact | Value | Source |
|---|---|---|
| Vector ID cap | **100** per request | `/docs/vectors` |
| Vectors are **unordered** for caching/throttling | `/users/1;2;3` ≡ `/users/3;2;1` | `/docs/vectors` |
| `/tags/{tags}/synonyms` cap | **20** tags per request (not 100) | `/docs/synonyms-by-tags` |
| Custom filters | **immutable and non-expiring**; bake them in, do not create at runtime | `/docs/filters`, `/docs/create-filter` |
| Question type | "can optionally return comments and answers accordingly" | `/docs/types/question` |
| Quota, no key | **300**/day per IP — **measured live** | `/docs/throttle` + probe |
| Quota, with key | **10,000**/day — **measured live** | `/docs/throttle` + probe |
| Concurrency throttle | 30 req/s per IP, harsh ban | `/docs/throttle` |
| `backoff` | must wait that many seconds before the same method again | `/docs/throttle` |
| Caching advice | "no application should make semantically identical requests more than once a minute" | `/docs/throttle` |

**Custom filter in use:** `!FuhdYD2u)f5mDpD_DQuCpPkOML`, created 2026-10-17 by
`scripts/create-filter.mjs` with `include=question.body;question.answers;question.comments;answer.body;comment.body;question.accepted_answer_id`.
Live measurement showed questions with **191, 55 and 36** answers delivering every
answer inline (no per-question cap), with `body` on questions and answers and
`comments` populated.

**Two assumptions in the code were disproved by the docs:** the comment claiming
built-in filters were needed "to avoid invalidation issues" (filters are
immutable), and the implication that questions cannot carry answers (they can).
**One live-verification bug found:** `search_by_tags` bypassed both tag
normalization and the combined filter, so it sent `tagged=JavaScript;visual+studio+code`
and made a second answers call.

**Known limitation, deliberately documented:** `acceptedOnly` uses the built-in
filter path because `accepted=True` was previously observed not to be honoured with
the combined filter. Revisit if the API changes.

## Phase checklist

- [x] Phase 0 — Baseline and safety net (branch, ledger, inventory, baseline green, contract snapshot, fetch harness)
- [x] Phase 1 — Remove import side effect and fix isolated bugs (B2, B3, B4, B5, B6, B7, B8, B9, B10, B12, B14)
- [x] Phase 2 — Modularize (pure refactor) — see ADR 0001
- [x] Phase 3 — Shared core (rate limiter, cache, quota, HTTP client)
- [x] Phase 4 — API-call reduction
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

**After Phase 3 (measured):** every read path is cached, so a repeated identical
request now costs **0** calls, and concurrent identical requests collapse to 1.
`search_by_question_id` is 1–3 on a cold cache (question + answers + comments).

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

**Phase 5.1 — single-source input schemas, then restore structured output (B11).**

1. **context7 first** for `outputSchema`/`structuredContent` shape and for how a
   handler returns `_meta` (context7 has been unavailable in this environment; if
   it still is, verify against
   `node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.d.ts`, which is
   authoritative for the installed 1.30.0, and record that in this ledger).
2. **Single-source schemas (3.5):** make `src/tools/schemas.ts` the one shape used
   for both `registerTool` and `parseInput`, adding the constraints that are
   currently invisible to clients — `max(100)`/`int()`/`positive()` on `limit`,
   `max(2000)` on `errorMessage`, `max(10000)` on `stackTrace`, `min(1)` on `tags`,
   `nonnegative()` on `minScore`. This is an **additive** change to the published
   JSON schema, so it needs a CHANGELOG entry and a deliberate contract-snapshot
   update. Confirm with the snapshot diff that nothing else moved.
3. **Restore structured output (B11):** `git show 4115cb1` holds the removed
   implementation for reference, but match the *current* result shape. Add an
   `outputSchema` shared by the search tools (`pagination`, `notes`,
   `effectiveQuery`, `effectiveTags`, `usedFallback`, `results[]`) and return
   `structuredContent` **alongside** the existing text content.
4. **Rewrite the contradicting test.** `regressionFixes.test.ts` asserts
   `"tool handlers must not return structuredContent"` — that was correct after
   `4762d6e` removed the feature, but B11 explicitly restores it. Rewrite it to
   assert the structured payload is correct, and note the reversal in
   CHANGELOG.md's "Changed" section.
5. Gate: an in-memory client test validates `structuredContent` against the
   advertised `outputSchema` for all 5 tools; error paths assert accurate
   categories; the contract snapshot diff is additive only and listed in the
   CHANGELOG.
