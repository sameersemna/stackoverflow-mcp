#!/usr/bin/env node
/**
 * Connects to the LIVE deployed service (mcp-proxy on port 11405) and exercises
 * every tool, printing the exact payloads clients receive.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const url = new URL('http://localhost:11405/mcp');
const transport = new StreamableHTTPClientTransport(url);
const client = new Client({ name: 'live-verify', version: '1.0.0' });

await client.connect(transport);
console.log('Connected to live service at', url.href);

const tools = await client.listTools();
console.log('\n=== TOOLS EXPOSED ===');
for (const t of tools.tools) {
  console.log(`- ${t.name} | outputSchema: ${t.outputSchema ? 'YES' : 'no'}`);
}

const call = async (name, args, show = 900) => {
  console.log(`\n${'='.repeat(70)}\n=== ${name} ===`);
  console.log('args:', JSON.stringify(args));
  const res = await client.callTool({ name, arguments: args });
  console.log('isError:', res.isError ?? false);
  console.log('structuredContent:', res.structuredContent === undefined ? 'undefined (good)' : 'PRESENT');
  const text = res.content?.[0]?.text ?? '';
  console.log(`text length: ${text.length}`);
  console.log('--- output ---');
  console.log(text.slice(0, show));
  if (text.length > show) console.log(`... [${text.length - show} more chars]`);
  return text;
};

// Tool 4: search_by_query
await call('search_by_query', {
  query: 'how to reverse a list in python',
  limit: 1,
  responseFormat: 'markdown',
});

// Tool 5: search_by_question_id
await call('search_by_question_id', {
  questionId: 7158439,
  includeAnswers: true,
  responseFormat: 'markdown',
});

// Pagination check
const p1 = JSON.parse(await call('search_by_query', { query: 'pandas dataframe', limit: 2, page: 1, responseFormat: 'json' }, 0));
const p2 = JSON.parse(await call('search_by_query', { query: 'pandas dataframe', limit: 2, page: 2, responseFormat: 'json' }, 0));
console.log('\n=== PAGINATION CHECK ===');
console.log('page1:', p1.results.map((r) => r.question.question_id), 'hasMore:', p1.pagination.hasMore);
console.log('page2:', p2.results.map((r) => r.question.question_id), 'hasMore:', p2.pagination.hasMore);
console.log('pages differ:', JSON.stringify(p1.results.map(r=>r.question.question_id)) !== JSON.stringify(p2.results.map(r=>r.question.question_id)));

// acceptedOnly check
const acc = JSON.parse(await call('search_by_query', { query: 'reverse a list in python', acceptedOnly: true, limit: 3, responseFormat: 'json' }, 0));
console.log('\n=== acceptedOnly CHECK ===');
console.log('all have accepted_answer_id:', acc.results.every((r) => r.question.accepted_answer_id !== undefined));

// Error handling check
await call('search_by_question_id', { questionId: 999999999 }, 200);

await client.close();
process.exit(0);
