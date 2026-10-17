/**
 * Tag normalization tests (B13).
 *
 * Responsibility: pin how a caller's tag input is turned into what the API
 * expects, and prove synonyms are resolved rather than the filter being dropped.
 *
 * The previous behaviour only lowercased `language`: `technologies` and `tags`
 * kept their original case, spaces were not converted to the hyphens Stack
 * Overflow uses ("visual studio" vs "visual-studio"), duplicates and order were
 * passed through untouched, and a synonym was handled by *dropping the tag
 * filter entirely* — so `react` silently searched everything instead of
 * searching `reactjs`.
 */
import { describe, expect, test } from '@jest/globals';
import { normalizeTag, normalizeTags, tagsForCacheKey } from '../stackexchange/tags.js';

describe('tag normalization (B13)', () => {
  test('lowercases and trims', () => {
    expect(normalizeTag('  JavaScript  ')).toBe('javascript');
    expect(normalizeTag('PYTHON')).toBe('python');
  });

  test('converts spaces to hyphens, which is how Stack Overflow names tags', () => {
    expect(normalizeTag('visual studio')).toBe('visual-studio');
    expect(normalizeTag('visual   studio  code')).toBe('visual-studio-code');
  });

  test('collapses repeated separators and trims stray ones', () => {
    expect(normalizeTag('--node--js--')).toBe('node-js');
    expect(normalizeTag(' a - b ')).toBe('a-b');
  });

  test('returns an empty string for input with no usable characters', () => {
    expect(normalizeTag('   ')).toBe('');
    expect(normalizeTag('---')).toBe('');
  });

  test('drops empty entries, dedupes and sorts so order does not matter', () => {
    expect(normalizeTags(['Python', 'python', '  ', 'JavaScript'])).toEqual(['javascript', 'python']);
    expect(normalizeTags(['b', 'a', '', 'b'])).toEqual(['a', 'b']);
  });

  test('tolerates a missing or empty list', () => {
    expect(normalizeTags(undefined)).toEqual([]);
    expect(normalizeTags([])).toEqual([]);
  });

  test('cache keys are order-independent for tags', () => {
    // The API treats vectors as unordered, so cache keys must too. The values
    // are compared structurally, and the joined string is what a key would use.
    expect(tagsForCacheKey(['b', 'a'])).toEqual(tagsForCacheKey(['a', 'b']));
    expect(tagsForCacheKey(['A', ' b '])).toEqual(tagsForCacheKey(['a', 'b']));
    expect(tagsForCacheKey(['b', 'a']).join(';')).toBe('a;b');
  });

  test('normalization is idempotent', () => {
    const once = normalizeTags([' Visual Studio ', 'React']);
    expect(normalizeTags(once)).toEqual(once);
  });
});
