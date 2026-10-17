# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-10-17

The hardening release. `0.2.0` worked; this closes the gaps that only show up under
concurrency, long uptime, HTTP deployment and the API's daily quota. Every tool, resource
and prompt keeps its name, its parameters and its defaults, and the shape of the
`json`/`markdown` text output is unchanged — the contract snapshot in
`src/__tests__/contract.test.ts` is the tripwire that proves it.

Behaviour changes are listed below and none of them is silent. Full reasoning, with the
alternatives that were rejected, is in `docs/adr/`; architecture and the request lifecycle
are in `docs/ARCHITECTURE.md`; the security model is in `SECURITY.md`.

### Headline numbers

| | Before | After |
|---|---|---|
| Concurrent admissions under a 25/s limit | 60 callers all admitted in **41 ms** | 60 callers spread over 2.0 s, worst 1-second window **25** |
| Upstream requests for one `search_by_error` | 3, up to 7 | **1** |
| Repeat of an identical request within the TTL | full cost again | **0** |
| Concurrent identical requests | one each | **one shared** |
| Vectorized IDs per request | unbounded (up to 505) | **chunked at 100** |
| `structuredContent` | absent | present, validated against `outputSchema` |
| Production dependency vulnerabilities | 6, including a critical | **0** |
| Tests | 8 suites / 31 tests | **33 suites / 262 tests** |


### Fixed

- **Searches now cost one API request instead of up to seven.** A baked-in custom
  response filter returns each question with its answers and comments inline, so
  the separate answers/comments round trips are gone. A rejected filter
  automatically falls back to the previous behaviour.
- **Tag searches with mixed case or spaces returned nothing.** `JavaScript` and
  `visual studio code` are now normalized to `javascript` and `visual-studio-code`
  rather than matching no tags at all.
- Comments for large result sets no longer fail: vectorized ID lists are chunked
  to the API's 100-ID limit (a single request previously carried 144+ IDs and was
  rejected outright).
- Answers are paged until `has_more` is false (bounded), so questions other than
  the most popular ones no longer appear to have zero answers.
- The query-shortening / tag-relaxation fallback only runs on page 1, so page 2
  can no longer silently come from a different query than page 1.
- The Stack Exchange `key` query parameter is redacted from error messages, and
  pino redaction paths now cover `key`/`apiKey`/`token`/`authorization` at depth.
- Importing the server module no longer starts a stdio server (`src/index.ts` is
  now a legacy entry shim; the pure implementation lives in `src/server.ts`).
- The version is read from `package.json` instead of being hard-coded in three
  separate places.

### Added

- `docs/ARCHITECTURE.md` — module map, a Mermaid request-lifecycle diagram, where the four
  pieces of process-wide state live, the API-call budget and why it is achievable, the
  error taxonomy and when each error is retried, and which test suite pins what.
- `SECURITY.md` — threat model, authentication and exposure rules, the two distinct
  credential-redaction mechanisms and why both exist, the regex-hardening results, what is
  deliberately out of scope, the accepted dev-only dependency findings with their
  rationale, and how to report a vulnerability.
- README: a **Quota and caching** section (calls per tool, the three mechanisms that keep
  the count down, how to read what is left), a **Response Format** description of
  `structuredContent` beside `content`, and pointers to the design notes.
- `src/__tests__/README.md` rewritten: it still described the pre-Phase-2 single-file
  layout. It now covers the load-bearing suites, the helpers, and two traps worth knowing
  (`ts-jest` does not type-check; HTTP listeners are unreliable to boot in-process).
- **The package is now usable as a library.** `main`/`types`/`exports` point at
  `build/server.js` and its declarations, which are side-effect free; the CLI stays on
  `bin`. TypeScript declarations (`declaration`, `declarationMap`) are emitted, so the
  package is 87 kB packed instead of shipping sources.
- **`engines.node: ">=22"`**, matching what CI exercises (Node 22 and 24). The Docker
  images moved from Node 20 to Node 24 LTS.
- `deploy/stackoverflow-mcp.service.template` — a generic systemd unit with hardening
  (`ProtectSystem=strict`, `NoNewPrivileges`, `RestrictAddressFamilies`), a 30 s stop
  timeout that lets the server drain, and instructions for rendering the placeholders.
  The deployment's own unit is unchanged.
- `.github/workflows/ci.yml` runs on Node 22 and 24; `.dockerignore` keeps the host's
  `node_modules` out of the image build.
- **ESLint, Prettier, coverage thresholds and CI.** `npm run lint` runs
  `typescript-eslint`'s type-aware `strictTypeChecked` and `stylisticTypeChecked`
  rule sets over the source and the tests; `npm run format:check` enforces Prettier;
  `npm run test:coverage` fails below the thresholds recorded in `jest.config.js`;
  `npm run typecheck:test` type-checks the test tree, which ts-jest never did (it
  transpiles with `isolatedModules`). `.github/workflows/ci.yml` runs all of it on
  Node 22 and 24 along with a `docker build` and container health check.
- **`npm run test:live`** — an opt-in check against the real Stack Exchange API
  (`SO_LIVE=1`). It asserts real results, that a configured API key is actually
  reaching the server (quota ceiling above 300), and that the run stays inside a
  request budget. It spends no quota unless explicitly enabled.
- `.prettierrc.json`, `.prettierignore`, `.dockerignore`.
- Five ADRs under `docs/adr/` recording the module layout, the shared-state design,
  the filter strategy, the HTTP hardening and the test-runner decision.

- `/ready` endpoint, separate from `/health`: it reports `degraded` (not failure)
  when the API quota is exhausted, because cached responses still work.
- `STATELESS=1` mode: one server and transport per request, no session ids. Note the
  SDK's documented limitation — a non-initialization request without a session id is
  rejected with 400, so this suits a proxy that re-initialises per request rather than
  a stateful MCP client.
- `npm run smoke`: 23 checks against the built artifact (stdio handshake, HTTP health
  and readiness, Host validation, auth, session delete, stateless mode, an insecure
  bind being refused, and shutdown time). Consumes no Stack Exchange quota.
- `npm run typecheck`.

- HTTP hardening: DNS-rebinding `Host` validation, cross-origin rejection
  (`ALLOWED_ORIGINS`), optional `MCP_AUTH_TOKEN` bearer auth compared in constant
  time, per-address request limiting on `/mcp` (excess rejected with 429 rather than
  queued), and graceful shutdown that drains sessions within `SHUTDOWN_TIMEOUT_MS`.

- Optional `site` parameter on all 5 tools (default `stackoverflow`), letting the
  same server search serverfault, superuser, askubuntu, mathoverflow and stackapps.
  An unknown value is rejected before any request is made, and the site is part of
  the cache identity. *(Purely additive: omitting it behaves exactly as before.)*
- `stackoverflow_explain_answer` prompt, for having a specific answer explained in
  the context of its question. The two existing prompts are unchanged.
- Tool descriptions now say when to use each tool instead of its siblings (error
  message → `search_by_error`, full trace → `analyze_stack_trace`, known id →
  `search_by_question_id`) and state the default result count.

- **Structured output is back (B11).** All 5 tools now publish an `outputSchema`
  and return `structuredContent` alongside the existing text, so clients get a
  machine-readable result again. Added in `4115cb1`, removed in `4762d6e`.
  *(Compatibility: the text content is unchanged. `regressionFixes.test.ts`
  previously asserted the **absence** of `structuredContent`; that assertion has
  been reversed deliberately.)*
- **The published input schemas now advertise their limits.** `limit` is
  `integer` with `minimum`/`maximum` 1-100, `page` is a positive integer,
  `minScore` is non-negative, `errorMessage` has `maxLength` 2000, `stackTrace`
  10000, `tags` rejects empty strings. Previously the published schema said only
  `"type": "number"`, so an LLM could not see any of the constraints the server
  enforced.
- `effectiveQuery`, `effectiveTags` and `usedFallback` on search results, so a
  client can page through the query that actually matched.
- Tag input is normalized (case folded, spaces become hyphens, duplicates removed,
  order canonical) and a tag that matches nothing is resolved through the
  synonyms endpoint instead of dropping the filter.
- `_meta` on every tool result carries the live quota (remaining, max, reset time,
  anonymous-or-keyed) and the cache size.

### Changed

- **`prepare` no longer runs a build; `prepack` does.** `prepare` also runs when the
  package is installed from a git URL, where devDependencies and often the sources are
  absent, so it could fail the install. `prepack` runs on `npm pack`/`npm publish`,
  which is exactly when `files: ["build"]` has to exist. Build locally with
  `npm run build` as before; `npm ci` no longer builds implicitly.
- **`run.sh` treats `STACKOVERFLOW_API_KEY` as optional.** It used to exit 1 when the key
  was missing; a missing key reduces the daily allowance from ~10,000 requests to ~300
  rather than preventing the server from working, so it now warns. The script also fails
  loudly when `build/index.js` is absent and respects a `PORT` override.
- The Docker runtime stage relies on the base image's `node` user instead of creating
  one, so the uid stays stable across rebuilds.
- **Formatting is now Prettier's** (no semicolons, double quotes, 100 columns). This
  is a whole-tree style commit; no string contents or behaviour changed, which the
  output-fidelity tests confirm byte-for-byte.
- `ApiResponse.items`/`has_more` are optional. They are only guaranteed on a
  successful response, and the code already treated them as possibly absent; the
  type now says so instead of making the guards look dead.
- Non-Error promise rejections pass through `raceWithSignal` unchanged rather than
  being wrapped, so a caller sees the reason it actually produced.
- `GET`/`DELETE` request bodies are narrowed through `asJsonObject` instead of being
  read off Express's `any`-typed `req.body`.
- Two `throw new Error(...)` sites in the answers and comments fetchers now attach
  `{ cause }`, so the original failure is not lost.
- `tsconfig.test.json` is formatted and its types are now checked in CI, which
  surfaced and fixed 31 latent test type errors (including an import of a type that
  no longer existed).

- **The HTTP transport binds loopback by default** (`HOST`, default `127.0.0.1`)
  instead of `0.0.0.0`, and refuses to start on a non-loopback address without
  `MCP_AUTH_TOKEN` and `ALLOWED_HOSTS` (escape hatch: `ALLOW_INSECURE=1`). Containers
  must now set `HOST=0.0.0.0` deliberately.
- **`DELETE /mcp` always returns 204.** Previously a known session answered 200 (the
  SDK transport handled it) while an unknown one answered 404. One status makes "make
  this session gone" safely idempotent for any client.
- The HTTP JSON body limit is 1 MB instead of 10 MB.
- HTTP sessions are capped (`MAX_SESSIONS`, default 100, LRU eviction) and expire
  when idle (`SESSION_IDLE_TTL_MS`, default 30 min).

- **Default page size is now 5 results when `limit` is omitted.** Previously no
  `pagesize` was sent at all, so the Stack Exchange default of 30 applied. With
  bodies, answers and comments that is 30 posts of content, which the 25,000
  character budget then truncated anyway — wasting API quota and context. Pass
  `limit` explicitly to restore the previous behaviour (up to 100).
  *(Owner sign-off requested: `PROGRESS.md` question 1.)*
- `pagination.totalCount` is now omitted unless the API reported a real total.
  It used to mirror the page size, which read like a total.
  *(Compatibility: the key is still present whenever a true total is known.)*
- `truncateText` truncation notices name the effective character limit instead of
  always reporting the global 25,000 default.
- An unterminated tag is now dropped rather than emitted half-formed: `htmlToText('a<b')`
  returns `a` where the previous regex returned `a<b`. Affects malformed input only.

### Security

- **Dependency vulnerabilities cleared.** `npm audit --omit=dev` reported 6 production
  advisories, including a **critical** `proxy-addr` IP-spoofing issue that touches the
  per-address rate limiter, a **high** OAuth-credential issue in the MCP SDK (1.12.0 to
  1.30.1 — we were on 1.30.0), and a DoS in `qs` reachable through request parsing. The
  SDK is now **1.32.1** and production reports **0** vulnerabilities. Verified after the
  upgrade that the suite passes and the published contract snapshot is byte-identical.
- **Four regex/parsing defects in the text helpers, found by adversarial measurement:**
  `cleanErrorMessage` took **760 ms** on a 20,000-character path-like message and
  **320 ms** on 10,000 spaces (unbounded quantifiers, quadratic); `htmlToText` took
  **220 ms** on unclosed angle brackets; and `decodeHtmlEntities` threw
  `RangeError: Invalid code point` on a post containing `&#999999999;`, failing the whole
  tool call. Worst case is now **~23 ms**. Guarded by `redos.test.ts` (32 cases).

[Unreleased]: https://github.com/sameersemna/stackoverflow-mcp/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/sameersemna/stackoverflow-mcp/commits/v0.3.0
