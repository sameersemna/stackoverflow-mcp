#!/bin/bash

echo "Starting StackOverflow MCP Proxy..."

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"

if [[ ! -f "$ENV_FILE" ]]; then
    echo "Missing required environment file: $ENV_FILE" >&2
    exit 1
fi

unset STACKOVERFLOW_API_KEY
set -a
if ! source "$ENV_FILE"; then
    set +a
    echo "Failed to load environment file: $ENV_FILE" >&2
    exit 1
fi
set +a

if [[ -z "${STACKOVERFLOW_API_KEY:-}" ]]; then
    echo "STACKOVERFLOW_API_KEY is not set in $ENV_FILE" >&2
    exit 1
fi

# node build/index.js
# npx mcp-proxy --port 11412 --transport streamable-http -- uvx mcp-server-sqlite --db-path ./my.db
npx mcp-proxy --port 11405 --transport streamable-http -- node build/index.js
