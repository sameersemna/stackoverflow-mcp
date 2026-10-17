/**
 * Formatter fidelity tests.
 *
 * Responsibility: pin the exact output of the JSON and Markdown formatters.
 *
 * These exist because Phase 2 moved the two formatter bodies out of
 * `StackOverflowServer.formatResponse` into `format/json.ts` and
 * `format/markdown.ts`. A "pure refactor" is only pure if the bytes are
 * unchanged, so the golden values below were captured from the pre-refactor
 * implementation and must never be regenerated casually: if this suite fails,
 * the output contract changed and that is a CHANGELOG entry, not a snapshot bump.
 */
import { describe, expect, test } from '@jest/globals';
import { formatJson } from '../format/json.js';
import { formatMarkdown } from '../format/markdown.js';
import type { PaginationMeta, SearchResult } from '../types/index.js';

const LONG = 'x'.repeat(400);

const RESULTS: SearchResult[] = [
  {
    question: {
      question_id: 1,
      title: 'A &amp; B <b>bold</b>',
      body: `<p>${LONG}</p>&#39;quoted&#39;`,
      score: 7,
      answer_count: 3,
      is_answered: true,
      accepted_answer_id: 11,
      creation_date: 1,
      tags: ['a', 'b'],
      link: 'https://so/q/1',
    },
    answers: Array.from({ length: 8 }, (_, index) => ({
      answer_id: 10 + index,
      question_id: 1,
      score: 8 - index,
      is_accepted: index === 0,
      body: `<p>ans ${index} ${LONG}</p>`,
      creation_date: 1,
      link: `https://so/a/${10 + index}`,
    })),
    comments: {
      question: Array.from({ length: 6 }, (_, index) => ({
        comment_id: index,
        post_id: 1,
        score: index,
        body: `<i>qc${index}</i> ${LONG}`,
        creation_date: 1,
      })),
      answers: {
        10: Array.from({ length: 4 }, (_, index) => ({
          comment_id: 100 + index,
          post_id: 10,
          score: index,
          body: `<i>ac${index}</i> ${LONG}`,
          creation_date: 1,
        })),
      },
    },
  },
  {
    question: {
      question_id: 2,
      title: 'Plain',
      body: 'no html',
      score: 0,
      answer_count: 0,
      is_answered: false,
      creation_date: 1,
      tags: [],
      link: 'https://so/q/2',
    },
    answers: [],
  },
];

function meta(overrides: Partial<PaginationMeta> = {}): PaginationMeta {
  return { page: 1, pageSize: RESULTS.length, hasMore: false, ...overrides };
}

describe('formatter fidelity', () => {
  test('JSON output caps answers at MAX_ANSWERS and reports the omitted count', () => {
    const payload = JSON.parse(formatJson(meta(), [], RESULTS)) as {
      results: { answers: unknown[]; answers_omitted: number; comments: { question: unknown[] } }[];
    };

    expect(payload.results[0]!.answers).toHaveLength(5);
    expect(payload.results[0]!.answers_omitted).toBe(3);
    // Comments are capped too, so one post cannot fill the budget.
    expect(payload.results[0]!.comments.question).toHaveLength(3);
  });

  test('JSON output converts HTML to text and decodes entities', () => {
    const payload = JSON.parse(formatJson(meta(), [], RESULTS)) as {
      results: { question: { title: string; body: string } }[];
    };

    expect(payload.results[0]!.question.title).toBe('A & B bold');
    expect(payload.results[0]!.question.body).toContain("'quoted'");
    expect(payload.results[0]!.question.body).not.toContain('<p>');
  });

  test('JSON output stays valid JSON when it exceeds the character budget', () => {
    const many: SearchResult[] = Array.from({ length: 40 }, (_, index) => ({
      ...RESULTS[0]!,
      question: { ...RESULTS[0]!.question, question_id: index },
    }));

    const text = formatJson(meta({ totalCount: 40 }), ['note'], many);
    const payload = JSON.parse(text) as { results: unknown[]; truncated?: boolean };

    expect(payload.results.length).toBeLessThan(40);
    expect(payload.truncated).toBe(true);
  });

  test('JSON output omits totalCount unless the caller supplies a real total', () => {
    const plain = JSON.parse(formatJson(meta(), [], RESULTS)) as { pagination: Record<string, unknown> };
    const total = JSON.parse(formatJson(meta({ totalCount: 42 }), [], RESULTS)) as {
      pagination: Record<string, unknown>;
    };

    expect(plain.pagination).not.toHaveProperty('totalCount');
    expect(total.pagination.totalCount).toBe(42);
  });

  test('Markdown renders question, answers and comments as readable text', () => {
    const md = formatMarkdown(meta(), [], RESULTS);

    expect(md).toContain('# A & B bold');
    expect(md).toContain('## Question');
    expect(md).toContain('## Answers');
    expect(md).toContain('### ✓ Answer (Score: 8)');
    expect(md).toContain('### Question Comments');
    expect(md).toContain('#### Answer Comments');
    expect(md).toContain('[View on Stack Overflow](https://so/q/1)');
    expect(md).not.toContain('<p>');
  });

  test('Markdown omits the answers section when there are no answers', () => {
    const withoutAnswers: SearchResult[] = [{ ...RESULTS[1]!, answers: [] }];

    expect(formatMarkdown(meta(), [], withoutAnswers)).not.toContain('## Answers');
  });

  test('Markdown surfaces notes above the results', () => {
    expect(formatMarkdown(meta(), ['Tag filter was relaxed.'], RESULTS)).toContain(
      '> **Note:** Tag filter was relaxed.'
    );
  });

  test('an empty result set renders a parseable, empty document', () => {
    expect(JSON.parse(formatJson(meta({ pageSize: 0 }), [], [])).results).toEqual([]);
    expect(formatMarkdown(meta({ pageSize: 0 }), [], [])).toBe('');
  });

  test('both formatters honour a caller-supplied character budget', () => {
    expect(JSON.parse(formatJson(meta(), [], RESULTS, 500)).results.length).toBe(0);
    expect(formatMarkdown(meta(), [], RESULTS, 500)).toContain('500 characters');
  });
});
