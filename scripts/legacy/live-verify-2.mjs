#!/usr/bin/env node
/**
 * Verifies JSON validity, MCP resources, and MCP prompts on the live service.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const transport = new StreamableHTTPClientTransport(new URL('http://localhost:11405/mcp'));
const client = new Client({ name: 'live-verify-2', version: '1.0.0' });
await client.connect(transport);

// 1. JSON validity across several queries (including ones that trigger truncation)
console.log('=== JSON VALIDITY ===');
const queries = [
  { query: 'pandas dataframe', limit: 2 },
  { query: 'reverse a list in python', limit: 3 },
  { query: 'javascript closure', limit: 5 },
];
for (const q of queries) {
  const res = await client.callTool({
    name: 'search_by_query',
    arguments: { ...q, responseFormat: 'json' },
  });
  const text = res.content[0].text;
  try {
    const parsed = JSON.parse(text);
    console.log(
      `OK  "${q.query}" limit=${q.limit} -> ${text.length} chars, ` +
      `${parsed.results.length} results, truncated=${parsed.truncated ?? false}`
    );
  } catch (e) {
    console.log(`FAIL "${q.query}" -> invalid JSON: ${e.message}`);
  }
}

// 2. Resources
console.log('\n=== RESOURCES ===');
const resources = await client.listResources();
for (const r of resources.resources) console.log(`- ${r.uri} (${r.name})`);
for (const r of resources.resources) {
  const read = await client.readResource({ uri: r.uri });
  console.log(`\n[${r.uri}]`);
  console.log(read.contents[0].text);
}

// 3. Prompts
console.log('\n=== PROMPTS ===');
const prompts = await client.listPrompts();
for (const p of prompts.prompts) console.log(`- ${p.name}: ${p.description}`);
const searchPrompt = await client.getPrompt({
  name: 'stackoverflow_search',
  arguments: { query: 'memory leak', language: 'rust' },
});
console.log('\n[stackoverflow_search rendered]');
console.log(searchPrompt.messages[0].content.text);

await client.close();
process.exit(0);
