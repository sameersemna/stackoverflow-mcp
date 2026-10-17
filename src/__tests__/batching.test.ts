/**
 * Vectorized-request batching tests (B2).
 *
 * Responsibility: guarantee that semicolon-separated ID lists never exceed the
 * Stack Exchange cap of 100 IDs per request. At baseline a single comments call
 * carried 144+ IDs (4 questions + all their answers) and the real API rejects
 * such a request with an error, so `includeComments: true` failed on larger
 * result sets.
 */
import { describe, expect, test, beforeEach, afterEach } from '@jest/globals';
import { StackOverflowServer } from '../server.js';
import { emptyApiResponse, installFetchHarness, type FetchHarness } from './helpers/fetchHarness.js';

/** The Stack Exchange documented maximum for vectorized ID lists. */
const MAX_IDS_PER_REQUEST = 100;

const QUESTION_COUNT = 4;
const ANSWERS_PER_QUESTION = 40;

const QUESTIONS = Array.from({ length: QUESTION_COUNT }, (_, index) => {
  const questionId = 1000 + index;
  return {
    question_id: questionId,
    title: `Q${questionId}`,
    body: 'body',
    score: 1,
    answer_count: ANSWERS_PER_QUESTION,
    is_answered: true,
    creation_date: 1,
    tags: ['javascript'],
    link: `https://stackoverflow.com/q/${questionId}`,
  };
});

/** Answers are keyed by question so we can serve only the requested subset. */
const ANSWERS_BY_QUESTION = new Map<number, { answer_id: number; question_id: number }[]>(
  QUESTIONS.map((question) => [
    question.question_id,
    Array.from({ length: ANSWERS_PER_QUESTION }, (_, index) => ({
      answer_id: question.question_id * 100 + index,
      question_id: question.question_id,
    })),
  ])
);

function parseIds(path: string): number[] {
  const match = /^\/(?:questions|posts)\/([^/]+)\//.exec(path);
  if (!match || !match[1]) {
    return [];
  }
  return match[1]
    .split(';')
    .map((id) => Number(id))
    .filter((id) => Number.isFinite(id));
}

describe('vectorized request batching (B2)', () => {
  let server: StackOverflowServer;
  let harness: FetchHarness;

  beforeEach(() => {
    server = new StackOverflowServer();
    harness = installFetchHarness({
      routes: {
        '/search/advanced': { body: emptyApiResponse({ items: QUESTIONS }) },
        '*': (call) => {
          const ids = parseIds(call.path);
          if (call.path.endsWith('/answers')) {
            const items = ids.flatMap((questionId) => ANSWERS_BY_QUESTION.get(questionId) ?? []);
            return { body: emptyApiResponse({ items }) };
          }
          if (call.path.endsWith('/comments')) {
            const items = ids.map((postId) => ({
              comment_id: postId * 1000,
              post_id: postId,
              score: 1,
              body: 'comment',
              creation_date: 1,
            }));
            return { body: emptyApiResponse({ items }) };
          }
          return { body: emptyApiResponse() };
        },
      },
    });
  });

  afterEach(() => {
    harness.restore();
  });

  test('no request ever carries more than 100 ids', async () => {
    await (server as never as {
      handleSearchByError: (input: unknown) => Promise<unknown>;
    }).handleSearchByError({ errorMessage: 'boom', limit: QUESTION_COUNT, includeComments: true });

    const offenders = harness.calls
      .filter((call) => /\/(questions|posts)\//.test(call.path))
      .map((call) => ({ path: call.path, idCount: parseIds(call.path).length }))
      .filter((entry) => entry.idCount > MAX_IDS_PER_REQUEST);

    expect(offenders).toEqual([]);
    expect(harness.calls.length).toBeGreaterThan(0);
  });

  test('comments for 164 posts are fetched in chunks of at most 100', async () => {
    const postIds = [
      ...QUESTIONS.map((question) => question.question_id),
      ...QUESTIONS.flatMap((question) =>
        (ANSWERS_BY_QUESTION.get(question.question_id) ?? []).map((answer) => answer.answer_id)
      ),
    ];
    expect(postIds).toHaveLength(QUESTION_COUNT * (1 + ANSWERS_PER_QUESTION));

    const grouped = await (server as never as {
      fetchCommentsForPosts: (ids: number[]) => Promise<Map<number, unknown[]>>;
    }).fetchCommentsForPosts(postIds);

    const commentCalls = harness.calls.filter((call) => call.path.endsWith('/comments'));
    expect(commentCalls).toHaveLength(Math.ceil(postIds.length / MAX_IDS_PER_REQUEST));
    for (const call of commentCalls) {
      expect(parseIds(call.path).length).toBeLessThanOrEqual(MAX_IDS_PER_REQUEST);
    }

    // No silent data loss: every requested post must map to its comment.
    expect(grouped.size).toBe(postIds.length);
    for (const postId of postIds) {
      expect(grouped.get(postId)).toHaveLength(1);
    }
  });

  test('answers for exactly 100 questions still fit in a single request', async () => {
    const questionIds = Array.from({ length: MAX_IDS_PER_REQUEST }, (_, index) => 5000 + index);

    await (server as never as {
      fetchAnswersForQuestions: (ids: number[]) => Promise<Map<number, unknown[]>>;
    }).fetchAnswersForQuestions(questionIds);

    const answerCalls = harness.calls.filter((call) => call.path.endsWith('/answers'));
    expect(answerCalls).toHaveLength(1);
    expect(parseIds(answerCalls[0]!.path)).toHaveLength(MAX_IDS_PER_REQUEST);
  });

  test('answers for more than 100 questions are split', async () => {
    const questionIds = Array.from({ length: 130 }, (_, index) => 6000 + index);

    await (server as never as {
      fetchAnswersForQuestions: (ids: number[]) => Promise<Map<number, unknown[]>>;
    }).fetchAnswersForQuestions(questionIds);

    const answerCalls = harness.calls.filter((call) => call.path.endsWith('/answers'));
    expect(answerCalls).toHaveLength(2);
    const totalIds = answerCalls.reduce((sum, call) => sum + parseIds(call.path).length, 0);
    expect(totalIds).toBe(130);
  });

  test('end-to-end comment fetching completes and stays within the cap', async () => {
    const result = await (server as never as {
      handleSearchByError: (input: unknown) => Promise<{ isError?: boolean }>;
    }).handleSearchByError({ errorMessage: 'boom', limit: QUESTION_COUNT, includeComments: true });

    expect(result.isError).toBeFalsy();

    const commentCalls = harness.calls.filter((call) => call.path.endsWith('/comments'));
    expect(commentCalls).toHaveLength(Math.ceil((QUESTION_COUNT * (1 + ANSWERS_PER_QUESTION)) / MAX_IDS_PER_REQUEST));
    for (const call of commentCalls) {
      expect(parseIds(call.path).length).toBeLessThanOrEqual(MAX_IDS_PER_REQUEST);
    }
  });
});
