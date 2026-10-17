/**
 * Character-budget handling for tool responses.
 *
 * Responsibility: keep a response inside a character budget, in a form the
 * client can still parse. `truncateJson` drops trailing entries to preserve
 * valid JSON; `truncateText` cuts on a line boundary and says so.
 *
 * The budget is `CHARACTER_LIMIT` by default. Phase 7 will make it configurable
 * through `config.ts`.
 */
import type { PaginationMeta } from "../types/index.js"

/** Maximum character count for response text before truncation. */
export const CHARACTER_LIMIT = 25000

/**
 * Truncates text to a character limit with a graceful message.
 * Preserves Markdown structure when possible.
 */
export function truncateText(text: string, limit: number = CHARACTER_LIMIT): string {
  if (text.length <= limit) {
    return text
  }
  const truncated = text.slice(0, limit)
  const lastNewline = truncated.lastIndexOf("\n")
  const cutPoint = lastNewline > limit * 0.8 ? lastNewline : limit
  return (
    truncated.slice(0, cutPoint) +
    `\n\n> *Content truncated at ${limit.toLocaleString()} characters. Refine your search or use limit to narrow results.*`
  )
}

/**
 * Truncates a JSON payload while keeping it valid JSON.
 *
 * Slicing a serialized JSON string mid-way produces invalid JSON that clients
 * cannot parse. Instead we progressively drop trailing result entries until the
 * serialized payload fits, and report the truncation in the pagination metadata.
 */
export function truncateJson(
  payload: { pagination: PaginationMeta; results: unknown[] },
  limit: number = CHARACTER_LIMIT
): string {
  return JSON.stringify(fitJsonToBudget(payload, limit), null, 2)
}

/**
 * Shrinks a payload until its serialised form fits the budget.
 *
 * Exposed separately from {@link truncateJson} so that callers needing both the
 * text and a structured value can share one decision: truncating twice could
 * otherwise produce text and `structuredContent` that disagree.
 *
 * Returns the payload unchanged (including any `truncated` flag it already
 * carried) when it fits.
 *
 * @param payload - JSON payload with pagination metadata.
 * @param limit - Character budget for the serialised form.
 * @returns The payload, adjusted with `truncated: true` and a `message` when it
 *   had to be shrunk.
 */
export function fitJsonToBudget<T extends { pagination: PaginationMeta; results: unknown[] }>(
  payload: T,
  limit: number = CHARACTER_LIMIT
): T {
  const results = [...payload.results]
  let serialized = JSON.stringify(payload, null, 2)

  while (serialized.length > limit && results.length > 0) {
    results.pop()
    serialized = JSON.stringify(
      {
        ...payload,
        pagination: { ...payload.pagination, pageSize: results.length },
        results,
        truncated: true,
        message: `Response exceeded ${limit.toLocaleString()} characters; some results were omitted. Reduce limit or refine your search.`,
      },
      null,
      2
    )
  }

  if (serialized.length <= limit) {
    return results.length === payload.results.length
      ? payload
      : {
          ...payload,
          pagination: { ...payload.pagination, pageSize: results.length },
          results,
          truncated: true,
          message: `Response exceeded ${limit.toLocaleString()} characters; some results were omitted. Reduce limit or refine your search.`,
        }
  }

  // Even a single result is too large: fall back to a minimal valid payload.
  return {
    ...payload,
    pagination: { ...payload.pagination, pageSize: 0 },
    results: [],
    truncated: true,
    message: `Response exceeded ${limit.toLocaleString()} characters. Refine your search or reduce limit.`,
  }
}
