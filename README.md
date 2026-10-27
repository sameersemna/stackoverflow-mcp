# Stack Overflow MCP Server

A Model Context Protocol server for querying Stack Overflow. This server helps AI models find solutions to programming problems by searching Stack Overflow questions and answers.

## Features

- **5 MCP Tools**: search_by_error, search_by_tags, analyze_stack_trace, search_by_query, search_by_question_id
- **Tool Annotations**: readOnlyHint, idempotentHint, openWorldHint for safe auto-approval
- **MCP Resources**: Server status (`stackoverflow://status`) and API quota (`stackoverflow://quota`)
- **MCP Prompts**: Pre-built templates for searching and debugging workflows
- **Rich Text Output**: Full question and answer bodies, converted from HTML to readable Markdown/plain text
- **Pagination**: `page` parameter with `page`, `pageSize`, `totalCount`, `hasMore` metadata in all responses
- **Resilient Search**: Over-specific queries are automatically retried with broader terms, and unmatched tag filters are relaxed with an explanatory note
- **Character Limit Truncation**: Automatic graceful truncation at 25,000 characters (JSON output stays valid JSON)
- Search by error messages, tags, free-text queries, or question IDs
- Stack trace analysis with language filtering
- Filter results by score/votes and accepted answers
- Include question and answer comments
- Output in JSON or Markdown format
- Supports both stdio and HTTP (streamable-http) transport modes
- Automatic rate limiting with backoff handling
- API quota monitoring
- Structured logging with Pino
- Graceful shutdown handling
- Health check endpoint (`/health`)
- Session management for HTTP transport

## Installation

You can run the server directly using npx:

```bash
npx -y @gscalzo/stackoverflow-mcp
```

Or install it globally:

```bash
npm install -g @gscalzo/stackoverflow-mcp
```

The package also exposes a side-effect-free library entry (`build/server.js`, with TypeScript
declarations) for programmatic use; the `bin` points at the CLI, and importing the library
never starts a server or exits the process.

### Docker

The image builds on the current Node LTS, runs as the non-root `node` user and ships only
production dependencies and the compiled output:

```bash
docker build -t stackoverflow-mcp .
```

The container binds loopback by default (see **Transport Modes**). Publishing the port is a
deliberate choice that requires the auth variables, because the server refuses to bind a
routable address without them:

```bash
docker run -d --name stackoverflow-mcp -p 3008:3008 \
  -e HOST=0.0.0.0 \
  -e MCP_AUTH_TOKEN="$(openssl rand -hex 32)" \
  -e ALLOWED_HOSTS=localhost,127.0.0.1 \
  -e STACKOVERFLOW_API_KEY=your_key \
  stackoverflow-mcp
```

### systemd

`deploy/stackoverflow-mcp.service.template` is a generic unit with placeholders for the
user, install directory, node binary and port, plus hardening (`ProtectSystem=strict`,
`NoNewPrivileges`, a 30s stop timeout that lets the server drain). Render it with `sed` and
install it under `~/.config/systemd/user/`; the instructions are in the file's header.

The template appends to `service.log`; use `deploy/stackoverflow-mcp.logrotate` (or your
system's journald settings) to avoid unbounded growth. `NOTES.prs` should no longer
delete the log during routine restarts.

### Configure the Server

Create or modify your MCP settings file:

- For Claude.app: `~/Library/Application Support/Cursor/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`
- For Claude Desktop: `~/Library/Application Support/Claude/claude_desktop_config.json`

Add the following configuration:

```json
{
  "mcpServers": {
    "stackoverflow": {
      "command": "npx",
      "args": ["-y", "@gscalzo/stackoverflow-mcp"],
      "env": {
        "STACKOVERFLOW_API_KEY": "your-api-key-optional"
      },
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

### Optional: Stack Overflow API Authentication

The server works without authentication but has rate limits (10,000 requests/day shared quota). To increase the rate limits:

1. Get an API key from [Stack Apps](https://stackapps.com/apps/oauth/register)
2. Add the API key to your MCP settings configuration or set `STACKOVERFLOW_API_KEY` environment variable

With an API key, you get:
- 10,000 requests/day per user/app pair (instead of shared IP quota)
- Higher rate limits (30 requests/second)
- Better quota management

## Usage

The server provides five main tools:

### 1. search_by_error

Searches Stack Overflow for error-related questions:

```typescript
interface SearchByErrorInput {
  errorMessage: string;          // Required: Error message to search for
  language?: string;            // Optional: Programming language
  technologies?: string[];      // Optional: Related technologies
  minScore?: number;           // Optional: Minimum score threshold
  includeComments?: boolean;    // Optional: Include comments in results
  responseFormat?: "json" | "markdown"; // Optional: Response format
  limit?: number;              // Optional: Maximum number of results
  page?: number;               // Optional: Page number (default: 1)
}
```

### 2. search_by_tags

Searches Stack Overflow questions by tags:

```typescript
interface SearchByTagsInput {
  tags: string[];              // Required: Tags to search for
  minScore?: number;          // Optional: Minimum score threshold
  includeComments?: boolean;   // Optional: Include comments in results
  responseFormat?: "json" | "markdown"; // Optional: Response format
  limit?: number;             // Optional: Maximum number of results
  page?: number;              // Optional: Page number (default: 1)
}
```

### 3. analyze_stack_trace

Analyzes stack traces to find relevant solutions:

```typescript
interface StackTraceInput {
  stackTrace: string;          // Required: Stack trace to analyze
  language: string;           // Required: Programming language
  includeComments?: boolean;   // Optional: Include comments in results
  responseFormat?: "json" | "markdown"; // Optional: Response format
  limit?: number;             // Optional: Maximum number of results
  page?: number;              // Optional: Page number (default: 1)
}
```

### 4. search_by_query (NEW)

Generic free-text search across Stack Overflow:

```typescript
interface SearchByQueryInput {
  query: string;               // Required: Free-text search query
  tags?: string[];            // Optional: Tags to filter results
  minScore?: number;          // Optional: Minimum score threshold
  acceptedOnly?: boolean;     // Optional: Only return questions with accepted answers
  includeComments?: boolean;   // Optional: Include comments in results
  responseFormat?: "json" | "markdown"; // Optional: Response format
  limit?: number;             // Optional: Maximum number of results
  page?: number;              // Optional: Page number (default: 1)
}
```

### 5. search_by_question_id (NEW)

Retrieve a specific Stack Overflow question by its ID:

```typescript
interface SearchByQuestionIdInput {
  questionId: number;          // Required: Stack Overflow question ID
  includeAnswers?: boolean;    // Optional: Include answers (default: true)
  includeComments?: boolean;   // Optional: Include comments
  responseFormat?: "json" | "markdown"; // Optional: Response format
}
```

## MCP Resources

The server exposes two resources for monitoring:

- **`stackoverflow://status`** — Server status including version, transport mode, and API key status
- **`stackoverflow://quota`** — Current rate limit configuration and active backoff status

## MCP Prompts

Pre-built prompt templates for common workflows:

- **`stackoverflow_search`** — Template for searching with a query and optional language filter
- **`stackoverflow_debug`** — Template for debugging errors with stack trace analysis

## Examples

### Searching by Error Message

```javascript
{
  "name": "search_by_error",
  "arguments": {
    "errorMessage": "TypeError: Cannot read property 'length' of undefined",
    "language": "javascript",
    "technologies": ["react"],
    "minScore": 5,
    "includeComments": true,
    "responseFormat": "markdown",
    "limit": 3
  }
}
```

### Searching by Tags

```javascript
{
  "name": "search_by_tags",
  "arguments": {
    "tags": ["python", "pandas", "dataframe"],
    "minScore": 10,
    "includeComments": true,
    "responseFormat": "json",
    "limit": 5
  }
}
```

### Analyzing Stack Trace

```javascript
{
  "name": "analyze_stack_trace",
  "arguments": {
    "stackTrace": "Error: ENOENT: no such file or directory, open 'config.json'\n    at Object.openSync (fs.js:476:3)\n    at Object.readFileSync (fs.js:377:35)",
    "language": "javascript",
    "includeComments": true,
    "responseFormat": "markdown",
    "limit": 3
  }
}
```

## Configuration

Every variable is read once at startup by `src/config.ts` (the only module permitted to
read the environment) and validated: a bad value stops the process with a message naming
the variable and the rule, instead of silently falling back to a default.

| Variable | Default | Purpose |
|---|---|---|
| `STACKOVERFLOW_API_KEY` | *(unset)* | Stack Exchange API key. Raises the daily allowance from ~300 requests (anonymous, per IP) to ~10,000. |
| `PORT` | *(unset)* | Enables HTTP mode and sets the listening port. Unset means stdio. |
| `HOST` | `127.0.0.1` | Address to bind in HTTP mode. Loopback by default; exposing the server is a deliberate act. |
| `ALLOWED_HOSTS` | loopback only | Comma-separated hostnames accepted in the `Host` header (DNS-rebinding protection). Required when binding a non-loopback address. |
| `ALLOWED_ORIGINS` | loopback only | Comma-separated origins accepted in the `Origin` header. When unset, non-browser clients are unaffected and cross-origin browser requests are rejected. |
| `MCP_AUTH_TOKEN` | *(unset)* | Bearer token required on `/mcp`. Compared in constant time. Required when binding a non-loopback address. |
| `ALLOW_INSECURE` | *(unset)* | Set to `1` to bind a non-loopback address without a token and without `ALLOWED_HOSTS`. Deliberate escape hatch. |
| `TRUST_PROXY` | *(unset)* | Express trust proxy setting for deployments behind a reverse proxy (e.g. `loopback`, `true`, `1`, or CSV). Leave unset for direct exposure so client IPs cannot be spoofed. |
| `STATELESS` | *(unset)* | Set to `1` for stateless HTTP: one server per request, no session ids. See the limitation under Transport Modes. |
| `MAX_SESSIONS` | `100` | Maximum concurrent HTTP sessions before the least recently used is evicted. |
| `SESSION_IDLE_TTL_MS` | `1800000` (30 min) | Idle timeout after which a session is closed. |
| `MCP_REQUESTS_PER_SECOND` | `100` | Per-client-address request limit on `/mcp`. Excess is rejected with `429` and a `Retry-After` header. |
| `SHUTDOWN_TIMEOUT_MS` | `10000` | Deadline for graceful shutdown before connections are forcibly closed. |
| `RATE_LIMIT_RPS` | `25` | Client-side request rate to the Stack Exchange API. The API throttles above 30/sec per IP. |
| `REQUEST_TIMEOUT_MS` | `15000` | Time budget for a single upstream request. |
| `RETRY_BASE_DELAY_MS` | `1000` | Base delay for the first retry; grows exponentially with jitter, capped at 30 s. |
| `DEFAULT_LIMIT` | `5` | Results requested when a tool call omits `limit`. |
| `LOG_LEVEL` | `info` | pino level (`fatal`, `error`, `warn`, `info`, `debug`, `trace`). Logs always go to stderr. |

## Transport Modes

The server supports two transport modes:

- **stdio** (default): Standard input/output transport for direct process communication.
  Logs go to **stderr only**, because stdout carries the MCP protocol.
- **HTTP** (streamable-http): enabled by setting `PORT`.

HTTP mode binds `HOST` (loopback by default) and exposes:

| Endpoint | Behaviour |
|---|---|
| `POST /mcp` | Tool calls and session initialization. |
| `GET /mcp` | Server-sent event stream, requires a session id. Answers `405` in stateless mode. |
| `DELETE /mcp` | Terminates a session. Always answers `204`, including for an unknown session, so it is safe to repeat. |
| `GET /health` | Liveness: status, version, active session count, transport mode. |
| `GET /ready` | Readiness, including dependencies. Reports `degraded` (not failure) when the API quota is exhausted, because cached responses still work. |

**Stateless mode** (`STATELESS=1`) issues no session ids and creates a transport per
request. Note the limitation the MCP SDK documents: a non-initialization request without
a session id is rejected with `400`, so this suits a deployment behind a proxy that
re-initialises per request rather than a stateful MCP client.

Refusing to start: binding a non-loopback `HOST` without `MCP_AUTH_TOKEN` and
`ALLOWED_HOSTS` stops the process with an explanation of both remedies, unless
`ALLOW_INSECURE=1` is set.

## Rate Limiting

The server implements intelligent rate limiting:
- **25 requests/second** (safety margin below API's 30/sec limit)
- **Method-specific backoff** - respects API `backoff` field in responses
- **Quota monitoring** - warns when quota drops below 100 requests
- **Automatic retry** - exponential backoff on throttling (HTTP 429 or Stack Exchange `error_id` 502)
- **Batched requests** - answers and comments for all results are fetched in a single API call each, instead of one call per question/answer

## Quota and caching

Quota is the scarcest resource here: without a key the API allows roughly **300 requests
per day per IP**, and about **10,000** with `STACKOVERFLOW_API_KEY`. Every design decision
counts requests, so the server spends as few as possible and tells you what it spent.

**Calls per tool invocation**

| Tool | Typical | With a fallback | Repeat within the cache TTL |
|---|---|---|---|
| `search_by_error`, `analyze_stack_trace`, `search_by_query` | **1** | 2 | **0** |
| `search_by_tags` | 1 | 2 | **0** |
| `search_by_question_id` | **1** | — | **0** |

Three mechanisms get it there:

1. **Answers and comments arrive inline.** The server registers one custom
   [filter](https://api.stackexchange.com/docs/filters) once and bakes it into every
   request, so a search that used to cost one request for the search plus one for answers
   plus one for comments now costs one. Filters are immutable and non-expiring, so this is
   a one-off cost per filter, ever.
2. **A process-wide cache with singleflight.** Identical requests within the TTL cost
   nothing, and concurrent identical requests collapse into one upstream call instead of
   racing. The limiter, cache and quota tracker are shared by every session in the process,
   because all three are properties of the IP rather than of a session.
3. **Honest failure.** An exhausted quota fails after **one** request instead of retrying
   into the wall, and an upstream `backoff` is honoured per method before the next attempt.

**Read what is left.** `stackoverflow://quota` reports `remaining`, `max` and the reset
instant, and every tool result carries the same summary in `_meta`. Both report `null`
rather than a guess before the first API response.

**Spending is verified, not assumed.** `fetchCounts.test.ts` pins the exact number of
upstream requests per tool invocation, `batching.test.ts` and `cache*.test.ts` pin the
collapse behaviour, and `PROGRESS.md` holds the measured before/after table. A change that
quietly doubles the call count fails the suite.

## Search Resilience

Stack Exchange returns zero results for very specific queries, and silently
ignores tag names that do not exist (for example `react` instead of `reactjs`).
To avoid empty responses the server:

1. **Broadens over-specific queries** - if a long error message matches nothing,
   it is retried with progressively shorter prefixes (8, then 5, then 3 words),
   preserving the error type while dropping volatile trailing detail.
2. **Relaxes unmatched tag filters** - if a tag filter matches nothing, the search
   is retried without it and the response includes a `notes` entry explaining
   what happened.
3. **Switches sort when a score threshold is set** - the Stack Exchange API
   rejects `min` combined with `sort=relevance`, so `minScore` uses `sort=votes`.

Notes are returned in the `notes` array (JSON) or as a blockquote (Markdown).

## Response Format

Tools return **both** text and structured content:

- `content` — the text rendering, Markdown or JSON as `responseFormat` requests.
- `structuredContent` — the same data as a JSON object, validated against the tool's
  published `outputSchema`. Clients that understand it can read fields directly instead of
  parsing text.

A successful result without `structuredContent` is a protocol error by the MCP SDK's own
rule, and the suite asserts the contract through a real client. Both renderings share one
truncation decision, so they never disagree about which results were dropped; when output
exceeds the 25,000 character budget, the JSON gains `truncated: true` and a `message`
explaining what was omitted.

### JSON Output

Responses include:
- Pagination metadata (`page`, `pageSize`, `totalCount`, `hasMore`)
- Question details (title, body, score, tags, accepted answer, etc.)
- Answers (sorted by votes, capped at 5 per question with `answers_omitted` count)
- Optional comments for both questions and answers
- Links to the original Stack Overflow posts

JSON output is always valid JSON. If a response would exceed the 25,000 character
limit, trailing results are dropped and `truncated: true` is set rather than
cutting the payload mid-string.

### Markdown Output

The markdown format provides a nicely formatted view with:
- Question title and score
- Question body (HTML converted to readable Markdown, including fenced code blocks)
- Comments (if requested)
- Answers with acceptance status and score
- Answer comments (if requested)
- Links to the original posts

## Development

Build in watch mode:
```bash
npm run watch
```

Run the test suite:
```bash
npm test
```

Test HTTP mode locally:
```bash
PORT=3008 npm run build && node build/index.js
```

### Checks

CI runs exactly these, on Node 22 and 24, and nothing else:

| Command | What it proves |
|---|---|
| `npm run typecheck` | The shipped source compiles (`tsc --noEmit`). |
| `npm run typecheck:test` | The test tree compiles too. ts-jest transpiles without type checking, so this is the only place test types are enforced. |
| `npm run lint` | ESLint flat config with `typescript-eslint` `strictTypeChecked` + `stylisticTypeChecked`, type-aware. |
| `npm run format:check` | Prettier formatting (run `npm run format` to fix). |
| `npm run test:coverage` | Jest, with coverage thresholds on `src/core`, `src/stackexchange` and `src/format`. |
| `npm run build` | The artifact in `build/` is current. |
| `npm run smoke` | The **built** artifact works: stdio handshake, HTTP endpoints, Host validation, auth, stateless mode, shutdown. Uses a local fixture server, so it spends no API quota. |
| `npm run scenarios` | The three scale and concurrency scenarios, measured against the built artifact: 60 concurrent searches against a 25/s admission limit, 30 questions with 150 answers in one upstream request, and a vectorized ID set that must be chunked at 100. Also quota-free. |
| `npm audit --omit=dev --audit-level=high` | No known vulnerability ships to users. |
| `npm run test:live` | Skips unless `SO_LIVE=1`; see below. |

### Live API check (opt-in, spends quota)

```bash
SO_LIVE=1 npm run test:live          # up to 10 Stack Exchange requests
SO_LIVE=1 SO_LIVE_BUDGET=4 npm run test:live   # tighter budget
```

`SO_LIVE` is the acknowledgement that real quota will be spent; `SO_LIVE_BUDGET`
(default 10) is the maximum number of upstream requests the run may use. Neither is
read by the server — they belong to `scripts/live-check.mjs` only.

It spawns the built server over stdio and asserts that real searches return real
results, that the reported quota rises above the anonymous ceiling when a key is
configured, and that the run stays inside a request budget. It refuses to run
without `SO_LIVE=1` because the anonymous allowance is roughly 300 requests per day
per IP — a live check that quietly grew to 30 calls would be a real cost.

A failing live check says nothing about correctness of the code paths that the
unit suite already covers; it exists to catch upstream changes (renamed parameters,
new response shapes) that mocks cannot see.

## Design notes

Architecture, the request lifecycle, the module map and where process-wide state lives:
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

Security model — threat model, authentication, credential redaction and accepted
dependency findings: [`SECURITY.md`](SECURITY.md).

Decisions, with the alternatives that were rejected and the evidence behind each choice:
[`docs/adr/`](docs/adr). In particular ADR 0004 explains why the HTTP transport binds
loopback by default, and ADR 0005 explains why the test runner is still jest.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Commit your changes
4. Push to the branch
5. Create a Pull Request

## License

MIT
