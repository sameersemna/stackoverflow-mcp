/**
 * Typed helper for reading tool output in tests.
 *
 * Tool results carry JSON text, so suites parse them back. `JSON.parse` returns
 * `any`, and every `.results` / `.pagination` read off it was therefore an
 * unchecked member access. Declaring the shape once here keeps the assertions
 * honest: a rename in the payload becomes a compile error rather than a
 * silently-undefined property that a loose `expect` may still accept.
 */

/** A single result entry, with the fields the suites assert on. */
export interface ParsedSearchResult {
  question: {
    question_id: number
    title: string
    tags: string[]
    score: number
  }
  answers: { answer_id: number; score: number; is_accepted: boolean }[]
  /** Set when answers were dropped by the caller's `limit`. */
  answers_omitted?: number
  comments?: {
    question: { body: string; score: number }[]
    answers: Record<string, { body: string; score: number }[]>
  }
}

/** The payload `formatJson` produces for a search response. */
export interface ParsedSearchPayload {
  pagination: {
    page: number
    pageSize: number
    hasMore: boolean
    totalCount?: number
  }
  results: ParsedSearchResult[]
  notes?: string[]
  truncated?: boolean
  message?: string
}

/** Parses a tool result's text content as JSON. */
export function parseToolJson<T = ParsedSearchPayload>(text: string): T {
  return JSON.parse(text) as T
}

/**
 * Reads a tool result's structured payload.
 *
 * The parameter is `unknown`, not `{ structuredContent?: unknown }`: the SDK's
 * result types carry index signatures, which makes them unassignable to a
 * structural target under `exactOptionalPropertyTypes`.
 */
export function toolStructured<T>(result: unknown): T {
  return (result as { structuredContent?: unknown }).structuredContent as T
}

/** The content blocks of a tool result, as an array even when the SDK type is a union. */
export function contentBlocks(result: unknown): unknown[] {
  const content = (result as { content?: unknown }).content
  return Array.isArray(content) ? (content as unknown[]) : []
}

/** The text of a tool result's first content block, or `''` when there is none. */
export function contentText(result: unknown): string {
  const first = contentBlocks(result)[0] as { text?: unknown } | undefined
  return typeof first?.text === "string" ? first.text : ""
}

/**
 * The `text` of a resource read.
 *
 * `ReadResourceResult.contents` is a union of a text entry and a blob entry, so
 * the member is only reachable after narrowing.
 */
export function resourceText(contents: readonly unknown[]): string {
  const first = contents[0] as { text?: unknown } | undefined
  return typeof first?.text === "string" ? first.text : ""
}
