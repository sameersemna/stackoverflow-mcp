/**
 * Stack Exchange API filter names.
 *
 * Responsibility: name the response filters the client requests, in one place.
 *
 * Built-in filters are used instead of custom filter IDs because a custom filter
 * must be created once and then hard-coded; if it were ever invalidated the
 * server would start returning errors. Phase 4 verifies in the official docs
 * whether custom filters are immutable and, if so, creates one that returns
 * questions *with* their answers and comments, which would cut a typical search
 * from 2-3 requests to 1. If it does not work out, these names stay as they are.
 */

/** Question responses: default fields plus the body. */
export const DEFAULT_FILTER = 'withbody';

/** Answer responses: default fields plus the body. */
export const ANSWER_FILTER = 'withbody';

/** Comment responses: standard fields only (comment bodies are short). */
export const COMMENT_FILTER = 'default';
