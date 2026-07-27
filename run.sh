#!/bin/bash

echo "Starting StackOverflow MCP Proxy..."

export STACKOVERFLOW_API_KEY='rl_5N48WSdRk5j8bFGi75hviJE17'

# node build/index.js
# npx mcp-proxy --port 11412 --transport streamable-http -- uvx mcp-server-sqlite --db-path ./my.db
npx mcp-proxy --port 11405 --transport streamable-http -- node --no-deprecation build/index.js


