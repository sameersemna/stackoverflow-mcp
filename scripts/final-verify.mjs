#!/usr/bin/env node
/**
 * Comprehensive final verification of all 5 tools, all options, resources,
 * prompts, pagination, error handling, and output validity.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const target = process.argv[2] ?? 'http://localhost:3097/mcp';
const client = new Client({ name: 'final-verify', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(target)));

let pass = 0;
let fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  ok ? pass++ : fail++;
};

const call = async (name, args) => {
  const res = await client.callTool({ name, arguments: args });
  return { isError: res.isError ?? false, text: res.content?.[0]?.text ?? '', structured: res.structuredContent };
};

console.log(`Target: ${target}\n${'='.repeat(72)}`);

// ---- Tool inventory ----
const tools = await client.listTools();
check('5 tools exposed', tools.tools.length === 5, tools.tools.map((t) => t.name).join(', '));
check('no tool declares outputSchema', tools.tools.every((t) => !t.outputSchema));

// ---- 1. search_by_error ----
{
  const { isError, text, structured } = await call('search_by_error', {
    errorMessage: "TypeError: Cannot read property 'length' of undefined",
    language: 'javascript', limit: 2, responseFormat: 'markdown',
  });
  check('search_by_error returns rich content', !isError && text.length > 1000, `${text.length} chars`);
  check('search_by_error has no structuredContent', structured === undefined);
  check('search_by_error includes answers', text.includes('## Answers'));
}

// ---- 2. search_by_tags ----
{
  const { isError, text } = await call('search_by_tags', {
    tags: ['python', 'pandas'], minScore: 1000, limit: 2, responseFormat: 'json',
  });
  const parsed = JSON.parse(text);
  check('search_by_tags minScore honored', !isError && parsed.results.every((r) => r.question.score >= 1000),
    `scores ${JSON.stringify(parsed.results.map((r) => r.question.score))}`);
  check('search_by_tags JSON valid', Array.isArray(parsed.results));
}

// ---- 3. analyze_stack_trace (Python) ----
{
  const { isError, text } = await call('analyze_stack_trace', {
    stackTrace: `Traceback (most recent call last):
  File "/app/main.py", line 42, in <module>
    df = pd.read_csv("data.csv")
FileNotFoundError: [Errno 2] No such file or directory: 'data.csv'`,
    language: 'python', limit: 2, responseFormat: 'markdown',
  });
  check('analyze_stack_trace (Python) relevant', !isError && /FileNotFoundError|No such file/i.test(text),
    text.split('\n')[0]);
}

// ---- 3b. analyze_stack_trace (Java) ----
{
  const { isError, text } = await call('analyze_stack_trace', {
    stackTrace: `Exception in thread "main" java.lang.NullPointerException: Cannot invoke "String.length()" because "s" is null
	at com.example.Main.main(Main.java:12)`,
    language: 'java', limit: 2, responseFormat: 'markdown',
  });
  check('analyze_stack_trace (Java) relevant', !isError && /NullPointerException|String\.length/i.test(text),
    text.split('\n')[0]);
}

// ---- 4. search_by_query ----
{
  const { isError, text } = await call('search_by_query', {
    query: 'how to reverse a list in python', limit: 1, responseFormat: 'markdown',
  });
  check('search_by_query relevant', !isError && /reverse/i.test(text), text.split('\n')[0]);
}

// ---- 5. search_by_question_id ----
{
  const { isError, text } = await call('search_by_question_id', {
    questionId: 7158439, includeAnswers: true, responseFormat: 'markdown',
  });
  check('search_by_question_id returns question + answers',
    !isError && text.includes('## Question') && text.includes('## Answers'), `${text.length} chars`);
}

// ---- Pagination ----
{
  const p1 = JSON.parse((await call('search_by_query', { query: 'pandas dataframe', limit: 2, page: 1, responseFormat: 'json' })).text);
  const p2 = JSON.parse((await call('search_by_query', { query: 'pandas dataframe', limit: 2, page: 2, responseFormat: 'json' })).text);
  const ids1 = p1.results.map((r) => r.question.question_id);
  const ids2 = p2.results.map((r) => r.question.question_id);
  check('pagination returns different pages', JSON.stringify(ids1) !== JSON.stringify(ids2),
    `p1=${JSON.stringify(ids1)} p2=${JSON.stringify(ids2)}`);
  check('pagination reports hasMore', p1.pagination.hasMore === true);
}

// ---- acceptedOnly ----
{
  const parsed = JSON.parse((await call('search_by_query', {
    query: 'reverse a list in python', acceptedOnly: true, limit: 3, responseFormat: 'json',
  })).text);
  check('acceptedOnly filters correctly',
    parsed.results.length > 0 && parsed.results.every((r) => r.question.accepted_answer_id !== undefined));
}

// ---- Tag relaxation note ----
{
  const parsed = JSON.parse((await call('search_by_error', {
    errorMessage: "Cannot read property 'map' of undefined",
    technologies: ['react'], limit: 2, responseFormat: 'json',
  })).text);
  check('invalid tag relaxed with a note',
    parsed.results.length > 0 && Array.isArray(parsed.notes) && /tag filter was relaxed/i.test(parsed.notes[0]),
    `${parsed.results.length} results`);
}

// ---- Error handling ----
{
  const { isError, text } = await call('search_by_question_id', { questionId: 999999999 });
  check('missing question returns clean error', isError && text.startsWith('Error:'), text.slice(0, 60));
}
{
  const { isError } = await call('search_by_tags', { tags: [] });
  check('validation error for empty tags', isError);
}

// ---- JSON validity under truncation ----
{
  const { text } = await call('search_by_query', { query: 'javascript closure', limit: 5, responseFormat: 'json' });
  let ok = false;
  let detail = '';
  try {
    const parsed = JSON.parse(text);
    ok = Array.isArray(parsed.results);
    detail = `${text.length} chars, truncated=${parsed.truncated ?? false}`;
  } catch (e) {
    detail = e.message;
  }
  check('large JSON output stays valid', ok, detail);
}

// ---- Resources & prompts ----
{
  const resources = await client.listResources();
  check('2 resources exposed', resources.resources.length === 2, resources.resources.map((r) => r.uri).join(', '));
  const status = await client.readResource({ uri: 'stackoverflow://status' });
  check('status resource readable', status.contents[0].text.includes('mcp-stackoverflow'));
  const prompts = await client.listPrompts();
  check('2 prompts exposed', prompts.prompts.length === 2, prompts.prompts.map((p) => p.name).join(', '));
}

console.log(`${'='.repeat(72)}\nTOTAL: ${pass} passed, ${fail} failed`);
await client.close();
process.exit(fail > 0 ? 1 : 0);
