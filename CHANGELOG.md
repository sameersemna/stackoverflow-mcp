# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

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

### Added

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

[Unreleased]: https://github.com/sameersemna/stackoverflow-mcp/commits/HEAD
