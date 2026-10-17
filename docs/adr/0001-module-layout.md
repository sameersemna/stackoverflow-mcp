# ADR 0001 — Module layout

- **Status:** Accepted
- **Date:** 2026-10-17
- **Phase:** 2 (modularize, pure refactor)
- **Deciders:** maintainer (`sameersemna`), implementation by Copilot

## Context

At baseline everything lived in one 1,877-line `src/index.ts`: constants, pure
text helpers, the Express HTTP transport, `main()`, and the `StackOverflowServer`
class. Phase 1 split `main()` out (`cli.ts`, `index.ts` as a legacy shim) but
`src/server.ts` still holds ~1,625 lines mixing six unrelated responsibilities.

Measured coupling before this decision (`architect` on `src/`):

- 26 modules, 39 internal import edges, **no circular dependencies**.
- `server.ts` is the top hub: **18 direct importers** (17 test suites + `cli.ts`)
  and a **19-of-26 transitive blast radius**. The tooling explicitly flags it as a
  high-risk hub.

That last number is the whole problem this ADR has to solve: any signature change
now risks touching 17 test files, and a mixed-up import is indistinguishable from
a real regression.

## Decision

**Extract leaf modules bottom-up and keep `src/server.ts` as a stable facade that
re-exports the symbols the tests already import.**

Specifically:

1. Pure, dependency-free logic moves out first, into focused modules:
   - `src/format/` — `html.ts` (HTML entity table, `decodeHtmlEntities`,
     `htmlToText`), `truncate.ts` (`truncateText`, `truncateJson`,
     `CHARACTER_LIMIT`), `limits.ts` (output-shape constants), `json.ts` and
     `markdown.ts` (the two branches of `formatResponse` as pure functions).
   - `src/stackexchange/query.ts` — `buildQueryVariants`, `extractErrorMessage`,
     `cleanErrorMessage`, stack-trace noise/prefix tables.
   - `src/stackexchange/filters.ts` — the API filter names.
   - `src/tools/schemas.ts`, `src/resources.ts`, `src/prompts.ts`, `src/config.ts`.
2. `src/server.ts` re-exports everything it used to export:
   `StackOverflowServer`, `truncateText`, `redactSecrets`,
   `computeRetryDelayMs`, `formatZodError`, `buildQuotaMessage`. Re-exporting
   produces identical runtime bindings, so **all 17 existing test suites stay
   byte-identical** through Phase 2.
3. `formatResponse` becomes a thin dispatcher over `format/json.ts` and
   `format/markdown.ts`, preserving the exact same output bytes.
4. Constants move with their consumers. All output-shape constants live in
   `format/limits.ts` so `json.ts` and `markdown.ts` share them without importing
   each other; `truncate.ts` owns `CHARACTER_LIMIT` alone. This deliberately
   avoids introducing a cycle between the two formatters.
5. **`tools/schemas.ts` gets the existing registration shapes verbatim.** Phase 5
   is what adds the missing `max(100)`/`int()`/`positive()` constraints and makes
   one shape serve both registration and parsing. Changing them here would alter
   the published JSON schema, which is a contract change, not a refactor.

## Consequences

- Phase 2 is verifiable by construction: the contract snapshot, the fetch-count
  budget and every existing assertion must pass **unchanged** after each commit.
  Rule for the phase: *if the snapshot changes, revert the step.*
- `server.ts` stays large for now. It shrinks progressively in Phases 3-6 as
  `core/`, `stackexchange/client.ts` and `transports/http.ts` take real
  ownership instead of being thin wrappers.
- Phase 6 (HTTP hardening) will rewrite `transports/http.ts` and `cli.ts`; the
  layout keeps that rewrite away from the tool logic.
- Phase 8 (test runner) is easier because leaf modules have no Express or MCP
  dependency, so they can be unit-tested without a transport.

## Alternatives considered

1. **Move the test files' imports to the new module paths in the same commits.**
   Rejected: it couples 17 unrelated files to a structural refactor and destroys
   the ability to distinguish "import path typo" from "behaviour regression".
   Phase 2 keeps the facade; a later phase can migrate imports deliberately.
2. **Split the `StackOverflowServer` class itself in Phase 2** (one class per
   tool, `tools/searchByError.ts`, …). Rejected for now: the class shares mutable
   state (rate limiter, cache, quota, backoff) that Phase 3 is about to redesign
   into process-wide singletons with injected dependencies. Splitting the class
   before that redesign would mean doing the work twice.
3. **Extract `core/http.ts` immediately** as the full fetch/retry/redaction
   wrapper. Partially deferred: retry, timeout and redaction semantics were just
   fixed in Phase 1 and are covered by tests; Phase 3 moves them behind an
   injected-dependency boundary where the clock, `fetch` and config can be faked.
