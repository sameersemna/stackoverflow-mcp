#!/usr/bin/env node
/**
 * Exercises every tool option on the live deployed service.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const target = process.argv[2] ?? 'http://latitude:11405/mcp';
const transport = new StreamableHTTPClientTransport(new URL(target));
const client = new Client({ name: 'options-verify', version: '1.0.0' });
await client.connect(transport);
console.log('Target:', target, '\n');

const call = async (name, args) => {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? '';
  return { isError: res.isError ?? false, text };
};

const check = (label, ok, detail) =>
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);

// --- search_by_error with technologies + minScore + includeComments ---
{
  const { isError, text } = await call('search_by_error', {
    errorMessage: "Cannot read property 'map' of undefined",
    language: 'javascript',
    technologies: ['react'],
    minScore: 5,
    includeComments: true,
    limit: 2,
    responseFormat: 'markdown',
  });
  check('search_by_error (technologies+minScore+includeComments)', !isError,
    `${text.length} chars, has comments section: ${text.includes('Comments')}`);
}

// --- search_by_tags with minScore + page ---
{
  const { isError, text } = await call('search_by_tags', {
    tags: ['typescript', 'generics'],
    minScore: 50,
    limit: 2,
    page: 1,
    responseFormat: 'json',
  });
  const parsed = JSON.parse(text);
  const scores = parsed.results.map((r) => r.question.score);
  check('search_by_tags (minScore pushed to API)', !isError && scores.every((s) => s >= 50),
    `scores: ${JSON.stringify(scores)}`);
}

// --- analyze_stack_trace with a Java stack trace ---
{
  const { isError, text } = await call('analyze_stack_trace', {
    stackTrace: `Exception in thread "main" java.lang.NullPointerException: Cannot invoke "String.length()" because "s" is null
	at com.example.Main.main(Main.java:12)`,
    language: 'java',
    limit: 2,
    responseFormat: 'markdown',
  });
  check('analyze_stack_trace (Java, skips "Exception in thread")', !isError && text.length > 200,
    `${text.length} chars, first title: ${text.split('\n')[0]}`);
}

// --- search_by_question_id with includeComments ---
{
  const { isError, text } = await call('search_by_question_id', {
    questionId: 7158439,
    includeAnswers: true,
    includeComments: true,
    responseFormat: 'markdown',
  });
  check('search_by_question_id (includeComments)', !isError && text.includes('Comments'),
    `${text.length} chars`);
}

// --- search_by_question_id with includeAnswers: false ---
{
  const { isError, text } = await call('search_by_question_id', {
    questionId: 7158439,
    includeAnswers: false,
    responseFormat: 'markdown',
  });
  check('search_by_question_id (includeAnswers=false)', !isError && !text.includes('## Answers'),
    `${text.length} chars, no answers section`);
}

// --- validation error handling ---
{
  const { isError, text } = await call('search_by_tags', { tags: [] });
  check('validation error for empty tags', isError, text.slice(0, 80));
}

// --- HTML cleanliness in markdown ---
{
  const { text } = await call('search_by_question_id', {
    questionId: 7158439,
    responseFormat: 'markdown',
  });
  check('markdown has no raw HTML tags/entities',
    !/<p>|<\/p>|&#39;|&amp;|&quot;/.test(text));
}

await client.close();
process.exit(0);
