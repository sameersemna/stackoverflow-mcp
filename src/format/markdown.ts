/**
 * Markdown response formatting for search results.
 *
 * Responsibility: render search results as readable Markdown for an LLM, with
 * HTML converted to text and bodies capped so one popular question cannot fill
 * the whole budget. Extracted verbatim from
 * `StackOverflowServer.formatResponse` so the output shape is unchanged.
 */
import type { PaginationMeta, SearchResult, StackOverflowAnswer, StackOverflowComment } from '../types/index.js';
import { htmlToText } from './html.js';
import {
  MAX_ANSWER_BODY_CHARS,
  MAX_ANSWERS,
  MAX_COMMENTS,
  MAX_MARKDOWN_ANSWER_COMMENT_CHARS,
  MAX_MARKDOWN_COMMENT_CHARS,
  MAX_MARKDOWN_QUESTION_COMMENTS,
  MAX_QUESTION_BODY_CHARS,
} from './limits.js';
import { truncateText } from './truncate.js';

/**
 * Renders results as the Markdown tool output.
 *
 * @param pagination - Unused by the Markdown body itself; kept so both
 *   formatters can be called through one dispatcher.
 * @param notes - Notes to surface above the results.
 * @param results - Results to render.
 * @param limit - Character budget for the rendered document.
 */
export function formatMarkdown(
  pagination: PaginationMeta,
  notes: string[],
  results: SearchResult[],
  limit?: number
): string {
  void pagination;
const markdown = results
  .map((result) => {
    let md = `# ${htmlToText(result.question.title)}\n\n`;        md += `**Score:** ${result.question.score} | **Answers:** ${result.question.answer_count} | **Tags:** ${result.question.tags.join(', ')}\n\n`;
    md += `## Question\n\n${htmlToText(result.question.body).slice(0, MAX_QUESTION_BODY_CHARS)}\n\n`;

    if (result.comments?.question && result.comments.question.length > 0) {
      md += '### Question Comments\n\n';
      result.comments.question.slice(0, MAX_MARKDOWN_QUESTION_COMMENTS).forEach((comment: StackOverflowComment) => {
        md += `- ${htmlToText(comment.body).slice(0, MAX_MARKDOWN_COMMENT_CHARS)} *(Score: ${comment.score})*\n`;
      });
      md += '\n';
    }

    // Only render the answers section when answers are present, so that
    // `includeAnswers: false` does not emit an empty heading.
    if (result.answers.length > 0) {
      md += '## Answers\n\n';
      result.answers.slice(0, MAX_ANSWERS).forEach((answer: StackOverflowAnswer) => {
        md += `### ${answer.is_accepted ? '✓ ' : ''}Answer (Score: ${answer.score})\n\n`;
        md += `${htmlToText(answer.body).slice(0, MAX_ANSWER_BODY_CHARS)}\n\n`;

        if (result.comments?.answers[answer.answer_id]) {
          md += '#### Answer Comments\n\n';
          result.comments.answers[answer.answer_id].slice(0, MAX_COMMENTS).forEach(
            (comment: StackOverflowComment) => {
              md += `- ${htmlToText(comment.body).slice(0, MAX_MARKDOWN_ANSWER_COMMENT_CHARS)} *(Score: ${comment.score})*\n`;
            }
          );
          md += '\n';
        }
      });
    }

    md += `---\n\n[View on Stack Overflow](${result.question.link})\n\n`;
    return md;
  })
  .join('\n\n');

const notesBlock =
  notes.length > 0 ? `> **Note:** ${notes.join(' ')}\n\n` : '';

return truncateText(notesBlock + markdown, limit);
}
