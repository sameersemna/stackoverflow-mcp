# ADR 0005 — Test runner and lint tooling

- **Status:** Accepted
- **Date:** 2026-10-17
- **Phase:** 8 (tooling and CI)
- **Deciders:** maintainer (`sameersemna`), implementation by Copilot

## Context

The project had no CI, no linter and no formatter, and its test setup carried baggage:

- `npm ci` was documented as needing `--legacy-peer-deps`, believed to be caused by
  ts-jest 29 not supporting TypeScript 6.
- `jest.config.js` used the deprecated `globals['ts-jest']` block, which printed three
  warnings on every run.
- `jest-fetch-mock` was a dependency but referenced nowhere.
- `babel.config.js` existed but the jest config uses ts-jest, so it played no part.
- Two configuration files (`tsconfig.json`, `tsconfig.test.json`) with the test one
  restating options the base already set.

## Decision

**Keep jest and ts-jest; do not migrate to vitest.**

The premise for migrating was that ts-jest cannot support TypeScript 6. That premise is
**false for the installed versions**: `ts-jest@29.4.12` declares
`peerDependencies.typescript: ">=4.3 <7"`, which includes TypeScript 6.0.2, and
`npm ls typescript ts-jest` reports no conflict.

Verified directly rather than assumed: `npm ci --ignore-scripts` in a clean copy
installs 308 packages and exits 0 with **no `ERESOLVE` and no "must use
`--legacy-peer-deps`" message**. The flag was no longer required.

So the smallest change that removes `--legacy-peer-deps` is to stop passing it, which is
what the brief asks for. Migrating to vitest would rewrite 32 test files, replace the
custom `jest-ts-webcompat-resolver` used to map `.js` specifiers back to `.ts` sources in
this ESM/`NodeNext` project, and invalidate the fetch harness that every suite depends
on — with no benefit available from doing so.

Specific decisions:

1. Delete the deprecated `globals['ts-jest']` block. The same options already live in
   `transform`, which is where ts-jest now reads them.
2. Remove `jest-fetch-mock` (referenced nowhere) and `babel.config.js`.
3. Keep `tsconfig.test.json`. It is not redundant: it is the tsconfig ts-jest compiles
   tests with, it is the only place `jest` types are loaded, and Phase 8 turned it into
   a real gate via `npm run typecheck:test`.
4. Add ESLint (flat config, `typescript-eslint` `strictTypeChecked` +
   `stylisticTypeChecked`, type-aware) and Prettier, and make both cover the whole
   tree rather than only changed files.
5. Keep `NODE_OPTIONS=--experimental-vm-modules` for jest: ESM coverage instrumentation
   depends on it. Without it `jest --coverage` reports **0% for every file** — the
   instrumented lines are attributed to the transpiled module, not the TypeScript
   source — which is exactly the kind of silent failure a coverage gate must not have.

## Outcome

Decisions 2, 4 and 5 were executed as written. Decision 3 changed: `tsconfig.test.json`
was kept and became a gate.

The lint ratchet did **not** start narrow, contrary to the original plan in decision 4.
Once the rule set was on, deferring the findings would have meant either a long list of
suppressions or a linter that fails on `main`; instead every finding was resolved or
justified, and both the source tree and the tests now lint clean at zero errors.
Evidence, per the rule that motivated each fix:

- 355 findings on first run (73 in shipped source, 282 in tests).
- 97 were autofixable and were fixed by `--fix`; the full suite and the contract
  snapshot were re-run immediately afterwards to prove the autofixes changed no
  behaviour.
- Of the remainder, the shipped-source findings were real: a promise rejection
  dropping its reason, two `throw` sites losing their `cause`, Express's `any`-typed
  `req.body` read directly, `Boolean(x)` on an already-boolean value, and dead imports
  left behind by the Phase 2 split.
- Test-side findings were addressed by *improving the tests*, not by disabling rules:
  `(server as any).member(…)` (41 sites) became a typed `internals(server)` view in
  `src/__tests__/helpers/serverInternals.ts`, and untyped `JSON.parse(...)` results
  became `parseToolJson<T>(...)`. Three rules were switched off for tests only, each
  with its rationale in `eslint.config.js`: `require-await` (mocks mirror async APIs),
  `no-unnecessary-condition` (defensive chains over values a test built itself), and
  `no-unnecessary-type-parameters` for the two helpers whose type parameter *is* the
  caller assertion.

Test-tree type checking was a genuine find: `tsconfig.test.json` sets
`isolatedModules`, which makes ts-jest transpile without type checking, so **31 type
errors had accumulated in the test tree** with tests still passing — including an
import of `StackTraceInput`, a type that no longer exists. `npm run typecheck:test`
now runs in CI and the tree is clean.

`babel.config.js` was deleted on evidence: it referenced `@babel/preset-env` and
`@babel/preset-typescript`, neither of which is installed, so nothing could have been
loading it successfully — it was dead configuration that would throw if ever used.

## Consequences

- `npm ci` needs no special flag, so CI and contributors use the documented command.
- One test runner, one transform configuration, and the existing harness and snapshots
  keep working unchanged — the contract snapshot and fetch budget remain the tripwires.
- The tree lints clean with no blanket ignores, so any new finding is attributable to
  the change that introduced it.
- Coverage is enforced (global floor plus per-directory floors for `src/core`,
  `src/stackexchange` and `src/format`) and `npm run test:coverage` must keep
  `NODE_OPTIONS=--experimental-vm-modules`, for the reason recorded above.
- Everything CI runs is runnable locally with the same commands, so a green local run
  and a green CI run mean the same thing.
- vitest stays a plausible future migration if ts-jest ever stops supporting the
  installed TypeScript, and this ADR records why it was not warranted now.

## Consequences for the Docker job in CI

CI builds the image and checks `/health`. That job depends on `.dockerignore`, added in
the same change: without it the builder's `COPY . .` overwrites the image's
`npm ci` result with the host's `node_modules`, which can be the wrong platform. The
Docker job could not be executed locally (no Docker daemon in the development
environment) and is therefore the one CI step verified by construction rather than by
a local run.

## Alternatives considered

1. **Migrate to vitest.** Rejected on evidence: the problem it was meant to solve does
   not exist. Cost would have been 32 rewritten suites, a replaced ESM resolver, and a
   revalidated harness for no functional gain.
2. **Pin TypeScript to 5.x to satisfy ts-jest.** Rejected: it would downgrade the
   language version the project targets to work around a constraint that, measured,
   does not apply.
3. **Enable ESLint but suppress its findings on existing files.** Rejected: a linter
   that reports hundreds of known failures stops being read, and the suppression list
   becomes permanent debt. Every finding was resolved or narrowly justified instead
   (see Outcome).
4. **Leave the tree unformatted and add Prettier for new files only.** Rejected:
   `format:check` cannot pass on an unformatted tree, so the script would be
   decorative. The one-time reformat is a separate, reviewable commit whose safety is
   established by the output-fidelity tests, which compare produced payload bytes and
   would fail if formatting changed any rendered string.
