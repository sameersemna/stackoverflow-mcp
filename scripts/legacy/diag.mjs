#!/usr/bin/env node
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const transport = new StreamableHTTPClientTransport(new URL('http://latitude:11405/mcp'));
const client = new Client({ name: 'diag', version: '1.0.0' });
await client.connect(transport);

const call = async (name, args) => {
  const res = await client.callTool({ name, arguments: args });
  return { isError: res.isError ?? false, text: res.content?.[0]?.text ?? '' };
};

console.log('=== 1. search_by_error react+minScore=5 ===');
const r1 = await call('search_by_error', {
  errorMessage: "Cannot read property 'map' of undefined",
  language: 'javascript', technologies: ['react'], minScore: 5, includeComments: true,
  limit: 2, responseFormat: 'markdown',
});
console.log('isError:', r1.isError);
console.log(r1.text);

console.log('\n=== 2. analyze_stack_trace Java ===');
const r2 = await call('analyze_stack_trace', {
  stackTrace: `Exception in thread "main" java.lang.NullPointerException: Cannot invoke "String.length()" because "s" is null
	at com.example.Main.main(Main.java:12)`,
  language: 'java', limit: 2, responseFormat: 'markdown',
});
console.log('isError:', r2.isError, 'len:', r2.text.length);
console.log(JSON.stringify(r2.text));

console.log('\n=== 3. search_by_question_id includeAnswers=false ===');
const r3 = await call('search_by_question_id', {
  questionId: 7158439, includeAnswers: false, responseFormat: 'markdown',
});
console.log(r3.text);

await client.close();
process.exit(0);
