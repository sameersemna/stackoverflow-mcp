/**
 * Typed access to the server's non-public members, for tests only.
 *
 * Several suites exercise the tool handlers, the search pipeline and the response
 * formatter directly rather than through an MCP client, because that is the only
 * way to assert what a *single* call does (call counts, truncation decisions,
 * cached pages). Those members are `private` on purpose, so the tests previously
 * reached them with `(server as any).member(…)`.
 *
 * That cast is what this module replaces. It is the same runtime object — the
 * cast is erased — but the call sites are now described by an interface, so a
 * renamed or re-typed member becomes a compile error in the tests instead of a
 * silently-`any` call that fails at runtime.
 *
 * Keep this interface in step with the class: it exists to make exactly those
 * signature changes visible.
 */
import type { StackOverflowServer, SearchOptions, ToolResult } from "../../server.js"
import type { QuotaTracker } from "../../core/quota.js"
import type { ApiResponse, PagedSearchResults, SearchResult } from "../../types/index.js"

/** Non-public members of {@link StackOverflowServer} that the suites drive. */
export interface ServerInternals {
  searchStackOverflow(
    query: string,
    tags?: string[],
    options?: SearchOptions
  ): Promise<PagedSearchResults>

  formatResponse(
    results: SearchResult[],
    format?: "json" | "markdown",
    paginationInfo?: { page?: number; hasMore?: boolean; notes?: string[]; totalCount?: number }
  ): string

  withRateLimit<T>(
    fn: (signal: AbortSignal) => Promise<Response>,
    method?: string,
    attempt?: number,
    parentSignal?: AbortSignal
  ): Promise<ApiResponse<T>>

  /** The wrapped `McpServer`. Some suites replace it with a stub. */
  server: unknown

  /** The process-wide {@link QuotaTracker}, asserted to be shared across instances. */
  quota: QuotaTracker

  handleSearchByError(args: unknown, signal?: AbortSignal): Promise<ToolResult>
  handleSearchByTags(args: unknown, signal?: AbortSignal): Promise<ToolResult>
  handleAnalyzeStackTrace(args: unknown, signal?: AbortSignal): Promise<ToolResult>
  handleSearchByQuery(args: unknown, signal?: AbortSignal): Promise<ToolResult>
  handleSearchByQuestionId(args: unknown, signal?: AbortSignal): Promise<ToolResult>
}

/**
 * Views `server` through {@link ServerInternals}.
 *
 * `jest.spyOn(internals(server), 'searchStackOverflow')` works for the same
 * reason `(server as any)` did: the returned reference *is* the server, so the
 * spy replaces the method on the instance every other call path uses.
 */
export function internals(server: StackOverflowServer): ServerInternals {
  return server as unknown as ServerInternals
}
