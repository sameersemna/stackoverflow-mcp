/**
 * Output-shape limits shared by the JSON and Markdown formatters.
 *
 * Responsibility: keep the two formatters in agreement about how much content a
 * response may contain. They live here rather than in either formatter so that
 * neither has to import the other.
 */

/** Maximum number of answers included per question in formatted output. */
export const MAX_ANSWERS = 5

/** Maximum characters of a question body included in formatted output. */
export const MAX_QUESTION_BODY_CHARS = 5000

/** Maximum characters of an answer body included in formatted output. */
export const MAX_ANSWER_BODY_CHARS = 3000

/** Maximum number of comments rendered per question or answer. */
export const MAX_COMMENTS = 3

/** Maximum characters of a comment body in JSON output. */
export const MAX_JSON_COMMENT_CHARS = 220

/** Maximum number of question comments rendered in Markdown. */
export const MAX_MARKDOWN_QUESTION_COMMENTS = 5

/** Maximum characters of a comment body in Markdown output. */
export const MAX_MARKDOWN_COMMENT_CHARS = 300

/** Maximum characters of an answer's comment body in Markdown output. */
export const MAX_MARKDOWN_ANSWER_COMMENT_CHARS = 200
