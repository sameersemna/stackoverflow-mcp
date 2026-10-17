/**
 * Version and response-metadata tests (B14, B12).
 *
 * B14: the version was hard-coded as '0.2.0' in three places (MCP server info,
 * the `stackoverflow://status` resource, and `/health`), so a release bump could
 * silently desynchronise them.
 *
 * B12: `pagination.totalCount` was set to `results.length`, which is not a total
 * at all; `truncateText` reported `CHARACTER_LIMIT` instead of the `limit`
 * argument it was given; and `search_by_query` filtered `acceptedOnly` locally
 * *after* pagination, so `pageSize` and `hasMore` no longer described the
 * results returned.
 */
import { describe, expect, test, afterEach } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StackOverflowServer, truncateText } from '../server.js';
import { installFetchHarness, emptyApiResponse, type FetchHarness } from './helpers/fetchHarness.js';
import type { SearchResult } from '../types/index.js';

const packageJson = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')
) as { version: string };

function makeResult(): SearchResult {
  return {
    question: {
      question_id: 1,
      title: 'Title',
      body: 'Body',
      score: 5,
      answer_count: 0,
      is_answered: false,
      creation_date: 1,
      tags: ['javascript'],
      link: 'https://stackoverflow.com/q/1',
    },
    answers: [],
  };
}

describe('single-source version (B14)', () => {
  let harness: FetchHarness;

  afterEach(() => harness?.restore());

  test('the MCP server info reports the package version', async () => {
    const server = new StackOverflowServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'version-test', version: '1.0.0' });

    await Promise.all([
      client.connect(clientTransport),
      server.getServer().connect(serverTransport),
    ]);

    const info = client.getServerVersion();
    expect(info?.version).toBe(packageJson.version);
    expect(info?.name).toBe('stackoverflow-mcp');

    await client.close();
  });

  test('the status resource reports the package version', async () => {
    const server = new StackOverflowServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'version-test', version: '1.0.0' });

    await Promise.all([
      client.connect(clientTransport),
      server.getServer().connect(serverTransport),
    ]);

    const resource = await client.readResource({ uri: 'stackoverflow://status' });
    const text = resource.contents[0]?.text ?? '';
    const payload = JSON.parse(text) as { version: string };

    expect(payload.version).toBe(packageJson.version);

    await client.close();
  });

  test('no source file still hard-codes the old version string', () => {
    const serverSource = readFileSync(
      fileURLToPath(new URL('../server.ts', import.meta.url)),
      'utf8'
    );
    const match = /version:\s*'([^']+)'/.exec(serverSource);
    if (match) {
      throw new Error(
        `server.ts hard-codes version '${match[1]}'; it must come from version.ts (package.json)`
      );
    }
    expect(serverSource).not.toContain("'0.2.0'");
  });
});

describe('truncation reports the limit it was given (B12)', () => {
  test('truncateText names the caller-supplied limit, not CHARACTER_LIMIT', () => {
    const long = 'x'.repeat(500);

    const truncated = truncateText(long, 100);

    expect(truncated.length).toBeLessThan(long.length);
    expect(truncated).toContain('100 characters');
    expect(truncated).not.toContain('25,000');
  });

  test('truncateText leaves short text untouched', () => {
    expect(truncateText('short', 100)).toBe('short');
  });
});

describe('pagination metadata describes the returned results (B12)', () => {
  let harness: FetchHarness;

  afterEach(() => harness?.restore());

  function question(id: number, accepted: boolean) {
    return {
      question_id: id,
      title: `Q${id}`,
      body: 'body',
      score: 1,
      answer_count: 0,
      is_answered: accepted,
      ...(accepted ? { accepted_answer_id: id * 10 } : {}),
      creation_date: 1,
      tags: ['javascript'],
      link: `https://stackoverflow.com/q/${id}`,
    };
  }

  function install(questions: unknown[]): void {
    harness = installFetchHarness({
      routes: {
        '/search/advanced': { body: emptyApiResponse({ items: questions }) },
        '*': { body: emptyApiResponse() },
      },
    });
  }

  test('totalCount is not presented as a total when it is only the page size', async () => {
    install([question(1, false), question(2, false), question(3, false)]);
    const server = new StackOverflowServer();

    const result = await (server as never as {
      handleSearchByQuery: (input: unknown) => Promise<{ content: { text: string }[] }>;
    }).handleSearchByQuery({ query: 'q', responseFormat: 'json', limit: 3 });

    const payload = JSON.parse(result.content[0]!.text) as {
      pagination: { page: number; pageSize: number; hasMore: boolean; totalCount?: number };
    };

    expect(payload.pagination.pageSize).toBe(3);
    expect(payload.pagination.page).toBe(1);
    // The API result set is not enumerable here, so no total may be claimed.
    expect(payload.pagination.totalCount).toBeUndefined();
  });

  test('acceptedOnly recomputes pageSize after local filtering', async () => {
    // The API's `accepted=True` filter is authoritative; the local filter is a
    // safety net. When it removes entries, metadata must describe the survivors.
    install([question(1, true), question(2, false), question(3, true)]);

    // Simulate the API not honouring `accepted`: it returns a question with no
    // accepted_answer_id, which the local filter then drops.
    const server = new StackOverflowServer();
    const result = await (server as never as {
      handleSearchByQuery: (input: unknown) => Promise<{ content: { text: string }[] }>;
    }).handleSearchByQuery({ query: 'q', responseFormat: 'json', acceptedOnly: true, limit: 3 });

    const payload = JSON.parse(result.content[0]!.text) as {
      pagination: { pageSize: number; hasMore: boolean };
      results: { question: { question_id: number } }[];
    };

    expect(payload.results.map((entry) => entry.question.question_id)).toEqual([1, 3]);
    expect(payload.pagination.pageSize).toBe(payload.results.length);
  });
});
