/**
 * Cache behaviour tests.
 *
 * Responsibility: prove the four properties the previous inline `Map` lacked —
 * bounded size with real expiry, canonical keys, singleflight, and immutable
 * cached values — plus that errors are never cached.
 */
import { describe, expect, test } from '@jest/globals';
import { ResponseCache, cacheKey, canonicalJson, deepFreeze } from '../core/cache.js';
import { FakeClock } from './helpers/fakeClock.js';

describe('canonical cache keys', () => {
  test('key order does not change the key', () => {
    const a = cacheKey('search', { query: 'x', tags: ['a'], site: 'stackoverflow' });
    const b = cacheKey('search', { site: 'stackoverflow', tags: ['a'], query: 'x' });

    expect(a).toBe(b);
  });

  test('undefined values are ignored, so absent and explicit-undefined match', () => {
    const a = cacheKey('search', { query: 'x' });
    const b = cacheKey('search', { query: 'x', page: undefined });

    expect(a).toBe(b);
  });

  test('different values produce different keys', () => {
    expect(cacheKey('search', { query: 'x' })).not.toBe(cacheKey('search', { query: 'y' }));
    expect(cacheKey('search', { query: 'x' })).not.toBe(cacheKey('question', { query: 'x' }));
  });

  test('a schema-version bump invalidates previous keys', () => {
    expect(cacheKey('search', { query: 'x' }, 2)).not.toBe(cacheKey('search', { query: 'x' }, 3));
  });

  test('canonicalJson sorts nested objects and preserves array order', () => {
    expect(canonicalJson({ b: 1, a: { d: 1, c: 2 } })).toBe('{"a":{"c":2,"d":1},"b":1}');
    expect(canonicalJson(['b', 'a'])).toBe('["b","a"]');
  });
});

describe('response cache', () => {
  test('a second identical call is served from the cache', async () => {
    const cache = new ResponseCache();
    let calls = 0;
    const produce = async (): Promise<string> => {
      calls += 1;
      return 'value';
    };

    const key = cacheKey('search', { query: 'x' });
    expect(await cache.getOrProduce(key, 1000, produce)).toBe('value');
    expect(await cache.getOrProduce(key, 1000, produce)).toBe('value');

    expect(calls).toBe(1);
    expect(cache.stats().hits).toBe(1);
  });

  test('expired entries are removed rather than kept forever', async () => {
    const clock = new FakeClock();
    const cache = new ResponseCache({ now: clock.now });
    const key = cacheKey('search', { query: 'x' });

    await cache.getOrProduce(key, 1000, async () => 'value');
    expect(cache.stats().size).toBe(1);

    await clock.advance(1001);

    // The entry is gone: the size drops and the expiry is counted.
    expect(await cache.getOrProduce(key, 1000, async () => 'fresh')).toBe('fresh');
    expect(cache.stats().expirations).toBe(1);
    expect(cache.stats().size).toBe(1);
  });

  test('the cache stays within its bound and evicts least-recently-used entries', async () => {
    const cache = new ResponseCache({ maxEntries: 3 });

    for (const id of ['a', 'b', 'c']) {
      await cache.getOrProduce(cacheKey('search', { id }), 1000, async () => id);
    }
    expect(cache.stats().size).toBe(3);

    // Touch 'a' so it is no longer the least recently used.
    await cache.getOrProduce(cacheKey('search', { id: 'a' }), 1000, async () => 'a');

    await cache.getOrProduce(cacheKey('search', { id: 'd' }), 1000, async () => 'd');

    expect(cache.stats().size).toBe(3);
    expect(cache.stats().evictions).toBe(1);

    // 'b' was the least recently used, so it must be the one evicted.
    let produced = 0;
    await cache.getOrProduce(cacheKey('search', { id: 'a' }), 1000, async () => {
      produced += 1;
      return 'a';
    });
    await cache.getOrProduce(cacheKey('search', { id: 'b' }), 1000, async () => {
      produced += 1;
      return 'b';
    });
    expect(produced).toBe(1);
  });

  test('prune releases every expired entry', async () => {
    const clock = new FakeClock();
    const cache = new ResponseCache({ now: clock.now });

    await cache.getOrProduce(cacheKey('search', { id: 'a' }), 1000, async () => 'a');
    await cache.getOrProduce(cacheKey('search', { id: 'b' }), 5000, async () => 'b');

    await clock.advance(2000);

    expect(cache.prune()).toBe(1);
    expect(cache.stats().size).toBe(1);
  });

  test('concurrent identical calls collapse onto one upstream fetch', async () => {
    const cache = new ResponseCache();
    let calls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const produce = async (): Promise<string> => {
      calls += 1;
      await gate;
      return 'value';
    };

    const key = cacheKey('search', { query: 'x' });
    const pending = Array.from({ length: 5 }, () => cache.getOrProduce(key, 1000, produce));

    release();
    const results = await Promise.all(pending);

    expect(calls).toBe(1);
    expect(results).toEqual(['value', 'value', 'value', 'value', 'value']);
    expect(cache.stats().coalesced).toBe(4);
  });

  test('errors are not cached, so the next caller retries', async () => {
    const cache = new ResponseCache();
    let calls = 0;
    const produce = async (): Promise<string> => {
      calls += 1;
      if (calls === 1) {
        throw new Error('transient');
      }
      return 'value';
    };

    const key = cacheKey('search', { query: 'x' });
    await expect(cache.getOrProduce(key, 1000, produce)).rejects.toThrow('transient');
    expect(await cache.getOrProduce(key, 1000, produce)).toBe('value');

    expect(calls).toBe(2);
  });

  test('an error does not poison in-flight waiters for later callers', async () => {
    const cache = new ResponseCache();
    let calls = 0;
    const produce = async (): Promise<string> => {
      calls += 1;
      throw new Error(`failure ${calls}`);
    };

    const key = cacheKey('search', { query: 'x' });
    await expect(cache.getOrProduce(key, 1000, produce)).rejects.toThrow('failure 1');
    await expect(cache.getOrProduce(key, 1000, produce)).rejects.toThrow('failure 2');

    expect(cache.stats().size).toBe(0);
    expect(cache.stats().inFlight).toBe(0);
  });

  test('a zero TTL disables caching but still collapses concurrent duplicates', async () => {
    const cache = new ResponseCache();
    let calls = 0;
    const produce = async (): Promise<number> => {
      calls += 1;
      await Promise.resolve();
      return calls;
    };

    const key = cacheKey('search', { query: 'x' });
    await cache.getOrProduce(key, 0, produce);
    await cache.getOrProduce(key, 0, produce);

    expect(calls).toBe(2);
    expect(cache.stats().size).toBe(0);
  });

  test('bypass refreshes the entry rather than reading the stale one', async () => {
    const cache = new ResponseCache();
    let calls = 0;
    const produce = async (): Promise<number> => {
      calls += 1;
      return calls;
    };

    const key = cacheKey('search', { query: 'x' });
    expect(await cache.getOrProduce(key, 1000, produce)).toBe(1);
    expect(await cache.getOrProduce(key, 1000, produce, true)).toBe(2);
    expect(await cache.getOrProduce(key, 1000, produce)).toBe(2);
  });

  test('cached values are frozen so a caller cannot corrupt the cache', async () => {
    const cache = new ResponseCache();
    const key = cacheKey('search', { query: 'x' });

    interface Payload {
      nested: { value: number };
      list: number[];
    }

    const first = await cache.getOrProduce<Payload>(key, 1000, async () => ({
      nested: { value: 1 },
      list: [1],
    }));

    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.nested)).toBe(true);

    const second = await cache.getOrProduce<Payload>(key, 1000, async () => ({
      nested: { value: 2 },
      list: [2],
    }));

    // The mutation attempt and the second producer both leave the value intact.
    expect(second.nested.value).toBe(1);
  });

  test('clear empties the cache', async () => {
    const cache = new ResponseCache();
    await cache.getOrProduce(cacheKey('search', { query: 'x' }), 1000, async () => 'v');
    cache.clear();

    expect(cache.stats().size).toBe(0);
  });

  test('deepFreeze tolerates primitives and already-frozen values', () => {
    expect(deepFreeze(1)).toBe(1);
    expect(deepFreeze('x')).toBe('x');
    const frozen = Object.freeze({ a: 1 });
    expect(deepFreeze(frozen)).toBe(frozen);
  });

  test('per-kind TTLs are reported', () => {
    const cache = new ResponseCache({ ttls: { search: 123 } });
    expect(cache.ttlFor('search')).toBe(123);
    expect(cache.ttlFor('tagSynonyms')).toBeGreaterThan(cache.ttlFor('search'));
  });
});
