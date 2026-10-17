/**
 * MCP resource registration.
 *
 * Responsibility: expose the two read-only resources (`stackoverflow://status`
 * and `stackoverflow://quota`) and describe their JSON payloads.
 *
 * The payloads are built from an injected state snapshot rather than from private
 * server fields, so this module has no dependency on the server class. Phase 3
 * promotes the quota tracker to a process-wide singleton and Phase 4 adds real
 * totals here; both become easier with this seam in place.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { USE_HTTP_TRANSPORT } from './config.js';
import { VERSION } from './version.js';

/** Rate-limit and quota numbers the quota resource reports. */
export interface ResourceState {
  /** True when a Stack Exchange API key is configured. */
  apiKeyConfigured: boolean;
  /** Maximum requests per second the client rate limiter allows. */
  maxRequestsPerSecond: number;
  /** Minimum delay enforced between consecutive requests, in milliseconds. */
  minDelayBetweenRequestsMs: number;
  /** Quota level below which a low-quota warning is logged. */
  quotaWarningThreshold: number;
  /** TTL of cached search responses, in milliseconds. */
  cacheTtlMs: number;
  /** Per-method backoff deadlines requested by the API. */
  activeBackoffs: ReadonlyMap<string, number>;
  /** Latest quota figures reported by the API (B15). */
  quota: {
    remaining: number | undefined;
    max: number | undefined;
    observedAt: number;
    /** Next 00:00 UTC reset, ISO-8601. */
    resetAt: string;
  };
  /** Cache size and counters, so cache behaviour is observable in production. */
  cache?: { size: number; hits: number; misses: number; evictions: number };
}

/**
 * Registers both resources on the given MCP server.
 *
 * @param server - The MCP server to register on.
 * @param state - Supplier called on each read, so the payload is never stale.
 */
export function registerResources(server: McpServer, state: () => ResourceState): void {
  server.registerResource(
    'server-status',
    'stackoverflow://status',
    {
      title: 'Server Status',
      description: 'Current server status including version, transport mode, and API key status',
      mimeType: 'application/json',
    },
    async () => {
      const current = state();
      return {
        contents: [
          {
            uri: 'stackoverflow://status',
            mimeType: 'application/json',
            text: JSON.stringify(
              {
                service: 'mcp-stackoverflow',
                version: VERSION,
                transport: USE_HTTP_TRANSPORT ? 'http' : 'stdio',
                apiKeyConfigured: current.apiKeyConfigured,
                timestamp: new Date().toISOString(),
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.registerResource(
    'api-quota',
    'stackoverflow://quota',
    {
      title: 'API Quota',
      description: 'Current Stack Exchange API quota status and rate limit information',
      mimeType: 'application/json',
    },
    async () => {
      const current = state();
      return {
        contents: [
          {
            uri: 'stackoverflow://quota',
            mimeType: 'application/json',
            text: JSON.stringify(
              {
                maxRequestsPerSecond: current.maxRequestsPerSecond,
                minDelayBetweenRequestsMs: current.minDelayBetweenRequestsMs,
                quotaWarningThreshold: current.quotaWarningThreshold,
                cacheTtlMs: current.cacheTtlMs,
                activeBackoffs: Array.from(current.activeBackoffs.entries()).map(
                  ([method, until]) => ({
                    method,
                    backoffUntil: new Date(until).toISOString(),
                  })
                ),
                // Real figures from the last API response, not static constants:
                // `quota_remaining` was previously logged and discarded.
                quota: {
                  // `null` rather than an omitted key: the client should be able
                  // to distinguish "no response observed yet" from a missing field.
                  remaining: current.quota.remaining ?? null,
                  max: current.quota.max ?? null,
                  observedAt:
                    current.quota.observedAt === 0
                      ? null
                      : new Date(current.quota.observedAt).toISOString(),
                  resetAt: current.quota.resetAt,
                },
                ...(current.cache ? { cache: current.cache } : {}),
                timestamp: new Date().toISOString(),
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
