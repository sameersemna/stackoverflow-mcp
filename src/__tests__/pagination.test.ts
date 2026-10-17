/**
 * Pagination-consistency tests (B4).
 *
 * Responsibility: guarantee that the query-shortening / tag-relaxation fallback
 * only ever runs for **page 1**, and that a response states which query and tags
 * actually produced it.
 *
 * At baseline the fallback also ran for page > 1. A page-2 request for a valid
 * query legitimately returns nothing (end of results), and the server then
 * answered with page 2 of a *different, broader* query — so page 1 and page 2
 * came from unrelated searches and the client could not tell.
 */
import { describe, expect, test, beforeEach, afterEach } from '@jest/globals';
import { StackOverflowServer } from '../server.js';
import { emptyApiResponse, installFetchHarness, type FetchHarness } from './helpers/fetchHarness.js';
import type { PagedSearchResults } from '../types/index.js';

const QUESTION = {
  question_id: 12345,
  title: 'Q',
  body: 'body',
  score: 1,
  answer_count: 0,
  is_answered: false,
  creation_date: 1,
  tags: ['javascript'],
  link: 'https://stackoverflow.com/q/12345',
};

interface SearchCapableServer {
  searchStackOverflow: (
    query: string,
    tags?: string[],
    options?: { page?: number; limit?: number }
  ) => Promise<PagedSearchResults>;
}

describe('fallback and page consistency (B4)', () => {
  let server: StackOverflowServer;
  let harness: FetchHarness;

  beforeEach(() => {
    server = new StackOverflowServer();
  });

  afterEach(() => {
    harness?.restore();
  });

  test('the fallback does not run for page > 1 (exact query, exact page)', async () => {
    harness = installFetchHarness({
      routes: { '*': { body: emptyApiResponse({ items: [], has_more: false }) } },
    });

    const result = await (server as never as SearchCapableServer).searchStackOverflow(
      'Cannot read property map of undefined',
      ['react'],
      { page: 2, limit: 5 }
    );

    // Exactly one request: the original query, at page 2. No variant ladder and
    // no tag relaxation, because an empty page 2 is the normal end of results.
    harness.assertCallCount(1);
    expect(harness.calls[0]!.get('q')).toBe('Cannot read property map of undefined');
    expect(harness.calls[0]!.get('page')).toBe('2');
    expect(harness.calls[0]!.get('tagged')).toBe('react');
    expect(result.results).toEqual([]);
    expect(result.page).toBe(2);
  });

  test('page 1 still falls back through shorter query variants', async () => {
    let seen = 0;
    harness = installFetchHarness({
      routes: {
        '*': () => {
          seen += 1;
          return {
            body: emptyApiResponse({
              items: seen >= 2 ? [QUESTION] : [],
              has_more: false,
            }),
          };
        },
      },
    });

    const result = await (server as never as SearchCapableServer).searchStackOverflow(
      'Cannot read property map of undefined something extra',
      undefined,
      { page: 1, limit: 5 }
    );

    expect(harness.callCount()).toBeGreaterThanOrEqual(2);
    expect(result.results).toHaveLength(1);
    // The response states which query actually produced the results so the
    // client can page through that variant rather than the original.
    expect(result.usedFallback).toBe(true);
    expect(result.effectiveQuery).not.toBe('Cannot read property map of undefined something extra');
    expect(result.notes?.join(' ')).toContain('shortened to');
    // The fallback runs, but it must stay on the requested page. `page=1` is
    // the API default and may legitimately be sent explicitly.
    for (const call of harness.calls) {
      expect(call.get('page') ?? '1').toBe('1');
    }
  });

  test('the fallback never asks for a page other than the requested one', async () => {
    harness = installFetchHarness({
      routes: { '*': { body: emptyApiResponse({ items: [] }) } },
    });

    await (server as never as SearchCapableServer).searchStackOverflow('a b c d e f g h i j', undefined, {
      page: 3,
      limit: 5,
    });

    expect(harness.calls).toHaveLength(1);
    expect(harness.calls[0]!.get('page')).toBe('3');
  });

  test('the effective query and tags are reported back', async () => {
    harness = installFetchHarness({
      routes: { '*': { body: emptyApiResponse({ items: [QUESTION] }) } },
    });

    const result = await (server as never as SearchCapableServer).searchStackOverflow(
      'TypeError: x is not a function',
      ['javascript'],
      { page: 1, limit: 5 }
    );

    expect(result.effectiveQuery).toBe('TypeError: x is not a function');
    expect(result.effectiveTags).toEqual(['javascript']);
    expect(result.usedFallback).toBe(false);
  });

  test('a relaxed tag filter is reported as the effective state', async () => {
    let seen = 0;
    harness = installFetchHarness({
      routes: {
        '*': () => {
          seen += 1;
          // Nothing matches while the tag filter is applied; the relaxed
          // attempt (the last one) matches.
          const tagged = true;
          return {
            body: emptyApiResponse({
              items: seen === 1 ? [] : [QUESTION],
              has_more: false,
              _tagged: tagged,
            }),
          };
        },
      },
    });

    const result = await (server as never as SearchCapableServer).searchStackOverflow(
      'react hooks error',
      ['nonexistenttag'],
      { page: 1, limit: 5 }
    );

    expect(result.results).toHaveLength(1);
    expect(result.usedFallback).toBe(true);
    expect(result.effectiveTags).toBeUndefined();
    expect(result.effectiveQuery).toBe('react hooks error');
    expect(result.usedFallback).toBe(true);
    expect(result.notes?.join(' ')).toContain('tag filter was relaxed');
  });
});
