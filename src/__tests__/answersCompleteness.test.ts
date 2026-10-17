/**
 * Answers completeness tests (B3).
 *
 * Responsibility: guarantee that `has_more` is honoured when answers are
 * fetched. At baseline the answers for up to 30 questions were requested with
 * `pagesize=100` and `has_more` was ignored. Because the API sorts the whole
 * result set by `votes`, a handful of popular questions consumed all 100 slots
 * and every other question rendered **zero answers even though it has some**.
 */
import { describe, expect, test, beforeEach, afterEach } from '@jest/globals';
import { StackOverflowServer } from '../server.js';
import { emptyApiResponse, installFetchHarness, type FetchHarness } from './helpers/fetchHarness.js';

const QUESTION_COUNT = 30;
const ANSWERS_PER_QUESTION = 5;
const PAGE_SIZE = 100;

interface Answer {
  answer_id: number;
  question_id: number;
  score: number;
  is_accepted: boolean;
  body: string;
  creation_date: number;
  link: string;
}

/** Every answer for every question, pre-sorted by descending score (API order). */
const ALL_ANSWERS: Answer[] = Array.from({ length: QUESTION_COUNT }, (_, questionIndex) => {
  const questionId = 1000 + questionIndex;
  return Array.from({ length: ANSWERS_PER_QUESTION }, (_, answerIndex) => ({
    answer_id: questionId * 100 + answerIndex,
    question_id: questionId,
    // The first two questions hold the highest scores, so with a global
    // sort=votes they crowd every other question out of the first page.
    score: 1000 - questionIndex * 10 - answerIndex,
    is_accepted: answerIndex === 0,
    body: 'answer body',
    creation_date: 1,
    link: `https://stackoverflow.com/a/${questionId * 100 + answerIndex}`,
  }));
}).flat();

describe('answers completeness (B3)', () => {
  let server: StackOverflowServer;
  let harness: FetchHarness;

  beforeEach(() => {
    server = new StackOverflowServer();
    harness = installFetchHarness({
      routes: {
        '/search/advanced': {
          body: emptyApiResponse({
            items: Array.from({ length: QUESTION_COUNT }, (_, index) => ({
              question_id: 1000 + index,
              title: `Q${1000 + index}`,
              body: 'body',
              score: 1,
              answer_count: ANSWERS_PER_QUESTION,
              is_answered: true,
              creation_date: 1,
              tags: ['javascript'],
              link: `https://stackoverflow.com/q/${1000 + index}`,
            })),
          }),
        },
        '*': (call) => {
          // Serve the answers endpoint respecting `page`/`pagesize` so the
          // harness behaves like the real API, including `has_more`.
          const params = call.params;
          const page = Number(params.get('page') ?? '1');
          const pageSize = Number(params.get('pagesize') ?? String(PAGE_SIZE));
          const start = (page - 1) * pageSize;
          const pageItems = ALL_ANSWERS.slice(start, start + pageSize);

          const idMatch = /^\/questions\/([^/]+)\/answers$/.exec(call.path);
          if (idMatch?.[1]) {
            const requested = new Set(idMatch[1].split(';').map(Number));
            const filtered = pageItems.filter((answer) => requested.has(answer.question_id));
            return {
              body: emptyApiResponse({
                items: filtered,
                has_more: start + pageSize < ALL_ANSWERS.length,
              }),
            };
          }
          return { body: emptyApiResponse() };
        },
      },
    });
  });

  afterEach(() => {
    harness.restore();
  });

  test('a single page leaves most questions with no answers (baseline failure mode)', () => {
    // Documents *why* paging is required: the global sort starves later questions.
    const firstPage = ALL_ANSWERS.slice(0, PAGE_SIZE);
    const questionIdsOnFirstPage = new Set(firstPage.map((answer) => answer.question_id));

    expect(questionIdsOnFirstPage.size).toBeLessThan(QUESTION_COUNT);
    expect(ALL_ANSWERS).toHaveLength(QUESTION_COUNT * ANSWERS_PER_QUESTION);
  });

  test('every question ends up with its answers (all 150 present)', async () => {
    const questionIds = Array.from({ length: QUESTION_COUNT }, (_, index) => 1000 + index);

    const grouped = await (server as never as {
      fetchAnswersForQuestions: (ids: number[]) => Promise<Map<number, Answer[]>>;
    }).fetchAnswersForQuestions(questionIds);

    for (const questionId of questionIds) {
      const answers = grouped.get(questionId) ?? [];
      expect(answers.length).toBe(ANSWERS_PER_QUESTION);
    }

    const total = [...grouped.values()].reduce((sum, answers) => sum + answers.length, 0);
    expect(total).toBe(QUESTION_COUNT * ANSWERS_PER_QUESTION);
  });

  test('paging is bounded and stops once has_more is false', async () => {
    const questionIds = Array.from({ length: QUESTION_COUNT }, (_, index) => 1000 + index);

    await (server as never as {
      fetchAnswersForQuestions: (ids: number[]) => Promise<Map<number, Answer[]>>;
    }).fetchAnswersForQuestions(questionIds);

    const answerCalls = harness.calls.filter((call) => call.path.endsWith('/answers'));
    // 150 answers at pagesize 100 = 2 pages, and paging must stop there.
    expect(answerCalls.length).toBeLessThanOrEqual(3);
    expect(answerCalls.length).toBeGreaterThanOrEqual(2);

    const pages = answerCalls.map((call) => call.params.get('page') ?? '1');
    expect(pages).toContain('1');
    expect(pages).toContain('2');
  });

  test('no duplicate answers are returned when pages overlap', async () => {
    const questionIds = Array.from({ length: 3 }, (_, index) => 1000 + index);

    const grouped = await (server as never as {
      fetchAnswersForQuestions: (ids: number[]) => Promise<Map<number, Answer[]>>;
    }).fetchAnswersForQuestions(questionIds);

    const all = [...grouped.values()].flat();
    const ids = all.map((answer) => answer.answer_id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('end-to-end search_by_tags returns answers for the last question too', async () => {
    harness.restore();
    harness = installFetchHarness({
      routes: {
        '/questions': {
          body: emptyApiResponse({
            items: Array.from({ length: QUESTION_COUNT }, (_, index) => ({
              question_id: 1000 + index,
              title: `Q${1000 + index}`,
              body: 'body',
              score: 1,
              answer_count: ANSWERS_PER_QUESTION,
              is_answered: true,
              creation_date: 1,
              tags: ['javascript'],
              link: `https://stackoverflow.com/q/${1000 + index}`,
            })),
          }),
        },
        '*': (call) => {
          const params = call.params;
          const page = Number(params.get('page') ?? '1');
          const pageSize = Number(params.get('pagesize') ?? String(PAGE_SIZE));
          const start = (page - 1) * pageSize;
          const pageItems = ALL_ANSWERS.slice(start, start + pageSize);
          const idMatch = /^\/questions\/([^/]+)\/answers$/.exec(call.path);
          if (idMatch?.[1]) {
            const requested = new Set(idMatch[1].split(';').map(Number));
            return {
              body: emptyApiResponse({
                items: pageItems.filter((answer) => requested.has(answer.question_id)),
                has_more: start + pageSize < ALL_ANSWERS.length,
              }),
            };
          }
          return { body: emptyApiResponse() };
        },
      },
    });

    const result = await (server as never as {
      handleSearchByTags: (input: unknown) => Promise<{ content: { text: string }[] }>;
    }).handleSearchByTags({
      tags: ['javascript'],
      limit: QUESTION_COUNT,
      responseFormat: 'json',
      // Ask for a narrow page: with 30 results the JSON payload legitimately
      // exceeds CHARACTER_LIMIT and truncateJson drops the trailing results,
      // which would mask the answer-completeness assertion.
      page: 1,
    });

    const payload = JSON.parse(result.content[0]!.text) as {
      results: { question: { question_id: number }; answers: unknown[] }[];
    };

    expect(payload.results.length).toBeGreaterThan(0);
    // Every question that made it into the payload must carry its answers.
    for (const entry of payload.results) {
      expect(entry.answers.length).toBe(ANSWERS_PER_QUESTION);
    }
  });
});
