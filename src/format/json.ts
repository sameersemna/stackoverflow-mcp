/**
 * JSON response formatting for search results.
 *
 * Responsibility: render search results as JSON that a client can always parse,
 * with pagination metadata, optional notes, and the truncation that keeps the
 * payload inside the character budget. Extracted verbatim from
 * `StackOverflowServer.formatResponse` so the output shape is unchanged.
 */
import type { PaginationMeta, SearchResult } from "../types/index.js"
import { htmlToText } from "./html.js"
import {
  MAX_ANSWER_BODY_CHARS,
  MAX_ANSWERS,
  MAX_COMMENTS,
  MAX_JSON_COMMENT_CHARS,
  MAX_QUESTION_BODY_CHARS,
} from "./limits.js"
import { truncateJson } from "./truncate.js"

/**
 * Serialises results to the JSON tool output.
 *
 * @param pagination - Pagination metadata describing the results returned.
 * @param notes - Human-readable notes about how the search was adjusted.
 * @param results - Results to render.
 * @param limit - Character budget for the serialised payload.
 */
export function formatJson(
  pagination: PaginationMeta,
  notes: string[],
  results: SearchResult[],
  limit?: number
): string {
  const output = buildSearchPayload(pagination, notes, results)
  return truncateJson(output, limit)
}

/**
 * Builds the JSON payload for a set of results.
 *
 * Exported so the text form and `structuredContent` come from one place: both
 * must describe the same cleaned questions, and truncation must be decided once
 * (see {@link fitJsonToBudget}).
 *
 * @param pagination - Pagination metadata describing the results returned.
 * @param notes - Human-readable notes about how the search was adjusted.
 * @param results - Results to render.
 */
export function buildSearchPayload(
  pagination: PaginationMeta,
  notes: string[],
  results: SearchResult[]
): {
  pagination: PaginationMeta
  notes?: string[]
  truncated: boolean
  results: Record<string, unknown>[]
} {
  return {
    pagination,
    ...(notes.length > 0 ? { notes } : {}),
    results: results.map((result) => ({
      question: {
        question_id: result.question.question_id,
        title: htmlToText(result.question.title),
        score: result.question.score,
        answer_count: result.question.answer_count,
        is_answered: result.question.is_answered,
        accepted_answer_id: result.question.accepted_answer_id,
        link: result.question.link,
        tags: result.question.tags,
        body: htmlToText(result.question.body).slice(0, MAX_QUESTION_BODY_CHARS),
      },
      // Cap answers and body length so a single popular question cannot
      // blow past the character limit and force the whole payload to be dropped.
      answers: result.answers.slice(0, MAX_ANSWERS).map((answer) => ({
        answer_id: answer.answer_id,
        score: answer.score,
        is_accepted: answer.is_accepted,
        link: answer.link,
        body: htmlToText(answer.body).slice(0, MAX_ANSWER_BODY_CHARS),
      })),
      answers_omitted: Math.max(0, result.answers.length - MAX_ANSWERS),
      comments: result.comments
        ? {
            question: result.comments.question.slice(0, MAX_COMMENTS).map((comment) => ({
              score: comment.score,
              body: htmlToText(comment.body).slice(0, MAX_JSON_COMMENT_CHARS),
            })),
            answers: Object.fromEntries(
              Object.entries(result.comments.answers).map(([answerId, comments]) => [
                answerId,
                comments.slice(0, MAX_COMMENTS).map((comment) => ({
                  score: comment.score,
                  body: htmlToText(comment.body).slice(0, MAX_JSON_COMMENT_CHARS),
                })),
              ])
            ),
          }
        : undefined,
    })),
    // `truncated` is always present so `structuredContent` satisfies the output
    // schema without the SDK having to accept an optional-absent field.
    truncated: false,
  }
}
