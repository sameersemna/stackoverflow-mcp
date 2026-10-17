/**
 * Tool input and output schemas — the single source of truth.
 *
 * Responsibility: define each tool's arguments **once**, so the shape published to
 * MCP clients and the schema used to validate incoming arguments cannot drift.
 *
 * Previously there were two hand-written copies: `server.ts` registered loose
 * shapes (`z.number()` for `limit`) while `types/index.ts` parsed with stricter
 * ones (`z.number().int().positive().max(100)`). Because only the loose copy was
 * published, clients could not see a single limit — no `maxLength` on
 * `errorMessage`, no integer bounds on `limit`, no `minimum` on `minScore` — and
 * an LLM had no way to know that `limit: 500` would be rejected.
 *
 * Each tool therefore exports:
 * - a **shape** (`...InputShape`), used for registration so the constraints are
 *   published, and
 * - a **schema** (`...InputSchema`), `z.object(shape)`, used for validation.
 *
 * Both come from the same shape object, so they cannot disagree. This is an
 * additive change to the published contract: constraints are added, no field is
 * removed or renamed, and every default still preserves the previous behaviour.
 *
 * NOTE: declaring `outputSchema` in the MCP SDK means a successful result **must**
 * carry `structuredContent` — the SDK throws `InvalidParams` otherwise (verified
 * in `server/mcp.js`, `validateToolOutput`). Error results are exempt.
 */
import * as z from "zod"

/**
 * Stack Exchange site to search.
 *
 * Optional and defaults to `stackoverflow`, so existing callers are unaffected.
 * A short allow-list is used rather than the API's `/sites` endpoint (which would
 * itself cost a request): these are the sites this server is useful for, and an
 * unknown value is rejected with a clear message instead of producing an obscure
 * API error.
 */
const site = z
  .enum(["stackoverflow", "serverfault", "superuser", "askubuntu", "mathoverflow", "stackapps"])
  .optional()
  .describe(
    "Stack Exchange site to search (default: stackoverflow). Use stackapps for API questions, askubuntu for Ubuntu, serverfault for servers, superuser for desktop software."
  )

/** Fields shared by every search-like tool. */
const responseFormat = z.enum(["json", "markdown"]).describe("Response format: json or markdown")

/**
 * Result count. The upper bound is the API's own vector/pagesize ceiling and was
 * previously only enforced server-side after publication.
 */
const limit = z
  .number()
  .int("limit must be a whole number")
  .positive("limit must be at least 1")
  .max(100, "limit must be at most 100")
  .describe("Maximum number of results (1-100). Defaults to 5 when omitted.")

const page = z
  .number()
  .int("page must be a whole number")
  .positive("page must be at least 1")
  .describe("Page number for pagination (default: 1)")

const minScore = z
  .number()
  .nonnegative("minScore must be zero or greater")
  .describe("Minimum score threshold for results")

const includeComments = z
  .boolean()
  .describe(
    "Include question and answer comments in results. Costs no extra API request: the response filter returns them inline."
  )

const tags = z
  .array(z.string().trim().min(1, "a tag cannot be empty"))
  .describe(
    'Tags to search for, e.g. ["python", "pandas"]. Normalized before use: case is folded and spaces become hyphens.'
  )

/** Input shape published for the `search_by_error` tool. */
export const searchByErrorInputShape = {
  errorMessage: z
    .string()
    .trim()
    .min(1, "errorMessage is required")
    .max(2000, "errorMessage must be at most 2000 characters")
    .describe("Error message to search for"),
  language: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('Programming language (e.g., "javascript", "python")'),
  technologies: z
    .array(z.string().trim().min(1))
    .optional()
    .describe("Related technologies or frameworks"),
  minScore: minScore.optional(),
  includeComments: includeComments.optional(),
  responseFormat: responseFormat.optional(),
  limit: limit.optional(),
  page: page.optional(),
  site: site.optional(),
}

/** Input shape published for the `search_by_tags` tool. */
export const searchByTagsInputShape = {
  tags: tags.min(1, "at least one tag is required"),
  minScore: minScore.optional(),
  includeComments: includeComments.optional(),
  responseFormat: responseFormat.optional(),
  limit: limit.optional(),
  page: page.optional(),
  site: site.optional(),
}

/** Input shape published for the `analyze_stack_trace` tool. */
export const analyzeStackTraceInputShape = {
  stackTrace: z
    .string()
    .trim()
    .min(1, "stackTrace is required")
    .max(10000, "stackTrace must be at most 10000 characters")
    .describe("Full stack trace to analyze"),
  language: z
    .string()
    .trim()
    .min(1, "language is required")
    .describe("Programming language of the stack trace"),
  includeComments: includeComments.optional(),
  responseFormat: responseFormat.optional(),
  limit: limit.optional(),
  page: page.optional(),
  site: site.optional(),
}

/** Input shape published for the `search_by_query` tool. */
export const searchByQueryInputShape = {
  query: z
    .string()
    .trim()
    .min(1, "query is required")
    .max(2000, "query must be at most 2000 characters")
    .describe("Free-text search query"),
  tags: tags.optional(),
  minScore: minScore.optional(),
  acceptedOnly: z.boolean().optional().describe("Only return questions with accepted answers"),
  includeComments: includeComments.optional(),
  responseFormat: responseFormat.optional(),
  limit: limit.optional(),
  page: page.optional(),
  site: site.optional(),
}

/** Input shape published for the `search_by_question_id` tool. */
export const searchByQuestionIdInputShape = {
  questionId: z
    .number()
    .int("questionId must be a whole number")
    .positive("questionId must be a positive integer")
    .describe("Stack Overflow question ID (e.g., 12345)"),
  includeAnswers: z
    .boolean()
    .optional()
    .describe("Include answers in the response (default: true)"),
  includeComments: includeComments.optional(),
  responseFormat: responseFormat.optional(),
  site: site.optional(),
}

/** Validation schemas, derived from the shapes above so the two cannot disagree. */
export const searchByErrorInputSchema = z.object(searchByErrorInputShape)
export const searchByTagsInputSchema = z.object(searchByTagsInputShape)
export const analyzeStackTraceInputSchema = z.object(analyzeStackTraceInputShape)
export const searchByQueryInputSchema = z.object(searchByQueryInputShape)
export const searchByQuestionIdInputSchema = z.object(searchByQuestionIdInputShape)

export type SearchByErrorInput = z.infer<typeof searchByErrorInputSchema>
export type SearchByTagsInput = z.infer<typeof searchByTagsInputSchema>
export type AnalyzeStackTraceInput = z.infer<typeof analyzeStackTraceInputSchema>
export type SearchByQueryInput = z.infer<typeof searchByQueryInputSchema>
export type SearchByQuestionIdInput = z.infer<typeof searchByQuestionIdInputSchema>

/**
 * Output shape shared by the four search-like tools.
 *
 * Declaring it means the SDK validates `structuredContent` against it, so this
 * shape *is* the structured contract and must stay in step with the JSON text.
 */
export const searchOutputShape = {
  pagination: z.object({
    page: z.number().int().describe("Page number these results came from"),
    pageSize: z.number().int().describe("Number of results in this response"),
    totalCount: z.number().int().optional().describe("Total matches, when the API reported one"),
    hasMore: z.boolean().describe("Whether the API has further pages"),
  }),
  notes: z.array(z.string()).optional().describe("How the search was adjusted to produce results"),
  effectiveQuery: z
    .string()
    .optional()
    .describe("The query that actually produced these results, when the tool searched by text"),
  effectiveTags: z
    .array(z.string())
    .optional()
    .describe("Tags that actually produced these results"),
  usedFallback: z
    .boolean()
    .describe("Whether a broader variant or resolved tags produced the results"),
  truncated: z
    .boolean()
    .describe("Whether results or bodies were shortened to fit the character budget"),
  results: z
    .array(z.record(z.string(), z.unknown()))
    .describe("Cleaned questions with their answers and optional comments"),
}

/** Output shape for `search_by_question_id` (a single question, no pagination). */
export const questionOutputShape = {
  notes: z.array(z.string()).optional(),
  truncated: z.boolean(),
  results: z.array(z.record(z.string(), z.unknown())),
}
