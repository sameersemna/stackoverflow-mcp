#!/bin/bash
#
# Starts the server through `mcp-proxy`, which terminates streamable-HTTP and speaks
# stdio to the server. This is the wrapper the systemd unit uses today.
#
# Usage:
#   ./run.sh                 # port 11405, API key loaded from .env when present
#   PORT=11412 ./run.sh      # a different proxy port
#
# The Stack Exchange API key is **optional**: without it the API is still usable, at
# roughly 300 requests per day per IP instead of 10,000 with a key. The script warns
# rather than exiting, because a missing key degrades the daily allowance instead of
# preventing the server from working.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"
PORT="${PORT:-11405}"

# Load the environment file when it exists. It is optional, and it is gitignored
# because it holds the API key (and, in HTTP mode, the auth token).
if [[ -f "$ENV_FILE" ]]; then
    set -a
    # shellcheck disable=SC1090
    if ! source "$ENV_FILE"; then
        set +a
        echo "Failed to load environment file: $ENV_FILE" >&2
        exit 1
    fi
    set +a
else
    echo "No $ENV_FILE found; continuing with the current environment." >&2
fi

if [[ -z "${STACKOVERFLOW_API_KEY:-}" ]]; then
    echo "WARNING: STACKOVERFLOW_API_KEY is not set." >&2
    echo "         The API allows roughly 300 requests/day per IP without a key," >&2
    echo "         and about 10,000/day with one. Set it in $ENV_FILE to raise the limit." >&2
fi

# `build/index.js` is the stdio entry point the published `bin` also points at; it must
# exist before the proxy is started, so a stale checkout fails loudly here instead of
# producing a proxy that cannot reach its server.
if [[ ! -f "$SCRIPT_DIR/build/index.js" ]]; then
    echo "Missing build/index.js — run 'npm ci && npm run build' first." >&2
    exit 1
fi

echo "Starting Stack Overflow MCP proxy on port $PORT..." >&2
exec npx --yes mcp-proxy --port "$PORT" --transport streamable-http -- node "$SCRIPT_DIR/build/index.js"
