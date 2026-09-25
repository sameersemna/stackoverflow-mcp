#!/usr/bin/env node
/**
 * Demonstrates the two tools not exposed in this agent session
 * (search_by_query, search_by_question_id) plus the new resilience features,
 * against the LIVE deployed service.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const target = process.argv[2] ?? 'http://latitude:11405/mcp';
const client = new Client({ name: 'session-demo', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(target)));
console.log('Target:', target);

const call = async (name, args, show = 1400) => {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? '';
  console.log(`\n${'='.repeat(72)}\n### ${name}`);
  console.log('args:', JSON.stringify(args));
  console.log('isError:', res.isError ?? false, '| structuredContent:',
    res.structuredContent === undefined ? 'undefined' : 'PRESENT');
  console.log('-'.repeat(72));
  console.log(text.slice(0, show));
  if (text.length > show) console.log(`\n... [${text.length - show} more chars]`);
  return text;
};

// ---- Tool 4: search_by_query ----
await call('search_by_query', {
  query: 'how to reverse a list in python',
  limit: 1,
  responseFormat: 'markdown',
});

// ---- Tool 5: search_by_question_id ----
await call('search_by_question_id', {
  questionId: 7158439,
  includeAnswers: true,
  responseFormat: 'markdown',
});

// ---- NEW: tag relaxation note (invalid tag 'react' vs 'reactjs') ----
await call('search_by_error', {
  errorMessage: "Cannot read property 'map' of undefined",
  technologies: ['react'],
  limit: 1,
  responseFormat: 'markdown',
}, 700);

// ---- NEW: over-specific query fallback ----
await call('analyze_stack_trace', {
  stackTrace: `Exception in thread "main" java.lang.NullPointerException: Cannot invoke "String.length()" because "s" is null
	at com.example.Main.main(Main.java:12)`,
  language: 'java',
  limit: 1,
  responseFormat: 'markdown',
}, 700);

// ---- NEW: minScore no longer crashes (min + relevance incompatibility) ----
await call('search_by_tags', {
  tags: ['python', 'pandas'],
  minScore: 1000,
  limit: 2,
  responseFormat: 'json',
}, 500);

// ---- NEW: includeAnswers=false omits the answers section ----
await call('search_by_question_id', {
  questionId: 7158439,
  includeAnswers: false,
  responseFormat: 'markdown',
}, 700);

await client.close();
process.exit(0);
