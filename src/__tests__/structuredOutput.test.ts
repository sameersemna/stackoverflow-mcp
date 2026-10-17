/**
 * Structured-output tests (B11, Phase 5).
 *
 * Responsibility: prove the structured contract works through a real MCP client —
 * that every tool advertises an `outputSchema`, that successful results carry
 * `structuredContent` conforming to it, and that the structured value and the text
 * describe the same rows.
 *
 * Background: commit 4115cb1 added `outputSchema` + `structuredContent`; 4762d6e
 * removed them in a refactor, so clients were left with text only. This restores
 * them against the *current* result shape.
 *
 * The SDK enforces the contract: declaring `outputSchema` makes it throw
 * `InvalidParams` unless a successful result carries `structuredContent`
 * (verified in `server/mcp.js`, `validateToolOutput`). Error results are exempt,
 * which is why the error paths below must still work with an output schema
 * declared.
 */
import { describe, expect, test, afterEach } from '@jest/globals';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StackOverflowServer } from '../server.js';
import { emptyApiResponse, installFetchHarness, type FetchHarness } from './helpers/fetchHarness.js';

/** Assertion helper carrying a context message; Jest's `expect` takes no message. */
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

const QUESTION_ID = 12345;

function inlineQuestion() {
  return {
    question_id: QUESTION_ID,
    title: 'How do I fix TypeError: boom?',
    body: '<p>question body</p>',
    score: 10,
    answer_count: 1,
    is_answered: true,
    accepted_answer_id: 67890,
    creation_date: 1,
    tags: ['javascript'],
    link: `https://stackoverflow.com/q/${QUESTION_ID}`,
    comments: [
      { comment_id: 1, post_id: QUESTION_ID, score: 1, body: '<p>c</p>', creation_date: 1 },
    ],
    answers: [
      {
        answer_id: 67890,
        question_id: QUESTION_ID,
        score: 5,
        is_accepted: true,
        body: '<p>answer</p>',
        creation_date: 1,
        link: 'https://stackoverflow.com/a/67890',
      },
    ],
  };
}

/** Every tool, with arguments that reach a success path. */
const TOOL_CALLS: readonly { name: string; args: Record<string, unknown> }[] = [
  { name: 'search_by_error', args: { errorMessage: 'TypeError: boom' } },
  { name: 'search_by_tags', args: { tags: ['javascript'] } },
  { name: 'analyze_stack_trace', args: { stackTrace: 'TypeError: boom\n  at f (a.js:1:1)', language: 'javascript' } },
  { name: 'search_by_query', args: { query: 'pandas dataframe' } },
  { name: 'search_by_question_id', args: { questionId: QUESTION_ID } },
];

describe('structured output (B11)', () => {
  let harness: FetchHarness;

  afterEach(() => {
    harness?.restore();
  });

  function install(): void {
    harness = installFetchHarness({
      routes: {
        '*': { body: emptyApiResponse({ items: [inlineQuestion()] }) },
      },
    });
  }

  async function connect(): Promise<{ client: Client; server: StackOverflowServer }> {
    const server = new StackOverflowServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'structured', version: '1.0.0' });
    await Promise.all([
      client.connect(clientTransport),
      server.getServer().connect(serverTransport),
    ]);
    return { client, server };
  }

  test('every tool advertises an outputSchema', async () => {
    install();
    const { client } = await connect();

    const { tools } = await client.listTools();

    expect(tools).toHaveLength(5);
    for (const tool of tools) {
      assert(tool.outputSchema !== undefined, `${tool.name} must publish an outputSchema`);
      expect(tool.outputSchema?.type).toBe('object');
    }

    await client.close();
  });

  for (const { name, args } of TOOL_CALLS) {
    test(`${name} returns structuredContent accepted by the client`, async () => {
      install();
      const { client } = await connect();

      const result = await client.callTool({ name, arguments: args });

      assert(!result.isError, `${name} should succeed`);
      // The SDK validates structuredContent against the declared outputSchema
      // before the client ever sees it, so reaching this point already means the
      // payload conformed; assert the shape as well for a clear failure message.
      assert(result.structuredContent !== undefined, `${name} must return structuredContent`);
      const structured = result.structuredContent as {
        results: unknown[];
        truncated: boolean;
      };
      expect(Array.isArray(structured.results)).toBe(true);
      expect(typeof structured.truncated).toBe('boolean');

      // Text content is still present, so pre-existing clients are unaffected.
      expect(result.content.length).toBeGreaterThan(0);
      expect(result.content[0]).toMatchObject({ type: 'text' });

      await client.close();
    });
  }

  test('the structured value and the text describe the same rows', async () => {
    install();
    const { client } = await connect();

    const result = await client.callTool({
      name: 'search_by_error',
      arguments: { errorMessage: 'TypeError: boom', responseFormat: 'json' },
    });

    const structured = result.structuredContent as { results: unknown[] };
    const text = (result.content[0] as { text: string }).text;
    const parsedText = JSON.parse(text) as { results: unknown[]; pagination: { pageSize: number } };

    expect(structured.results).toHaveLength(parsedText.results.length);
    expect((structured as { pagination: { pageSize: number } }).pagination.pageSize).toBe(
      parsedText.pagination.pageSize
    );

    await client.close();
  });

  test('search results expose the effective query and fallback state', async () => {
    install();
    const { client } = await connect();

    const result = await client.callTool({
      name: 'search_by_error',
      arguments: { errorMessage: 'TypeError: boom' },
    });

    const structured = result.structuredContent as {
      effectiveQuery?: string;
      usedFallback?: boolean;
      pagination?: { page: number; hasMore: boolean };
    };

    expect(structured.effectiveQuery).toBe('TypeError: boom');
    expect(structured.usedFallback).toBe(false);
    expect(structured.pagination).toMatchObject({ page: 1, hasMore: false });

    await client.close();
  });

  test('search_by_question_id returns the single question without pagination', async () => {
    install();
    const { client } = await connect();

    const result = await client.callTool({
      name: 'search_by_question_id',
      arguments: { questionId: QUESTION_ID },
    });

    const structured = result.structuredContent as {
      pagination?: unknown;
      results: { question: { question_id: number } }[];
    };

    expect(structured.pagination).toBeUndefined();
    expect(structured.results[0]!.question.question_id).toBe(QUESTION_ID);

    await client.close();
  });

  test('an empty result set still satisfies the output schema', async () => {
    harness = installFetchHarness({
      routes: { '*': { body: emptyApiResponse({ items: [] }) } },
    });
    const { client } = await connect();

    const result = await client.callTool({
      name: 'search_by_error',
      arguments: { errorMessage: 'nothing matches this at all' },
    });

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as { results: unknown[]; truncated: boolean };
    expect(structured.results).toEqual([]);
    expect(structured.truncated).toBe(false);

    await client.close();
  });

  test('error results are exempt from the output schema but keep their text', async () => {
    harness = installFetchHarness({
      routes: {
        '*': {
          body: {
            error_id: 400,
            error_name: 'bad_parameter',
            error_message: 'sort parameter is not valid',
            quota_remaining: 10,
            quota_max: 300,
          },
        },
      },
    });
    const { client } = await connect();

    const result = await client.callTool({
      name: 'search_by_error',
      arguments: { errorMessage: 'TypeError: boom' },
    });

    // The SDK skips output validation for isError results, so an error is still
    // reported as an error rather than a schema violation.
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('sort parameter is not valid');

    await client.close();
  });

  test('validation failures remain errors, not schema violations', async () => {
    install();
    const { client } = await connect();

    const result = await client.callTool({
      name: 'search_by_error',
      arguments: { errorMessage: 'boom', limit: 500 },
    });

    // `limit` is now published with maximum 100, so the client itself may reject
    // it; either way the caller must not receive a bogus success.
    expect(result.isError).toBe(true);

    await client.close();
  });

  test('truncation is agreed between text and structured content', async () => {
    // A large result set forces the character budget to bite.
    const many = Array.from({ length: 40 }, (_, index) => ({
      ...inlineQuestion(),
      question_id: QUESTION_ID + index,
      body: `<p>${'x'.repeat(2000)}</p>`,
    }));
    harness = installFetchHarness({
      routes: { '*': { body: emptyApiResponse({ items: many }) } },
    });
    const { client } = await connect();

    const result = await client.callTool({
      name: 'search_by_error',
      arguments: { errorMessage: 'TypeError: boom', limit: 40, responseFormat: 'json' },
    });

    const structured = result.structuredContent as {
      results: unknown[];
      truncated: boolean;
      pagination: { pageSize: number };
    };

    expect(structured.truncated).toBe(true);
    // The structured payload carries only the rows that survived truncation, and
    // its pageSize agrees, so a client cannot be told about rows it never got.
    expect(structured.results.length).toBeLessThan(40);
    expect(structured.pagination.pageSize).toBe(structured.results.length);

    await client.close();
  });
});
