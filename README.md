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

## Transport Modes

The server supports two transport modes:

- **stdio** (default): Standard input/output transport for direct process communication
- **HTTP** (streamable-http): HTTP-based transport for Docker/containerized deployments

HTTP mode is automatically enabled when the `PORT` environment variable is set. The server will listen on the specified port and expose:
- `POST /mcp` - Main MCP endpoint for tool calls and session initialization
- `GET /mcp` - SSE stream endpoint for streaming responses (requires session ID)
- `DELETE /mcp` - Session termination endpoint
- `GET /health` - Health check endpoint with service status and active session count

## Rate Limiting

The server implements intelligent rate limiting:
- **25 requests/second** (safety margin below API's 30/sec limit)
- **Method-specific backoff** - respects API `backoff` field in responses
- **Quota monitoring** - warns when quota drops below 100 requests
- **Automatic retry** - exponential backoff on throttling (HTTP 429 or Stack Exchange `error_id` 502)
- **Batched requests** - answers and comments for all results are fetched in a single API call each, instead of one call per question/answer

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

1. Build in watch mode:
```bash
npm run watch
```

2. Run tests:
```bash
npm test
```

3. Test HTTP mode locally:
```bash
PORT=3008 npm run build && node build/index.js
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Commit your changes
4. Push to the branch
5. Create a Pull Request

## License

MIT
