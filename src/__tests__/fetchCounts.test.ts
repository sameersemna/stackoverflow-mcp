/**
 * Fetch-count budget tests.
 *
 * Responsibility: pin the exact number of upstream Stack Exchange requests each
 * tool makes. Quota is the scarcest resource (~300/day per IP without a key),
 * so any regression in call count must fail loudly here rather than silently
 * burn the owner's daily allowance.
 *
 * The numbers in this file mirror the "API-call budget table" in `PROGRESS.md`.
 * When Phase 4 reduces them, update both together.
 */
import { describe, expect, test, beforeEach, afterEach, jest } from '@jest/globals';
import { StackOverflowServer } from '../server.js';
import { emptyApiResponse, installFetchHarness, type FetchHarness } from './helpers/fetchHarness.js';

const QUESTION = {
  question_id: 12345,
  title: 'How do I fix TypeError: boom?',
  body: '<p>body</p>',
  score: 10,
  answer_count: 2,
  is_answered: true,
  accepted_answer_id: 67890,
  creation_date: 1615000000,
  tags: ['javascript'],
  link: 'https://stackoverflow.com/q/12345',
};

const ANSWER = {
  answer_id: 67890,
  question_id: 12345,
  score: 5,
  is_accepted: true,
  body: '<p>answer</p>',
  creation_date: 1615100000,
  link: 'https://stackoverflow.com/a/67890',
};

const COMMENT = {
  comment_id: 54321,
  post_id: 12345,
  score: 3,
  body: '<p>comment</p>',
  creation_date: 1615050000,
};

/** Responses for a search that matches on the first attempt. */
function matchingRoutes(): Record<string, unknown> {
  return {
    '/search/advanced': { body: emptyApiResponse({ items: [QUESTION] }) },
    '/questions': { body: emptyApiResponse({ items: [QUESTION] }) },
    '/questions/12345': { body: emptyApiResponse({ items: [QUESTION] }) },
    '/questions/12345/answers': { body: emptyApiResponse({ items: [ANSWER] }) },
    '/posts/12345;67890/comments': { body: emptyApiResponse({ items: [COMMENT] }) },
  };
}

describe('API call budget', () => {
  let server: StackOverflowServer;
  let harness: FetchHarness;

  beforeEach(() => {
    server = new StackOverflowServer();
    harness = installFetchHarness({ routes: matchingRoutes() });
  });

  afterEach(() => {
    harness.restore();
  });

  test('search_by_error: 1 search + 1 answers = 2 calls (no comments)', async () => {
    const result = await (server as never as {
      handleSearchByError: (input: unknown) => Promise<{ isError?: boolean }>;
    }).handleSearchByError({ errorMessage: 'TypeError: boom', limit: 2 });

    expect(result.isError).toBeFalsy();
    harness.assertCallsTo('/search/advanced', 1);
    harness.assertCallsTo('/questions/12345/answers', 1);
    harness.assertCallCount(2);
  });

  test('search_by_error with includeComments: +1 comments call = 3 calls', async () => {
    const result = await (server as never as {
      handleSearchByError: (input: unknown) => Promise<{ isError?: boolean }>;
    }).handleSearchByError({ errorMessage: 'TypeError: boom', limit: 2, includeComments: true });

    expect(result.isError).toBeFalsy();
    harness.assertCallsTo('/search/advanced', 1);
    harness.assertCallCount(3);
  });

  test('search_by_tags: 1 questions + 1 answers = 2 calls', async () => {
    const result = await (server as never as {
      handleSearchByTags: (input: unknown) => Promise<{ isError?: boolean }>;
    }).handleSearchByTags({ tags: ['javascript'], limit: 2 });

    expect(result.isError).toBeFalsy();
    harness.assertCallsTo('/questions', 1);
    harness.assertCallsTo('/questions/12345/answers', 1);
    harness.assertCallCount(2);
  });

  test('search_by_question_id: 1 question + 1 answers = 2 calls', async () => {
    const result = await (server as never as {
      handleSearchByQuestionId: (input: unknown) => Promise<{ isError?: boolean }>;
    }).handleSearchByQuestionId({ questionId: 12345 });

    expect(result.isError).toBeFalsy();
    harness.assertCallsTo('/questions/12345', 1);
    harness.assertCallCount(2);
  });

  test('search_by_question_id with includeAnswers false: 1 call only', async () => {
    const result = await (server as never as {
      handleSearchByQuestionId: (input: unknown) => Promise<{ isError?: boolean }>;
    }).handleSearchByQuestionId({ questionId: 12345, includeAnswers: false });

    expect(result.isError).toBeFalsy();
    harness.assertCallCount(1);
  });

  test('a repeated identical search is served from the cache (0 extra calls)', async () => {
    const invoke = () =>
      (server as never as {
        handleSearchByError: (input: unknown) => Promise<{ isError?: boolean }>;
      }).handleSearchByError({ errorMessage: 'TypeError: boom', limit: 2 });

    await invoke();
    const afterFirst = harness.callCount();
    await invoke();

    expect(harness.callCount()).toBe(afterFirst);
  });

  test('the API key is sent as the `key` parameter when configured at process start', async () => {
    // The server parses its configuration once at module load, so the key must
    // be present before a fresh module registry is imported. Injecting config
    // per instance is Phase 7 work (`config.ts`).
    const original = process.env.STACKOVERFLOW_API_KEY;
    process.env.STACKOVERFLOW_API_KEY = 'test-key-value';
    try {
      jest.resetModules();
      const fresh = (await import('../server.js')) as typeof import('../server.js');
      const keyedServer = new fresh.StackOverflowServer();

      await (keyedServer as never as {
        handleSearchByQuestionId: (input: unknown) => Promise<{ isError?: boolean }>;
      }).handleSearchByQuestionId({ questionId: 12345 });

      expect(harness.calls.length).toBeGreaterThan(0);
      expect(harness.calls[0]?.apiKey).toBe('test-key-value');
    } finally {
      if (original === undefined) {
        delete process.env.STACKOVERFLOW_API_KEY;
      } else {
        process.env.STACKOVERFLOW_API_KEY = original;
      }
    }
  });
});
