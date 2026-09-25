#!/usr/bin/env node
/**
 * Verification probe for the specific bugs that were fixed.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: 'node',
  args: ['build/index.js'],
  env: { ...process.env },
});
const client = new Client({ name: 'verify', version: '1.0.0' });
await client.connect(transport);

const call = async (name, args, show = 700) => {
  console.log(`\n=== ${name} ${JSON.stringify(args).slice(0, 120)} ===`);
  const res = await client.callTool({ name, arguments: args });
  console.log('isError:', res.isError ?? false);
  const text = res.content?.[0]?.text ?? '';
  console.log(text.slice(0, show));
  return text;
};

// 1. Python traceback: first line is "Traceback (most recent call last):"
const py = await call('analyze_stack_trace', {
  stackTrace: `Traceback (most recent call last):
  File "/app/main.py", line 42, in <module>
    df = pd.read_csv("data.csv")
  File "/usr/lib/python3/site-packages/pandas/io/parsers.py", line 610, in read_csv
    return _read(filepath_or_buffer, kwds)
FileNotFoundError: [Errno 2] No such file or directory: 'data.csv'`,
  language: 'python',
  limit: 2,
  responseFormat: 'markdown',
}, 400);

// 2. acceptedOnly must only return questions with accepted answers
const acc = await call('search_by_query', {
  query: 'reverse a list in python',
  acceptedOnly: true,
  limit: 3,
  responseFormat: 'json',
}, 200);
const accJson = JSON.parse(acc);
console.log('acceptedOnly -> all have accepted_answer_id:',
  accJson.results.every((r) => r.question.accepted_answer_id !== undefined));

// 3. Pagination: page 2 should differ from page 1
const p1 = JSON.parse(await call('search_by_query', { query: 'pandas dataframe', limit: 2, page: 1, responseFormat: 'json' }, 60));
const p2 = JSON.parse(await call('search_by_query', { query: 'pandas dataframe', limit: 2, page: 2, responseFormat: 'json' }, 60));
console.log('page1 ids:', p1.results.map((r) => r.question.question_id), 'hasMore:', p1.pagination.hasMore, 'truncated:', p1.truncated ?? false);
console.log('page2 ids:', p2.results.map((r) => r.question.question_id), 'hasMore:', p2.pagination.hasMore, 'truncated:', p2.truncated ?? false);
console.log('pages differ:', JSON.stringify(p1.results.map(r=>r.question.question_id)) !== JSON.stringify(p2.results.map(r=>r.question.question_id)));

// 4. minScore pushed down to API
const ms = JSON.parse(await call('search_by_tags', { tags: ['python', 'pandas'], minScore: 1000, limit: 3, responseFormat: 'json' }, 60));
console.log('minScore=1000 scores:', ms.results.map((r) => r.question.score));

// 5. Invalid question id -> clean error, not a crash
const bad = await call('search_by_question_id', { questionId: 999999999 }, 300);
console.log('bad id isError:', bad.startsWith('Error:'));

// 6. HTML entities decoded in markdown
const html = await call('search_by_question_id', { questionId: 7158439, responseFormat: 'markdown' }, 1200);
console.log('contains raw entity &#39;:', html.includes('&#39;'));
console.log('contains raw <p> tag:', /<p>/.test(html));

await client.close();
process.exit(0);
