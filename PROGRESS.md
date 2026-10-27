## Current phase: 11 — Final verification and handoff
## Current step: 11.1 — scenario probes, version bump, PR
## Status: done (pending PR)
## Last green commit: `75ee856` (ledger). Phase 9 verified green locally:
## 33 suites / 262 passed / 0 skipped / 2 snapshots; typecheck ✓; typecheck:test ✓;
## lint 0 errors; format:check ✓; coverage thresholds met; build ✓; smoke 23/23 ✓;
## published tarball installed into a scratch project and answered `initialize` + `tools/list`.
## The live `mcp-stackoverflow.service` re-verified `active` and answering 200 through
## mcp-proxy after every packaging change.

### Phase 11 gate: PASSED (2026-10-17)

Version bumped to **`0.3.0`** (`npm version --no-git-tag-version minor`), CHANGELOG
`[Unreleased]` promoted to `[0.3.0]` with compare links, full gate re-run against the
bumped version.

**The three scenarios are now a permanent script, not a throwaway probe:**
`scripts/scenarios.mjs` (also `npm run scenarios`, wired into CI). It drives the **built**
artifact (`build/server.js`, `build/core/*`) with a recording fetch stub, so it measures
the shipped output and spends no quota.

| Scenario | Measured now | Baseline (Phase 0) | Check |
|---|---|---|---|
| 60 concurrent searches, 25/s limit | 60 admissions over **2002 ms**, worst 1-second window **25** | 60 admissions in **41 ms** — every caller passed | `worst <= 25` |
| 30 questions / 150 answers | **1** upstream request served all 30 questions and all 150 answers; 0 per-question answers requests | 1 search + 1 answers + 1 comments | `served === 30/150 && calls === 1` |
| >100 vectorized IDs | chunked `[100, 80]`, largest **100** | one request with 144+ IDs, rejected outright | `largest <= 100` |

**Two scenario assertions had to be corrected during this phase, and both corrections are
the point of measuring rather than asserting from memory:**

1. The 30-question scenario first failed with `returned=18`. That is not a regression: the
   upstream response offers all 30 questions and 150 answers in one request, and the
   **25,000-character output budget** then drops trailing rows. The scenario now asserts
   what actually matters — that one request fetched everything, and that truncation is
   *reported* (`truncated: true` plus a `message`) rather than silent — and adds a second,
   budget-fitting page that must come back complete and unmarked.
2. A CHANGELOG headline number was wrong on first write (`269 tests`); running the suite
   gave the real figure, **262**.

### Phase 10 gate: PASSED (2026-10-17)

| Artifact | Content | Verified how |
|---|---|---|
| `docs/ARCHITECTURE.md` | Module map with line counts, a Mermaid lifecycle diagram, process-wide state, the call budget, the error/retry taxonomy, output contract, and which suite pins what | Every number read out of the tree (`wc -l`, `grep` of `config.ts`), and corrected twice: `index.ts` is 13 lines not 24, and `config.ts` reads **17** variables not 16 |
| `SECURITY.md` | Threat model, auth (constant-time, loopback default, Host/Origin), both redaction mechanisms and why they are not interchangeable, ReDoS results, out-of-scope list, accepted audit findings | Claims re-derived from `src/core/http.ts`, `src/utils/logger.ts`, `src/transports/http.ts` and `src/config.ts`. One claim was wrong on first write — `MCP_REQUESTS_PER_SECOND` default is **100**, not 10 — and was corrected |
| README additions | Quota and caching (calls per tool + the three mechanisms), `structuredContent` beside `content`, design-notes pointers | Cross-checked against `fetchCounts.test.ts` and the ADRs |
| `src/__tests__/README.md` | Rewritten; it still described the pre-Phase-2 single-file layout | Suite count read from `jest --listTests` (33) |
| `CHANGELOG.md` | Every new artifact recorded | — |

**The redaction write-up is the part worth keeping.** pino's `redact` censors **fields by
path**, so a URL logged as a plain string value is not covered by any path — that is *why*
`redactSecrets()` exists as a second, substring-based mechanism. Documented explicitly so
the next person does not remove one of them as redundant.

**A documentation claim was wrong and the check caught it.** The per-address HTTP limit was
written as "default 10"; `config.ts` says 100. It was corrected rather than left, because a
security document that misstates a rate limit is worse than one that omits it.

**ReDoS figures are cited from `redos.test.ts`'s header, not from memory.** The 760 ms /
320 ms / 220 ms / ~23 ms numbers and the 50 ms budgets live in that file, so they can be
re-derived rather than trusted.

### Phase 9 gate: PASSED (2026-10-17)

| Change | Why it matters | Evidence |
|---|---|---|
| `prepare` → `prepack` | `prepare` also runs for a **git-URL install**, where devDependencies and often the sources are absent, so installing the package could fail. `prepack` is the hook that actually needs the build (`files: ["build"]`). | `packaging.test.ts` asserts `prepare` is gone and `prepack` is `npm run build` |
| `declaration` + `declarationMap` | Without them the published package has no types. `tsc --declaration` was probed **before** enabling it and emitted cleanly, so this is not a build bet. | `build/*.d.ts` emitted; `main`/`types`/`exports` point at them |
| `exports` → `build/server.js`, `bin` → `build/index.js` | `build/index.js` **starts a server on import**. Exposing it as the library entry would make `import '…'` boot a process. `server.js` is side-effect free (verified by importing it and observing it stay alive without starting anything). | `packaging.test.ts`; manual import check |
| `engines.node: ">=22"` | Matches the CI matrix floor, so the claim is tested rather than asserted. | `packaging.test.ts` reads the floor back out of `ci.yml` |
| Docker base Node 20 → 24 LTS, base-image `node` user | Node 20 is below the supported floor; depending on the base image's user keeps the uid stable across rebuilds (matters once a volume is mounted). | `docker build` **not** runnable here (no daemon) — see known issues |
| `deploy/stackoverflow-mcp.service.template` | A generic, hardened unit. **The owner's live unit is untouched.** | `packaging.test.ts` checks the placeholder set and that `TimeoutStopSec` exceeds the server's own shutdown deadline |
| `run.sh` API key optional | A missing key lowers the daily allowance from ~10,000 to ~300 requests; it does not stop the server working. The script also now fails loudly when `build/index.js` is missing and honours a `PORT` override. | Ran it: it loads `.env`, warns or not, and reaches the proxy bind |
| `.dockerignore` | Without it, the builder's `COPY . .` overwrites the image's `npm ci` result with the host's `node_modules` (wrong platform, much larger). | `packaging.test.ts` |

**End-to-end packaging verification (the strongest check in this phase):** `npm pack` →
`npm install <tarball>` into a scratch project → run the installed `bin` over stdio. It
answered `initialize` (serverInfo version `0.2.0`) and `tools/list` (all 5 tools), with
only protocol frames on stdout and the startup log on stderr. Tarball: **87.3 kB packed,
298.3 kB unpacked, 77 files**, README included, no `src/` leakage. Scratch artifacts
deleted afterwards.

**Deliberate non-change:** the owner's `mcp-stackoverflow.service` still runs
`node build/index.js` over stdio via mcp-proxy, so `build/index.js` must remain a working
stdio entry point — re-confirmed before and after this phase.

### Phase 8 gate: PASSED (2026-10-17)

| Work | Evidence |
|---|---|
| ESLint 10 flat config, `typescript-eslint` 8 `strictTypeChecked` + `stylisticTypeChecked`, type-aware | 355 findings on first run → **0** in source and tests |
| Prettier 3 + `.prettierrc.json` / `.prettierignore` | `format:check` clean; output-fidelity tests still byte-identical |
| Coverage thresholds | global 80/70/80/80 plus `src/core`, `src/stackexchange`, `src/format` floors; actual 85.7/78/88.9/85.7 |
| `npm run typecheck:test` | surfaced **31 latent test type errors** (ts-jest transpiles with `isolatedModules` and never type-checked); all fixed |
| `npm run test:live` | opt-in, `SO_LIVE=1`; 7/7 against the real API, budget-bounded |
| `.github/workflows/ci.yml` | Node 22 + 24 matrix, all of the above, plus a `docker build` + `/health` job |
| `.dockerignore` | `COPY . .` no longer clobbers the image's `npm ci` result with the host's `node_modules` |

**Two real defects found by the new tooling, both in tests that were passing:**

1. **`tools/isAuthorised` narrowing** — Express's `any`-typed `req.body` was read directly
   in three places; now narrowed through `asJsonObject()`. (Source, lint.)
2. **`StackTraceInput` no longer existed** — `toolHandlers.test.ts` imported a type deleted
   in Phase 2. `ts-jest` never type-checked it, so the import had been silently `any`…
   except it was an error, which is exactly what a test-tree type gate is for.

**`npm ci` needs no `--legacy-peer-deps`** — verified by `ts-jest@29.4.12`'s peer range
`typescript >=4.3 <7`, which admits TS 6.0.2. The premise for migrating to vitest was
false, so jest stays (ADR 0005).

**Coverage instrumentation requires `NODE_OPTIONS=--experimental-vm-modules`.** Without it
`jest --coverage` reports **0% for every file** — instrumented lines are attributed to the
transpiled module rather than the TS source. Recorded in ADR 0005 because a coverage gate
that silently reads 0% is worse than no gate.

**`SO_LIVE` variables are documented but server-side config they are not.** The README
guard in `config.test.ts` caught the new names on the first run, which is the guard
working; it now reads the live-check script's own `process.env` reads and checks
documentation in **both** directions.

**Not verified locally: the `docker` CI job.** No Docker daemon in this environment, so
`docker build` and the container `/health` check are the only steps proven by
construction rather than by a local run. Everything else in the workflow was run here.

### Phase 6 gate: PASSED (2026-10-17)

| Commit | Work |
|---|---|
| `b080b79` | Loopback default, Host/Origin validation, bearer auth, session cap + idle TTL, idempotent DELETE, per-IP limiting, deadline shutdown, signal handling moved to `cli.ts` |
| `4d12938` | `/ready`, `STATELESS=1`, `scripts/smoke.mjs`, scripts consolidated |

**Safety check performed before changing any HTTP default:** the deployed
`mcp-stackoverflow.service` runs `node build/index.js` over **stdio** (mcp-proxy
supplies HTTP on 11405) and sets no `PORT`, so `setupHttpTransport` is not on the
live path. Re-verified after the change: the service is still `active`, still uses
mcp-proxy, and answers a live `initialize` correctly. **The owner's run.sh, unit file
and `/health` response are untouched**, so owner question 3 remains the only thing
needed to move them onto the native transport.

**Three bugs found by testing that the unit suite could not see:**

1. **The per-address limiter queued instead of rejecting.** A 3/s limit produced eight
   `400`s and no `429`: a flood was absorbed into sockets and answered slowly. Added a
   non-blocking `RateLimiter.tryAcquire()`; the endpoint now answers 429 with
   `Retry-After`.
2. **`DELETE` was inconsistent** — a known session answered 200 (SDK transport) while
   an unknown one answered 204. Both are now 204.
3. **The fatal-error handler logged nothing useful.** pino serialises an Error only
   under the `err` key, so a misconfiguration printed `"error":{}`. It now prints the
   full refusal, verified live:
   `Refusing to bind 0.0.0.0 without authentication. Set MCP_AUTH_TOKEN, … or set ALLOW_INSECURE=1`.

Also fixed: the Host-rejection log used `hostname`, silently colliding with pino's own
base field; and the smoke script itself never sent a signal, which made every shutdown
case look like a hang (real shutdown is **18–21 ms** with live pooled sockets).

**Coverage note, deliberate and documented:** stateless mode's request handling is
asserted by `npm run smoke` against the built artifact, not in jest. `config` is read
once per module instance, so changing `STATELESS` needs `jest.resetModules()`, and
booting that many listeners in one process produced HTTP parse errors that did not
reproduce under curl. The reason is recorded in `httpTransport.test.ts` so it is not
mistaken for missing coverage.

**`npm run smoke` (23/23)** covers what unit tests cannot: the real process, real
sockets and real stdio — stdio handshake with 5 tools/2 resources/3 prompts and no
logs on stdout, `/health` + `/ready`, Host rejection, auth accept/reject, session
delete twice, stateless initialize/GET/DELETE, an insecure bind being refused with both
remedies named, and shutdown time. It consumes **no Stack Exchange quota**.

**New environment variables:** `HOST`, `ALLOWED_HOSTS`, `ALLOWED_ORIGINS`,
`MCP_AUTH_TOKEN`, `ALLOW_INSECURE`, `MAX_SESSIONS`, `SESSION_IDLE_TTL_MS`,
`SHUTDOWN_TIMEOUT_MS`, `MCP_REQUESTS_PER_SECOND`, `STATELESS`.

## Phase checklist

- [x] Phase 0 — Baseline and safety net (branch, ledger, inventory, baseline green, contract snapshot, fetch harness)
- [x] Phase 1 — Remove import side effect and fix isolated bugs (B2, B3, B4, B5, B6, B7, B8, B9, B10, B12, B14)
- [x] Phase 2 — Modularize (pure refactor) — see ADR 0001
- [x] Phase 3 — Shared core (rate limiter, cache, quota, HTTP client)
- [x] Phase 4 — API-call reduction
- [x] Phase 5 — MCP protocol polish
- [x] Phase 6 — HTTP transport hardening
- [x] Phase 7 — Config, logging, security pass (`5c0cb8c`)
- [x] Phase 8 — Tooling and CI (`9095575`, ADR 0005)
- [x] Phase 9 — Packaging and deployment artifacts (`2be99ee`)
- [x] Phase 10 — Documentation (`d728187`)
- [x] Phase 11 — Final verification and handoff (this change)
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

### Prompts (3)
- `stackoverflow_search` (`query` req, `language` opt)
- `stackoverflow_debug` (`errorMessage` req, `language` req)
- `stackoverflow_explain_answer` (`questionId` req, `answerId?`, `context?`)

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

- `docs/adr/0001-module-layout.md` — module layout; `server.ts` stays a facade over the
  extracted modules so all suites keep importing one path.
- `docs/adr/0002-shared-core.md` — process-wide rate limiter / cache / quota, injected via
  `ServerDeps`; one set per process, private sets in tests.
- `docs/adr/0003-filter-strategy.md` — one baked-in custom filter replaces the per-call
  answers/comments fetch; filters are immutable and non-expiring so this is a one-off cost.
- `docs/adr/0004-http-hardening.md` — loopback default, Host/Origin validation,
  constant-time bearer auth, session cap + idle TTL, deadline shutdown.
- `docs/adr/0005-test-runner.md` — keep jest/ts-jest (the peer-conflict premise was false),
  ESLint + Prettier over the whole tree, coverage thresholds, test-tree type gate, and the
  `NODE_OPTIONS` requirement for coverage instrumentation.

### Phase 8 verified tool versions

Pin these when reporting tooling issues: `eslint@10.13.0`, `@eslint/js@10.0.1`,
`typescript-eslint@8.71.2`, `prettier@3.9.10`, `globals@17.13.0`, `jest@30.5.2`,
`ts-jest@29.4.15`, `typescript@6.0.2`, `brace-expansion@5.0.12` (via `overrides`).
`typescript-eslint@8.71.2` peer range is `typescript >=4.8.4 <6.1.0`, so TS 6.0.2 is
inside it — that is why no `--legacy-peer-deps` is needed.

### Dependency audit state

- **Production: 0 vulnerabilities** (`npm audit --omit=dev`), enforced in CI.
- **Dev-only: 22 moderate, 0 high, 0 critical.** All of them are the
  `jest → babel-plugin-istanbul → @istanbuljs/load-nyc-config → js-yaml@3 → argparse@1 →
  sprintf-js` chain plus its parents. `npm audit`'s proposed fix is to downgrade `ts-jest`
  to 27 or `jest` to 25, i.e. it is worse than the finding. These packages only ever parse
  this repository's own `.nycrc`/fixture data during a local test run and never ship
  (`files: ["build"]`). Accepted, recorded here rather than silenced.
- The earlier `brace-expansion` override (5.0.8) was itself below the patched 5.0.12 and is
  now bumped; that was a genuine high-severity dev finding.

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
- Pre-existing oddity: the scripts in `scripts/legacy/` spawn `node build/index.js` — they depend on the built output, which is why they were moved rather than deleted.
- **Jest reports "A worker process has failed to exit gracefully" intermittently** at the end of a full run. Investigated with `jest --detectOpenHandles` on the whole suite: **it reports no open handles**, so this is a worker-teardown timing artifact under load rather than a leaked timer or socket. All timers in `src/` already call `.unref()`. Not blocking; revisit if it ever becomes a real hang.
- `babel.config.js` was **deleted** in Phase 8: it referenced `@babel/preset-env` and `@babel/preset-typescript`, neither of which is installed, so nothing could load it successfully — dead configuration that would throw if ever used.
- The Docker CI job cannot be exercised in this environment (no Docker daemon). `docker build` and the container `/health` probe are verified by construction only.

## Questions for the owner (batch — do not block work)

1. **Default `limit` of 5 when unset (B5):** acceptable? It changes default output size. *(Default chosen: 5; recorded in CHANGELOG.)*
2. **npm package name/scope and maintainer metadata** (Phase 9): keep `@gscalzo/stackoverflow-mcp` (upstream scope, cannot publish), or rename to `@sameersemna/stackoverflow-mcp` + fix `repository`/`bugs`/`homepage` to `sameersemna/stackoverflow-mcp`?
3. **Replace the `mcp-proxy` wrapper** with the native streamable-HTTP transport in the systemd unit and `run.sh`? (Owner's current unit must keep working until they approve.)
4. **Delete or archive the 8 legacy `scripts/*.mjs`** after consolidating into `scripts/smoke.mjs`? (Plan: move to `scripts/legacy/` meanwhile.)
5. **Enable the persistent on-disk cache by default** for the systemd deployment? (Plan: off by default, opt-in via a cache-directory variable. Not implemented — nothing in Phases 9–11 needed it, and it changes the failure modes of a long-running service.)

*(Still open as of Phase 11. Questions 2 and 3 are the only ones that block further work.)*

## Next action (exact)

**Open the PR `hardening/v0.3 → main`.** Phases 0–11 are complete and `0.3.0` is green.
The PR body should carry:

1. The five ADRs (`docs/adr/0001`–`0005`) with a one-line summary each.
2. The measured before/after table from the Phase 11 gate above (concurrency, calls per
   tool, chunking, structured output, vulnerabilities, test count).
3. The contract-snapshot diff status: **no diff** — the published surface is unchanged.
   That is the compatibility claim, and it should be stated explicitly.
4. Behaviour changes grouped by whether they are behind config, with the CHANGELOG as the
   reference.
5. The open owner questions, restated for sign-off.

**Do not merge, force-push, rewrite history, change the package name, or touch the
owner's systemd unit or `scripts/legacy/` without an explicit answer.** `main` must stay
buildable while the PR is open.

**Historical note — Phase 9's original plan (now executed):** Owner sign-off is required for the
package name/scope and for any change to the unit file or `run.sh`, so do the parts that
do not need it first:

1. `package.json`: add `engines.node`, `exports`, tighten `files`, keep `bin`; make
   `prepare` harmless for a consumer installing from the registry (today it runs
   `npm run build`, which fails without sources) — this is a real install-time bug.
2. Dockerfile: move to a current LTS base, keep the built-in `node` user, add a
   `HEALTHCHECK` that matches `/health`, and confirm the build context now respects
   `.dockerignore`.
3. Add a **generic templated** systemd unit under `deploy/` (the owner's live unit is
   untouched — it still runs `node build/index.js` over stdio through mcp-proxy).
4. `run.sh`: make the API key genuinely optional and document the HTTP-mode variables.
5. Gate: `npm pack --dry-run` contents reviewed, `npm run build && npm run smoke` green,
   and a `docker build` if a daemon becomes available.

Still unanswered and therefore still open (do not block on them):
package name/scope, `mcp-proxy` → native HTTP, deleting `scripts/legacy/`, persistent
on-disk cache.
