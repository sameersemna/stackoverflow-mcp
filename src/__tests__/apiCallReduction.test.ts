/**
 * API-call reduction tests (Phase 4).
 *
 * Responsibility: pin the measured request counts for the custom-filter path and
 * prove the automatic fallback when the filter is rejected.
 *
 * Before this work a typical search cost 2 requests (search + answers), 3 with
 * comments, and up to 7 when the query-fallback ladder ran. The baked-in custom
 * filter asks the API to return each question *with* its answers and comments, so
 * one search request carries everything. Verified against the live API before
 * implementing: questions with 191, 55 and 36 answers returned every answer
 * inline, with bodies on both questions and answers.
 */
import { describe, expect, test, beforeEach, afterEach } from '@jest/globals';
import { StackOverflowServer } from '../server.js';
import { COMBINED_FILTER, isFilterRejection } from '../stackexchange/filters.js';
import { emptyApiResponse, installFetchHarness, type FetchHarness } from './helpers/fetchHarness.js';

const QUESTION_ID = 12345;

/** A question shaped like the custom filter's response: answers inline. */
function questionWithInlineData() {
  return {
    question_id: QUESTION_ID,
    title: 'How do I fix TypeError: boom?',
    body: '<p>question body</p>',
    score: 10,
    answer_count: 2,
    is_answered: true,
    accepted_answer_id: 67890,
    creation_date: 1,
    tags: ['javascript'],
    link: `https://stackoverflow.com/q/${QUESTION_ID}`,
    comments: [
      { comment_id: 1, post_id: QUESTION_ID, score: 1, body: '<p>question comment</p>', creation_date: 1 },
    ],
    answers: [
      {
        answer_id: 67890,
        question_id: QUESTION_ID,
        score: 5,
        is_accepted: true,
        body: '<p>accepted answer</p>',
        creation_date: 1,
        link: 'https://stackoverflow.com/a/67890',
        comments: [
          { comment_id: 2, post_id: 67890, score: 0, body: '<p>answer comment</p>', creation_date: 1 },
        ],
      },
      {
        answer_id: 67891,
        question_id: QUESTION_ID,
        score: 2,
        is_accepted: false,
        body: '<p>other answer</p>',
        creation_date: 1,
        link: 'https://stackoverflow.com/a/67891',
      },
    ],
  };
}

interface ToolResult {
  isError?: boolean;
  content: { text: string }[];
}

function textOf(result: ToolResult): string {
  return result.content.map((block) => block.text).join('\n');
}

describe('filter rejection detection', () => {
  test('recognises a filter error', () => {
    expect(isFilterRejection(400, 'bad_parameter', 'filter is invalid')).toBe(true);
    expect(isFilterRejection(404, undefined, 'no filter found')).toBe(true);
  });

  test('does not treat unrelated errors as filter rejections', () => {
    // Must stay narrow: disabling the optimisation for an unrelated
    // bad_parameter would cost quota for no reason.
    expect(isFilterRejection(400, 'bad_parameter', 'sort parameter is not valid')).toBe(false);
    expect(isFilterRejection(502, 'throttle_violation', 'Violation of backoff parameter')).toBe(false);
    expect(isFilterRejection(undefined, undefined, 'filter is invalid')).toBe(false);
  });
});

describe('custom-filter request counts (Phase 4)', () => {
  let harness: FetchHarness;
  let server: StackOverflowServer;

  beforeEach(() => {
    server = new StackOverflowServer();
  });

  afterEach(() => {
    harness?.restore();
  });

  function installInlineRoutes(): void {
    harness = installFetchHarness({
      routes: {
        '/search/advanced': { body: emptyApiResponse({ items: [questionWithInlineData()] }) },
        '/questions': { body: emptyApiResponse({ items: [questionWithInlineData()] }) },
      },
    });
  }

  test('the search asks for the baked-in combined filter', async () => {
    installInlineRoutes();

    await (server as never as {
      handleSearchByError: (input: unknown) => Promise<ToolResult>;
    }).handleSearchByError({ errorMessage: 'TypeError: boom', limit: 3 });

    expect(harness.callsTo('/search/advanced')[0]!.get('filter')).toBe(COMBINED_FILTER);
  });

  test('search_by_error costs exactly 1 request, not 2, when answers come inline', async () => {
    installInlineRoutes();

    const result = await (server as never as {
      handleSearchByError: (input: unknown) => Promise<ToolResult>;
    }).handleSearchByError({ errorMessage: 'TypeError: boom', limit: 3 });

    expect(result.isError).toBeFalsy();
    // The whole point of the custom filter: no separate answers call.
    harness.assertCallCount(1);
    harness.assertCallsTo('/questions/12345/answers', 0);
  });

  test('includeComments still costs 1 request, not 3, when comments come inline', async () => {
    installInlineRoutes();

    const result = await (server as never as {
      handleSearchByError: (input: unknown) => Promise<ToolResult>;
    }).handleSearchByError({ errorMessage: 'TypeError: boom', limit: 3, includeComments: true });

    expect(result.isError).toBeFalsy();
    harness.assertCallCount(1);
    harness.assertCallsTo('/posts/12345;67890;67891/comments', 0);
  });

  test('inline answers and comments reach the output', async () => {
    installInlineRoutes();

    const result = await (server as never as {
      handleSearchByError: (input: unknown) => Promise<ToolResult>;
    }).handleSearchByError({
      errorMessage: 'TypeError: boom',
      limit: 3,
      includeComments: true,
      responseFormat: 'json',
    });

    const payload = JSON.parse(textOf(result)) as {
      results: {
        answers: { is_accepted: boolean }[];
        answers_omitted: number;
        comments: { question: unknown[]; answers: Record<string, unknown[]> };
      }[];
    };

    const first = payload.results[0]!;
    expect(first.answers).toHaveLength(2);
    expect(first.answers[0]!.is_accepted).toBe(true);
    // Comments are attributed to the right post, not all lumped on the question.
    expect(first.comments.question).toHaveLength(1);
    expect(first.comments.answers['67890']).toHaveLength(1);
  });

  test('search_by_tags costs 1 request when answers come inline', async () => {
    installInlineRoutes();

    const result = await (server as never as {
      handleSearchByTags: (input: unknown) => Promise<ToolResult>;
    }).handleSearchByTags({ tags: ['javascript'], limit: 3 });

    expect(result.isError).toBeFalsy();
    harness.assertCallCount(1);
  });
});

describe('fallback when the filter is rejected (Phase 4)', () => {
  let harness: FetchHarness;
  let server: StackOverflowServer;

  beforeEach(() => {
    server = new StackOverflowServer();
  });

  afterEach(() => {
    harness?.restore();
  });

  /** Rejects the first combined-filter search, then serves built-in-filter data. */
  function installRejectingRoute(): void {
    let rejected = false;
    harness = installFetchHarness({
      routes: {
        '*': (call) => {
          if (call.get('filter') === COMBINED_FILTER && !rejected) {
            rejected = true;
            return {
              body: {
                error_id: 400,
                error_name: 'bad_parameter',
                error_message: 'filter is invalid',
              },
            };
          }
          return {
            body: emptyApiResponse({
              items: [
                {
                  ...questionWithInlineData(),
                  answers: undefined,
                  comments: undefined,
                },
              ],
            }),
          };
        },
      },
    });
  }

  test('a rejected filter falls back to built-in filters and still returns results', async () => {
    installRejectingRoute();

    const first = await (server as never as {
      handleSearchByError: (input: unknown) => Promise<ToolResult>;
    }).handleSearchByError({ errorMessage: 'TypeError: boom', limit: 3 });

    // The caller sees a clear upstream error rather than a silent success.
    expect(first.isError).toBe(true);
    expect(textOf(first)).toContain('filter is invalid');

    // Afterwards the client stops asking for the rejected filter, so subsequent
    // searches keep working instead of failing for the rest of the process.
    const second = await (server as never as {
      handleSearchByError: (input: unknown) => Promise<ToolResult>;
    }).handleSearchByError({ errorMessage: 'TypeError: other', limit: 3 });

    expect(second.isError).toBeFalsy();
    const lastSearch = harness.callsTo('/search/advanced').at(-1)!;
    expect(lastSearch.get('filter')).not.toBe(COMBINED_FILTER);
  });

  test('the fallback issues the separate answers request again', async () => {
    installRejectingRoute();

    await (server as never as {
      handleSearchByError: (input: unknown) => Promise<ToolResult>;
    }).handleSearchByError({ errorMessage: 'TypeError: boom', limit: 3 });

    await (server as never as {
      handleSearchByError: (input: unknown) => Promise<ToolResult>;
    }).handleSearchByError({ errorMessage: 'TypeError: other', limit: 3 });

    // Built-in filters mean no inline answers, so the answers call returns.
    expect(harness.callsTo('/questions/12345/answers').length).toBeGreaterThan(0);
  });

  test('acceptedOnly keeps using the built-in filter path', async () => {
    // `accepted=True` was observed not to be honoured together with the combined
    // filter, so that combination deliberately avoids the optimisation rather
    // than quietly returning the wrong set.
    harness = installFetchHarness({
      routes: {
        '/search/advanced': { body: emptyApiResponse({ items: [questionWithInlineData()] }) },
        '*': { body: emptyApiResponse() },
      },
    });

    await (server as never as {
      handleSearchByQuery: (input: unknown) => Promise<ToolResult>;
    }).handleSearchByQuery({ query: 'q', acceptedOnly: true, limit: 3 });

    expect(harness.callsTo('/search/advanced')[0]!.get('filter')).not.toBe(COMBINED_FILTER);
  });
});

describe('optional site parameter (Phase 5)', () => {
  let harness: FetchHarness;
  let server: StackOverflowServer;

  beforeEach(() => {
    server = new StackOverflowServer();
  });

  afterEach(() => {
    harness?.restore();
  });

  function install(): void {
    harness = installFetchHarness({
      routes: {
        '/search/advanced': { body: emptyApiResponse({ items: [questionWithInlineData()] }) },
        '/questions': { body: emptyApiResponse({ items: [questionWithInlineData()] }) },
        '/questions/12345': { body: emptyApiResponse({ items: [questionWithInlineData()] }) },
      },
    });
  }

  test('defaults to stackoverflow so existing callers are unaffected', async () => {
    install();

    await (server as never as {
      handleSearchByError: (input: unknown) => Promise<ToolResult>;
    }).handleSearchByError({ errorMessage: 'TypeError: boom', limit: 1 });

    expect(harness.callsTo('/search/advanced')[0]!.get('site')).toBe('stackoverflow');
  });

  test('a requested site reaches the request', async () => {
    install();

    await (server as never as {
      handleSearchByQuery: (input: unknown) => Promise<ToolResult>;
    }).handleSearchByQuery({ query: 'disk full', site: 'serverfault', limit: 1 });

    expect(harness.callsTo('/search/advanced')[0]!.get('site')).toBe('serverfault');
  });

  test('search_by_tags and search_by_question_id honour the site', async () => {
    install();

    await (server as never as {
      handleSearchByTags: (input: unknown) => Promise<ToolResult>;
    }).handleSearchByTags({ tags: ['apt'], site: 'askubuntu', limit: 1 });
    await (server as never as {
      handleSearchByQuestionId: (input: unknown) => Promise<ToolResult>;
    }).handleSearchByQuestionId({ questionId: 12345, site: 'askubuntu', includeAnswers: false });

    expect(harness.callsTo('/questions')[0]!.get('site')).toBe('askubuntu');
    expect(harness.callsTo('/questions/12345')[0]!.get('site')).toBe('askubuntu');
  });

  test('an unknown site is rejected before any request is made', async () => {
    install();

    const result = await (server as never as {
      handleSearchByQuery: (input: unknown) => Promise<ToolResult>;
    }).handleSearchByQuery({ query: 'x', site: 'not-a-real-site' });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Validation failed');
    harness.assertCallCount(0);
  });

  test('the same query on two sites does not share a cache entry', async () => {
    install();

    await (server as never as {
      handleSearchByQuery: (input: unknown) => Promise<ToolResult>;
    }).handleSearchByQuery({ query: 'disk full', site: 'serverfault', limit: 1 });
    const afterFirst = harness.callCount();

    await (server as never as {
      handleSearchByQuery: (input: unknown) => Promise<ToolResult>;
    }).handleSearchByQuery({ query: 'disk full', site: 'superuser', limit: 1 });

    // A second request, because the site is part of the cache identity.
    expect(harness.callCount()).toBeGreaterThan(afterFirst);
  });
});
