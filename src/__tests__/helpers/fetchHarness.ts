/**
 * Scripted `fetch` harness for the Stack Overflow MCP test-suite.
 *
 * Responsibility: install a deterministic, recording `fetch` implementation so
 * tests can (a) assert the exact number and shape of upstream API calls a tool
 * makes — quota is the scarcest resource — and (b) control responses without
 * touching the network. Unit tests must never reach the real API.
 *
 * Usage:
 * ```ts
 * const harness = installFetchHarness({ routes: { '/search/advanced': { body: { items: [...] } } } });
 * try { await callTool(); } finally { harness.restore(); }
 * harness.assertCallCount(2);
 * ```
 */

export const API_PREFIX = 'https://api.stackexchange.com/2.3';

/** A single upstream request observed by the harness. */
export interface RecordedCall {
  /** Full request URL including the query string. */
  readonly url: string;
  /** API path with the `/2.3` version prefix removed, e.g. `/search/advanced`. */
  readonly path: string;
  /** Parsed query string. */
  readonly params: URLSearchParams;
  /** Convenience accessor for a query parameter. */
  readonly get: (name: string) => string | null;
  /** Value of the `key` parameter when the server sent an API key. */
  readonly apiKey: string | undefined;
}

/** A scripted response: an HTTP status plus a JSON-serialisable body. */
export interface ScriptedResponse {
  status?: number;
  body?: unknown;
  /** Raw text used instead of `body`, e.g. to simulate unparseable JSON. */
  rawBody?: string;
}

/** Either a scripted response or a function computing one from the request. */
export type RouteValue = ScriptedResponse | ((call: RecordedCall) => ScriptedResponse);

export interface HarnessOptions {
  /**
   * Route table keyed by API path after `/2.3` (for example `/search/advanced`).
   * The key `'*'` acts as the catch-all.
   */
  routes?: Record<string, RouteValue>;
  /**
   * Response used when no route matches. Defaults to an empty Stack Exchange
   * payload with healthy quota, which most tests want.
   */
  fallback?: RouteValue;
}

export interface FetchHarness {
  /** Every request the server made, in order. */
  readonly calls: readonly RecordedCall[];
  /** The recorded calls restricted to one API path. */
  callsTo: (path: string) => RecordedCall[];
  /** Total number of upstream requests. */
  callCount: () => number;
  /** Asserts the total number of upstream requests. */
  assertCallCount: (expected: number) => void;
  /**
   * Asserts that the calls to `path` exactly equal `expected`, which guards
   * against both N+1 regressions and silent extra retries.
   */
  assertCallsTo: (path: string, expected: number) => void;
  /** Restores the previous global `fetch`. */
  restore: () => void;
}

/** An empty but structurally valid Stack Exchange API response. */
export function emptyApiResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    items: [],
    has_more: false,
    quota_max: 300,
    quota_remaining: 299,
    ...overrides,
  };
}

/** Normalises an API URL to the key used in the route table. */
export function toApiPath(url: string): string {
  const { pathname } = new URL(url);
  const index = pathname.indexOf('/2.3');
  return index === -1 ? pathname : pathname.slice(index + '/2.3'.length);
}

function isScriptedResponse(value: unknown): value is ScriptedResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    ('status' in value || 'body' in value || 'rawBody' in value)
  );
}

function resolveRoute(route: RouteValue | undefined, call: RecordedCall): ScriptedResponse {
  if (route === undefined) {
    return { body: emptyApiResponse() };
  }
  const value = typeof route === 'function' ? route(call) : route;
  return isScriptedResponse(value) ? value : { body: value };
}

/**
 * Replaces `globalThis.fetch` with a recording stub.
 *
 * The returned harness must be `restore()`d (typically in `afterEach`) so other
 * suites see the real `fetch` again.
 */
export function installFetchHarness(options: HarnessOptions = {}): FetchHarness {
  const originalFetch = globalThis.fetch;
  const calls: RecordedCall[] = [];
  const { routes = {}, fallback } = options;

  const stub = async (input: unknown, init?: { signal?: AbortSignal | null }): Promise<Response> => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : String((input as { url?: string }).url ?? input);

    const parsed = new URL(url);
    const call: RecordedCall = {
      url,
      path: toApiPath(url),
      params: parsed.searchParams,
      get: (name: string) => parsed.searchParams.get(name),
      apiKey: parsed.searchParams.get('key') ?? undefined,
    };
    calls.push(call);

    if (init?.signal?.aborted) {
      const abortError = new Error('The operation was aborted.');
      abortError.name = 'AbortError';
      throw abortError;
    }

    const route = routes[call.path] ?? routes['*'] ?? fallback;
    const scripted = resolveRoute(route, call);
    const status = scripted.status ?? 200;
    const body = scripted.rawBody ?? JSON.stringify(scripted.body ?? emptyApiResponse());

    return new Response(body, {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };

  globalThis.fetch = stub as unknown as typeof globalThis.fetch;

  const callsTo = (path: string): RecordedCall[] => calls.filter((call) => call.path === path);

  return {
    calls,
    callsTo,
    callCount: () => calls.length,
    assertCallCount(expected: number): void {
      if (calls.length !== expected) {
        throw new Error(
          `Expected exactly ${expected} upstream API call(s) but saw ${calls.length}:\n` +
            calls.map((call, index) => `  ${index + 1}. ${call.path}?${call.params}`).join('\n')
        );
      }
    },
    assertCallsTo(path: string, expected: number): void {
      const actual = callsTo(path).length;
      if (actual !== expected) {
        throw new Error(
          `Expected exactly ${expected} call(s) to ${path} but saw ${actual}:\n` +
            calls.map((call, index) => `  ${index + 1}. ${call.path}`).join('\n')
        );
      }
    },
    restore(): void {
      globalThis.fetch = originalFetch;
    },
  };
}
