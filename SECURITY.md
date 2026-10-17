# Security

How this server handles untrusted input, what it deliberately does not protect against,
and how to report a problem.

## Threat model

The server sits between an LLM client and the Stack Exchange API. Four things are
untrusted, and they are handled differently:

| Untrusted input | Where it comes from | Handling |
|---|---|---|
| Tool arguments | The MCP client, i.e. ultimately a model | Validated against the shared zod schema before any work happens. Invalid input costs **zero** upstream requests. |
| Upstream JSON | `api.stackexchange.com` | Treated as opaque until parsed, then narrowed at the boundary (`asJsonObject`, `data.items ?? []`). A malformed body becomes an `UpstreamError`, not a crash. |
| HTTP requests | The network, in HTTP mode | Host and Origin validated, bearer token required off loopback, 1 MB body limit, per-IP request limiting, session cap and idle expiry. |
| Rendered content | Question and answer bodies (HTML) | Converted to text with a linear stripper; entity decoding is clamped so a hostile `&#999999999;` cannot throw. |

## Authentication and network exposure

- **Loopback by default.** `HOST` defaults to `127.0.0.1`. Binding a routable address
  without `MCP_AUTH_TOKEN` **and** `ALLOWED_HOSTS` makes the process refuse to start, with
  a message naming both remedies. `ALLOW_INSECURE=1` is the explicit escape hatch.
- **Bearer token comparison is constant-time.** Both sides are SHA-256 digested and
  compared with `timingSafeEqual`, so a wrong token of the right length cannot be
  distinguished from a wrong token of the wrong length by timing.
- **Host and Origin are validated.** A `Host` header outside `ALLOWED_HOSTS` (or, on a
  loopback bind, outside the loopback names) is rejected with `403` before the request
  reaches the MCP transport. This is what stops DNS-rebinding attacks against a
  locally-bound server.
- **Bodies are capped at 1 MB**, sessions at `MAX_SESSIONS` (default 100, LRU eviction),
  sessions expire after `SESSION_IDLE_TTL_MS` (default 30 min), and each address is
  limited to `MCP_REQUESTS_PER_SECOND` (default 100/s) — a flood is **rejected** with `429`
  and `Retry-After`, not queued.
- **Shutdown has a deadline** (`SHUTDOWN_TIMEOUT_MS`), so a stop signal cannot hang on a
  keep-alive connection.

Details and the reasoning behind each default are in
[`docs/adr/0004-http-transport.md`](./adr/0004-http-transport.md).

## Credentials

The only secret the server holds is `STACKOVERFLOW_API_KEY` (plus `MCP_AUTH_TOKEN` in
HTTP mode). Leaking either into a response body or a log is the failure worth defending
against, and there are two complementary mechanisms:

1. **`redactSecrets()`** rewrites credentials out of any text before it reaches a client
   or a log. It matches `?key=…`/`&key=…` in a URL, `Authorization: …` headers, and
   `api_key`/`apiKey`/`access_token`/`token`/`authorization`/`password`/`secret` in
   `name=value` form.
2. **pino `redact`** censors whole **fields** by path (`key`, `token`, `authorization`,
   `req.headers.authorization`, and wildcard variants).

These are not interchangeable, and the distinction is the subtle part: pino redacts
**fields by path, not substrings**, so a URL logged as a plain string
(`logger.info({ url })`) is not covered by any redaction path. Every URL that might carry
the API key is therefore passed through `redactSecrets()` first. `logging.test.ts` and
`security.test.ts` assert both mechanisms, and the redaction paths are exported
(`REDACT_PATHS`) so the tests assert the real list rather than a copy.

`config.test.ts` enforces that **only `config.ts` reads `process.env`**, so a credential
cannot be read somewhere that bypasses validation.

## Regexes and resource exhaustion

Every regex that touches attacker-controlled text is either linear or bounded, because
this server accepts arbitrary error messages and stack traces up to 2,000 and 10,000
characters. `redos.test.ts` measures adversarial inputs (20k characters of
nesting, spaces, unterminated tags, huge and negative numeric entities) against a time
bound of 50 ms per case. It is what found four real defects during this work — a path regex
taking **760 ms** on 20k characters, `/\s+at\s+/` taking **320 ms** on 10k spaces, an
entity decoder throwing `RangeError` on `&#999999999;`, and `/<[^>]+>/g` taking **220 ms**
— and all four are fixed; the worst case is now ~23 ms when measured standalone, or ~65 ms
under jest's instrumentation. The numbers, the reasoning for the budgets and the per-case
overrides are recorded in that file's header so they can be re-verified rather than
trusted.

## What is deliberately out of scope

- **No client-side encryption or at-rest secrecy.** The cache is in memory and holds
  public Stack Overflow content.
- **No protection against a malicious MCP client you chose to run.** A connected client
  can call any tool; the tools are read-only (`readOnlyHint`, `idempotentHint`) and
  cannot modify anything upstream or locally.
- **No upstream rate-limit evasion.** The server honours `backoff`, stays below the
  documented concurrency throttle, and never scrapes the HTML site. Where the API returns
  an error, the error is surfaced.
- **`ALLOW_INSECURE=1` genuinely disables the bind checks.** It exists for deliberate
  setups behind a trusted proxy and prints its reasoning at startup.

## Accepted dependency findings

`npm audit --omit=dev` reports **0 vulnerabilities**; CI fails if that changes.

`npm audit` without `--omit=dev` reports 22 moderate advisories, all of them the
`jest → babel-plugin-istanbul → @istanbuljs/load-nyc-config → js-yaml@3 → argparse@1 →
sprintf-js` chain and its parents. They are accepted, not ignored:

- They exist only in the development toolchain and never ship — `files: ["build"]`
  restricts the tarball to the compiled output, and the Docker runtime stage installs with
  `--omit=dev`.
- They are reachable only while parsing this repository's own `.nycrc` and fixtures during
  a local test run, never attacker-supplied data.
- `npm audit`'s proposed remediation is to downgrade `ts-jest` to 27 or `jest` to 25, which
  is worse than the finding.

Two dev-only findings were fixed rather than accepted: an `overrides` pin of
`brace-expansion` was itself below the patched release and is now 5.0.12, and the SDK was
upgraded to 1.32.1 for an advisory in the HTTP transport.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting on this repository
(*Security → Report a vulnerability*), which opens a private advisory thread. Please do not
open a public issue for anything exploitable.

Include the version (`package.json`), the transport in use (stdio or HTTP, and the relevant
environment variables with secrets removed), and a minimal reproduction.
