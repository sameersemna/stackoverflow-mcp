# Tests

33 suites, 262 tests. No suite touches the network: upstream traffic is answered by a
scripted fetch stub, and HTTP transport tests use a real listener on a loopback port.

Run them with `npm test` (CI uses `npm run test:coverage`). See the README's
[Development](../README.md#development) section for the full check list.

## Conventions

- **One behaviour per file**, named after the behaviour rather than the module. Several
  files exist to pin a *contract* rather than to test a function.
- **Assert the call budget, not just the output.** A test that reads the right answer from
  the wrong number of upstream requests is a regression.
- **Comment the reason, not the mechanics.** Where a test encodes a deliberate trade-off,
  the header says why — those headers are the cheapest documentation this project has.

## Suites worth knowing about

| File | Why it exists |
|---|---|
| `contract.test.ts` | Snapshots the entire published surface — tool names, parameter schemas, resources, prompts. **The compatibility tripwire.** A diff here is a deliberate API change or a bug. |
| `fetchCounts.test.ts` | Pins the exact number of Stack Exchange requests per tool invocation. |
| `formattingFidelity.test.ts` | Pins produced payload bytes, so a refactor cannot quietly alter output. |
| `packaging.test.ts` | Pins the published package and the deployment artifacts. |
| `redos.test.ts` | Runs every regex against adversarial input under a time budget. |
| `config.test.ts` | Enforces that only `config.ts` reads `process.env`, and that the README and the configuration agree in both directions. |
| `sharedState.test.ts` | Proves the limiter, cache and quota tracker really are shared across sessions. |
| `structuredOutput.test.ts` | Proves the structured contract through a real MCP client, including that the SDK rejects a success without `structuredContent`. |

## Helpers

`helpers/` is not collected as suites (`testMatch` only matches `*.test.ts`).

| Helper | Purpose |
|---|---|
| `fetchHarness.ts` | Scripted, recording `fetch` stub. **Intercepts `https://api.stackexchange.com` only** — a broader stub swallows the MCP client's own HTTP traffic and produces baffling schema errors. |
| `fakeClock.ts` | Deterministic time and timers for the rate limiter. |
| `serverInternals.ts` | Typed view of the server's non-public members, replacing `(server as any).member(…)` so a signature change breaks the test at compile time. |
| `toolJson.ts` | Typed access to tool output: `parseToolJson`, `toolStructured`, `contentText`, `resourceText`. |

## Notes for future work

- `ts-jest` compiles with `isolatedModules`, so it **transpiles without type checking**.
  Type errors in this directory are caught by `npm run typecheck:test`, not by `npm test`.
- Booting many HTTP listeners inside one jest process is unreliable (`config.ts` is read
  once per module instance, so changing the environment needs `jest.resetModules()`).
  Stateless-mode request handling is therefore asserted by `scripts/smoke.mjs` against the
  built artifact, which is recorded in `httpTransport.test.ts` so it is not mistaken for
  missing coverage.
