#!/usr/bin/env node
/**
 * Raw MCP client probe: spawns the built server over stdio and dumps the
 * exact tool result payloads so we can see what clients actually receive.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: 'node',
  args: ['build/index.js'],
  env: { ...process.env },
});

const client = new Client({ name: 'probe', version: '1.0.0' });
await client.connect(transport);

const tools = await client.listTools();
console.log('=== TOOLS ===');
for (const t of tools.tools) {
  console.log(`- ${t.name} | outputSchema: ${t.outputSchema ? 'YES' : 'no'}`);
}

const call = async (name, args) => {
  console.log(`\n=== ${name} ===`);
  try {
    const res = await client.callTool({ name, arguments: args });
    console.log('isError:', res.isError ?? false);
    console.log('content blocks:', res.content?.length);
    for (const c of res.content ?? []) {
      console.log(`  [${c.type}] length=${c.text?.length ?? 0}`);
      console.log('  --- first 600 chars ---');
      console.log((c.text ?? '').slice(0, 600));
    }
    console.log('structuredContent:', JSON.stringify(res.structuredContent)?.slice(0, 400));
  } catch (e) {
    console.log('THREW:', e.message);
  }
};

await call('search_by_error', {
  errorMessage: "TypeError: Cannot read property 'length' of undefined",
  language: 'javascript',
  limit: 1,
  responseFormat: 'markdown',
});

await call('search_by_tags', { tags: ['python', 'pandas'], limit: 1 });

await call('search_by_question_id', { questionId: 7158439, includeAnswers: true });

await call('search_by_query', { query: 'how to reverse a list in python', limit: 1 });

await call('analyze_stack_trace', {
  stackTrace: "Error: ENOENT: no such file or directory, open 'config.json'\n    at Object.openSync (fs.js:476:3)",
  language: 'javascript',
  limit: 1,
});

await client.close();
process.exit(0);
