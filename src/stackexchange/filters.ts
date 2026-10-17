/**
 * Stack Exchange API filters.
 *
 * Responsibility: name the response filters the client requests, in one place,
 * and record why the custom one is safe to hard-code.
 *
 * ## Why a custom filter
 *
 * The official docs state (https://api.stackexchange.com/docs/filters):
 *
 * > Filters are immutable and non-expiring. An application can safely "bake in"
 * > any filters that are created, it is not necessary (or advisable) to create
 * > filters at runtime.
 *
 * and the `/filters/create` page adds: "It is not expected that many
 * applications will call this method at runtime, filters should be
 * pre-calculated and 'baked in'."
 *
 * The question type documentation (https://api.stackexchange.com/docs/types/question)
 * says of a question that it "can optionally return comments and answers
 * accordingly". Requesting those fields means **one** `/search/advanced` call
 * returns the questions *with* their bodies, answers and comments, replacing the
 * separate `/questions/{ids}/answers` and `/posts/{ids}/comments` round trips.
 *
 * Measured against the live API: a search returning questions with 191, 55 and
 * 36 answers each delivered every answer inline (no per-question cap), with
 * `body` present on both questions and answers and `comments` populated. A
 * typical search therefore costs 1 request instead of 2-7.
 *
 * ## Why there is a fallback anyway
 *
 * The filter string was created once by `scripts/create-filter.mjs` and is
 * committed. Because a rejected filter would break every search, the client
 * detects a filter error and permanently falls back to the built-in filters plus
 * separate answer/comment requests for the lifetime of the process. The filter is
 * never created at runtime.
 */

/** Question responses: default fields plus the body. */
export const DEFAULT_FILTER = 'withbody';

/** Answer responses: default fields plus the body. */
export const ANSWER_FILTER = 'withbody';

/** Comment responses: standard fields only (comment bodies are short). */
export const COMMENT_FILTER = 'default';

/**
 * Fields requested from `/filters/create`.
 *
 * Kept next to the id it produced so the id can be re-derived if the filter ever
 * has to be recreated.
 */
export const COMBINED_FILTER_INCLUDE = [
  'question.body',
  'question.answers',
  'question.comments',
  'answer.body',
  'comment.body',
  'question.accepted_answer_id',
].join(';');

/**
 * The baked-in custom filter: questions **with** their answers and comments.
 *
 * Created 2026-10-17 by `scripts/create-filter.mjs` with a `default` base and
 * `unsafe=false` (the default; answers are HTML on every filter type, and the
 * server converts HTML to text itself).
 */
export const COMBINED_FILTER = '!FuhdYD2u)f5mDpD_DQuCpPkOML';

/**
 * True when an API error means the filter was rejected, so the caller should
 * stop using it.
 *
 * Matched on the API's structured `error_id`/`error_name` rather than on message
 * wording, and kept narrow so an unrelated `bad_parameter` does not silently
 * disable the optimisation.
 *
 * @param errorId - The API's `error_id`, when present.
 * @param errorName - The API's `error_name`, when present.
 * @param message - The API's `error_message`, when present.
 */
export function isFilterRejection(
  errorId: number | undefined,
  errorName: string | undefined,
  message: string | undefined
): boolean {
  if (errorId !== 400 && errorId !== 404) {
    return false;
  }
  const haystack = `${errorName ?? ''} ${message ?? ''}`.toLowerCase();
  return haystack.includes('filter');
}
