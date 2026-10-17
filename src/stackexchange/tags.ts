/**
 * Tag normalization.
 *
 * Responsibility: turn whatever a caller typed into the tag names Stack Exchange
 * actually uses, so a search matches instead of silently returning nothing.
 *
 * Stack Overflow tag names are lowercase and hyphenated (`visual-studio`,
 * `node-js`), and a tag the site has aliased must be resolved to its target
 * (`react` -> `reactjs`) rather than dropped. Dropping the filter — the previous
 * behaviour — answered a `react` search with unrelated questions from the whole
 * site, which looked like a worse-quality search rather than a resolution
 * failure.
 *
 * This module is pure. Synonym *lookup* (which needs the API) lives in the
 * client, because a normalized list has to be usable without network access.
 */

/**
 * Normalizes one tag.
 *
 * Lowercases, trims, converts whitespace runs to single hyphens, collapses
 * repeated hyphens and trims leading/trailing hyphens.
 *
 * @param tag - Raw caller input.
 * @returns The normalized tag, or an empty string when nothing usable remains.
 */
export function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase().replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "")
}

/**
 * Normalizes a list of tags.
 *
 * Drops unusable entries, removes duplicates and **sorts**, so that the same
 * logical set always produces the same request and the same cache key. Sorting is
 * correct because the API documents vectors as unordered
 * (https://api.stackexchange.com/docs/vectors).
 *
 * @param tags - Raw caller input, or `undefined`.
 * @returns A sorted, deduplicated list of normalized tags.
 */
export function normalizeTags(tags: readonly string[] | undefined): string[] {
  if (!tags || tags.length === 0) {
    return []
  }
  const normalized = new Set<string>()
  for (const tag of tags) {
    const value = normalizeTag(tag)
    if (value.length > 0) {
      normalized.add(value)
    }
  }
  return [...normalized].sort()
}

/**
 * Canonical form of a tag list for a cache key.
 *
 * Tags are already sorted by {@link normalizeTags}; this exists so that callers
 * building a key cannot forget to normalize first, and so the intent is explicit
 * at the call site.
 *
 * @param tags - Tags in any form.
 */
export function tagsForCacheKey(tags: readonly string[] | undefined): string[] {
  return normalizeTags(tags)
}
