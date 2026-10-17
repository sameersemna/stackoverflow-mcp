/**
 * Response cache for Stack Exchange reads.
 *
 * Responsibility: spend API quota once for a given question, and never return a
 * mutated or stale value. Four things the previous inline `Map` did not do:
 *
 * 1. **Bounded, with expiry actually reclaimed.** The old `Map` grew forever:
 *    expired entries were never removed, so a long-running systemd service leaked
 *    memory and kept every response it had ever seen alive.
 * 2. **Canonical keys.** The old key was `JSON.stringify({query, tags, options})`,
 *    which changes with property insertion order, tag order, tag case and
 *    whitespace — so the same logical search could miss the cache.
 * 3. **Singleflight.** Concurrent identical calls each spent quota; with agent
 *    retries and parallel tool calls that is the common case, not the rare one.
 * 4. **Immutable values.** Cached objects were handed out by reference, so a
 *    caller mutating a result silently corrupted the cache for everyone.
 *
 * Errors are never cached: a transient failure must not be replayed to every
 * later caller for the lifetime of the process.
 */
import { createHash } from "node:crypto"

/** Cache entry lifetimes, per data kind. */
export interface CacheTtls {
  /** Search responses. */
  search: number
  /** A question and its answers. */
  question: number
  /** Comments for a post. */
  comments: number
  /** Tag synonyms. */
  tagSynonyms: number
}

export const DEFAULT_CACHE_TTLS: CacheTtls = {
  search: 10 * 60 * 1000,
  question: 60 * 60 * 1000,
  comments: 30 * 60 * 1000,
  tagSynonyms: 24 * 60 * 60 * 1000,
}

export interface ResponseCacheOptions {
  /** Maximum number of live entries before the least-recently-used is evicted. */
  maxEntries?: number
  /** Per-kind lifetimes. */
  ttls?: Partial<CacheTtls>
  /** Clock, injected for deterministic expiry tests. */
  now?: () => number
}

/** Cache statistics, exposed for diagnostics and tests. */
export interface CacheStats {
  size: number
  hits: number
  misses: number
  evictions: number
  expirations: number
  /** In-flight singleflight promises. */
  inFlight: number
  /** Requests collapsed onto an in-flight identical call. */
  coalesced: number
}

interface Entry {
  value: unknown
  expiresAt: number
}

/** The data kinds a key can belong to, which selects the TTL. */
export type CacheKind = keyof CacheTtls

/**
 * Stable, collision-resistant serialisation of a cache key.
 *
 * Object keys are sorted recursively and `undefined` is dropped, so two
 * logically identical argument objects always hash the same. Array order is
 * preserved except where the caller has already normalized it (tag order is
 * normalized by `stackexchange/query.ts` before a key is built).
 */
/**
 * True for the values `JSON.stringify` renders as a JSON scalar.
 *
 * `JSON.stringify` is typed as returning `string`, but at runtime it returns
 * `undefined` for `undefined`, functions and symbols. Cache key material must
 * always be a string, so those collapse to the JSON literal `null` — exactly
 * what a genuine `null` already produces, so the two are indistinguishable in a
 * key, which is fine: neither carries information.
 */
function isJsonScalar(value: unknown): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return isJsonScalar(value) ? JSON.stringify(value) : "null"
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalJson(entryValue)}`).join(",")}}`
}

/**
 * Builds a cache key from the parts that identify a request.
 *
 * A schema version is included so that changing the result shape cannot serve
 * stale payloads produced by an older format.
 *
 * @param kind - Data kind, which selects the TTL.
 * @param parts - Values that fully identify the request (site, query, options).
 * @param schemaVersion - Bump when the cached value's shape changes.
 */
export function cacheKey(
  kind: CacheKind,
  parts: Record<string, unknown>,
  schemaVersion = 2
): string {
  const digest = createHash("sha256").update(canonicalJson(parts)).digest("hex")
  return `${kind}:${schemaVersion}:${digest}`
}

/** Deeply freezes plain objects and arrays so cached values cannot be mutated. */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value
  }
  Object.freeze(value)
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child)
  }
  return value
}

export class ResponseCache {
  private readonly entries = new Map<string, Entry>()
  private readonly inFlight = new Map<string, Promise<unknown>>()
  private readonly maxEntries: number
  private readonly ttls: CacheTtls
  private readonly now: () => number

  private hits = 0
  private misses = 0
  private evictions = 0
  private expirations = 0
  private coalesced = 0

  constructor(options: ResponseCacheOptions = {}) {
    this.maxEntries = Math.max(1, options.maxEntries ?? 500)
    this.ttls = { ...DEFAULT_CACHE_TTLS, ...options.ttls }
    this.now = options.now ?? (() => Date.now())
  }

  /**
   * Returns a cached value, or produces, stores and returns a new one.
   *
   * Concurrent callers with the same key share a single `producer` invocation
   * (singleflight). Rejections are propagated but never cached.
   *
   * @param key - Key from {@link cacheKey}.
   * @param ttlMs - Lifetime for this entry; `0` disables caching for this call.
   * @param producer - Called at most once per key while a value is being produced.
   * @param bypass - When true, skip the cache read (and still refresh the entry).
   */
  async getOrProduce<T>(
    key: string,
    ttlMs: number,
    producer: () => Promise<T>,
    bypass = false
  ): Promise<T> {
    if (ttlMs > 0 && !bypass) {
      const cached = this.read(key)
      if (cached.hit) {
        // The cache stores opaque values; `T` is the caller's assertion, backed
        // by the code path that wrote this entry under this key.
        return cached.value as T
      }
    } else if (ttlMs <= 0) {
      // Caching disabled for this call: still collapse concurrent duplicates,
      // because two identical in-flight requests are pure waste.
    }

    const existing = this.inFlight.get(key)
    if (existing) {
      this.coalesced += 1
      return existing as Promise<T>
    }

    const promise = (async () => {
      const value = await producer()
      if (ttlMs > 0) {
        this.write(key, value, ttlMs)
      }
      return value
    })()

    this.inFlight.set(key, promise)
    try {
      return await promise
    } finally {
      // Clear before the value is handed to callers so the next caller after a
      // rejection can retry instead of inheriting a poisoned promise.
      this.inFlight.delete(key)
    }
  }

  /**
   * Reads a live entry.
   *
   * Expired entries are deleted on access, which is what stops the map growing
   * without bound under long uptime.
   */
  private read(key: string): { hit: true; value: unknown } | { hit: false } {
    const entry = this.entries.get(key)
    if (!entry) {
      this.misses += 1
      return { hit: false }
    }
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key)
      this.expirations += 1
      this.misses += 1
      return { hit: false }
    }
    // Refresh recency for LRU ordering: delete + set moves it to the end.
    this.entries.delete(key)
    this.entries.set(key, entry)
    this.hits += 1
    return { hit: true, value: entry.value }
  }

  private write(key: string, value: unknown, ttlMs: number): void {
    this.entries.delete(key)
    this.entries.set(key, { value: deepFreeze(value), expiresAt: this.now() + ttlMs })
    this.evictIfNeeded()
  }

  /** Drops least-recently-used entries until the cache is within its bound. */
  private evictIfNeeded(): void {
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value
      if (oldestKey === undefined) {
        return
      }
      this.entries.delete(oldestKey)
      this.evictions += 1
    }
  }

  /**
   * Removes every expired entry.
   *
   * Called periodically by `cli.ts` so a quiet process releases memory without
   * waiting for a lookup on the same key.
   *
   * @returns Number of entries removed.
   */
  prune(): number {
    const now = this.now()
    let removed = 0
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key)
        this.expirations += 1
        removed += 1
      }
    }
    return removed
  }

  /** Removes every entry, e.g. when a caller asks for fresh data. */
  clear(): void {
    this.entries.clear()
  }

  stats(): CacheStats {
    return {
      size: this.entries.size,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      expirations: this.expirations,
      inFlight: this.inFlight.size,
      coalesced: this.coalesced,
    }
  }

  /** Lifetime configured for a data kind. */
  ttlFor(kind: CacheKind): number {
    return this.ttls[kind]
  }
}
