# ADR 0004 — HTTP transport hardening

- **Status:** Accepted
- **Date:** 2026-10-17
- **Phase:** 6 (HTTP transport hardening)
- **Deciders:** maintainer (`sameersemna`), implementation by Copilot

## Context

The HTTP transport was written for convenience, not for exposure:

| Property | Before |
|---|---|
| Bind address | `0.0.0.0` (all interfaces) |
| Authentication | none |
| Host / Origin validation | none (DNS-rebinding exposure) |
| JSON body limit | 10 MB |
| Sessions | unbounded, never expire |
| `DELETE /mcp` on unknown session | 404 |
| Shutdown | `httpServer.close()` with no keep-alive handling, no deadline |
| Requests per IP | unlimited |

The MCP specification explicitly warns about DNS rebinding for locally bound
servers, and the SDK ships middleware for it (`hostHeaderValidation`,
`localhostHostValidation`).

**Verified before changing anything:** the deployed `mcp-stackoverflow.service`
runs `node build/index.js` over **stdio** (`npx mcp-proxy` supplies the HTTP layer
on port 11405) and sets no `PORT`, so `setupHttpTransport` is not on the live
path. Changing HTTP defaults therefore cannot break the running service, and
`build/index.js` must keep working as a stdio entry point.

## Decision

1. **Bind loopback by default** (`HOST`, default `127.0.0.1`). Exposing the server
   becomes an explicit act. Containers set `HOST=0.0.0.0` deliberately (Phase 9).
2. **DNS-rebinding protection is mandatory.** With `ALLOWED_HOSTS` set, validate
   against that list; when bound to loopback, validate against
   `localhost`/`127.0.0.1`/`[::1]`. Binding to a non-loopback address **without**
   `ALLOWED_HOSTS` is refused at startup with a message naming both ways forward,
   because a warning on stderr is easy to miss in a container.
3. **Origin validation.** When `ALLOWED_ORIGINS` is set, only those origins are
   accepted. When it is unset, requests carrying an `Origin` header are rejected
   unless the origin is loopback: non-browser clients do not send `Origin`, so a
   cross-origin request to a local server is exactly the rebinding case worth
   blocking.
4. **Optional bearer auth** (`MCP_AUTH_TOKEN`), compared with `crypto.timingSafeEqual`
   over equal-length SHA-256 digests so neither content nor length leaks through
   timing. Required whenever the bind address is not loopback.
5. **1 MB JSON body limit**, replacing 10 MB: MCP requests are small, and the
   previous limit let one request allocate 10 times more than necessary.
6. **Bounded, expiring sessions.** `MAX_SESSIONS` (default 100) evicts the
   least-recently-used session, and `SESSION_IDLE_TTL_MS` (default 30 min) closes
   idle ones via a `unref`ed sweeper. A client that retries `initialize` after a
   network blip previously leaked the abandoned session forever.
7. **`DELETE /mcp` is idempotent**: deleting an unknown session succeeds (204),
   because "make this session gone" is already true. Documented, since the old
   behaviour returned 404.
8. **`/health` and `/ready` are separate.** `/health` is liveness only. `/ready`
   reports `degraded` — not failure — when quota is exhausted, because serving
   cached responses is still useful and end-of-day exhaustion is normal.
9. **Graceful shutdown with a deadline**: stop accepting connections, close
   sessions, `closeIdleConnections()`, then force after `SHUTDOWN_TIMEOUT_MS`
   (default 10 s). The returned handle exposes `shutdown()` so it is testable, and
   **signal handling moves to `cli.ts`** — registering `SIGTERM`/`SIGINT` inside a
   function called once per test run leaked listeners.
10. **Per-IP request limiting on `/mcp`** using the existing `RateLimiter` keyed by
    address. No new dependency: the required behaviour (sliding window, FIFO,
    abort-aware, injected clock) is already implemented and tested.

## Consequences

- Exposing the server now requires three deliberate decisions (bind address, allowed
  hosts, token) instead of happening silently.
- Two behaviour changes worth noting in the CHANGELOG: the default bind address
  moves from `0.0.0.0` to `127.0.0.1`, and an unknown-session `DELETE` returns 204
  instead of 404.
- The session cap means a client beyond `MAX_SESSIONS` evicts the least recently
  used session rather than failing, which is friendlier than rejecting the
  `initialize`.
- Tests can start and stop a listener per case and assert shutdown timing.

## Alternatives considered

1. **`createMcpExpressApp` from the SDK.** Rejected: it applies
   `express.json()` with the default **100 KB** limit and no way to change it, so
   we would either inherit a limit unrelated to our configuration or stack two JSON
   parsers. Its middleware (`localhostHostValidation`, `hostHeaderValidation`) is
   imported directly instead, so the guarantees are shared while the body limit is
   ours.
2. **A rate-limiting middleware dependency (e.g. `express-rate-limit`).** Rejected
   under the "prefer the standard library" rule: an in-house bucket over the tested
   `RateLimiter` gives per-key windows and abort-awareness without another runtime
   dependency.
3. **Warn instead of refusing when non-loopback without a token.** Rejected: a
   warning is invisible in a container's logs, and silently exposing an
   unauthenticated API that spends the owner's quota is the worst outcome. An
   explicit escape hatch (`ALLOW_INSECURE=1`) keeps it possible for anyone who
   really means it.
