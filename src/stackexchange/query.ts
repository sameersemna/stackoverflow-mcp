/**
 * Query shaping and error-message extraction.
 *
 * Responsibility: turn a user's error message or stack trace into something the
 * Stack Exchange search API can match, and render API failures readably. Pure
 * and side-effect-free; Phase 4 adds tag normalization and synonym resolution
 * alongside this module.
 */

/**
 * Builds progressively broader query variants for fallback searching.
 *
 * Stack Exchange returns zero results for very specific queries (long error
 * messages), even when closely related questions exist. When the full query
 * yields nothing we retry with progressively shorter prefixes, which retain the
 * leading error type and message while dropping volatile trailing detail.
 *
 * @returns An ordered list of distinct query variants, most specific first.
 */
export function buildQueryVariants(query: string): string[] {
  const words = query.split(/\s+/).filter((word) => word.length > 0);
  const variants: string[] = [query];

  // Only shorten when there is enough trailing detail to be worth dropping
  for (const maxWords of [8, 5, 3]) {
    if (words.length > maxWords) {
      const shortened = words.slice(0, maxWords).join(' ');
      if (!variants.includes(shortened)) {
        variants.push(shortened);
      }
    }
  }

  return variants;
}

/** Generic stack-trace header lines that carry no search value. */
const STACK_TRACE_NOISE = [
  /^traceback \(most recent call last\):?$/i,
  /^during handling of the above exception/i,
  /^the above exception was the direct cause/i,
  /^at\s+/i,
  /^file\s+["']/i,
  /^\s*\.{3}\s*\d+\s+more\s*$/i,
  /^error:?\s*$/i,
];

/**
 * Generic prefixes that appear before the real error on the same line.
 * These are stripped rather than discarding the whole line, because in Java the
 * thread header and the exception share a line
 * (e.g. `Exception in thread "main" java.lang.NullPointerException: ...`).
 */
const STACK_TRACE_PREFIXES = [
  /^exception in thread\s+["“”']?[^"“”']*["“”']?\s*/i,
  /^caused by:\s*/i,
  /^uncaught\s+/i,
  /^fatal:\s*/i,
];

/**
 * Extracts the most meaningful error line from a stack trace.
 *
 * The first line is often a generic header (e.g. Python's
 * "Traceback (most recent call last):"), so we scan for the first line that
 * looks like an actual error message and fall back to the first non-empty line.
 * Generic prefixes on the same line are stripped so the exception type and
 * message are preserved.
 */
export function extractErrorMessage(stackTrace: string): string {
  const lines = stackTrace
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return stackTrace.trim();
  }

  const isNoise = (line: string) => STACK_TRACE_NOISE.some((pattern) => pattern.test(line));

  const stripPrefixes = (line: string) => {
    let result = line;
    for (const pattern of STACK_TRACE_PREFIXES) {
      result = result.replace(pattern, '');
    }
    return result.trim();
  };

  // Prefer a line that names an error/exception type
  const errorLike = lines.find(
    (line) =>
      !isNoise(line) &&
      /(error|exception|fatal|panic|failed|failure|denied|refused|timeout|not found|undefined|null|cannot|unable|invalid|unexpected)/i.test(
        line
      )
  );
  if (errorLike) {
    return stripPrefixes(errorLike);
  }

  const firstMeaningful = lines.find((line) => !isNoise(line));
  return stripPrefixes(firstMeaningful ?? lines[0]);
}

/**
 * Cleans an error message so it works better as a Stack Exchange search query.
 *
 * Removes volatile fragments (file paths, hex addresses, line numbers, memory
 * addresses) that prevent the API from matching real questions, and strips
 * square brackets because Stack Exchange interprets `[...]` as tag syntax
 * (e.g. `[Errno 2]` is treated as a non-existent tag and yields zero results).
 */
export function cleanErrorMessage(message: string): string {
  let cleaned = message;

  // Drop trailing stack frames / "at ..." segments.
  //
  // The whitespace runs are bounded for the same reason as the path pattern below:
  // an unbounded `\s+` makes the engine try a growing run at every position, so a
  // 10,000-space message took 320 ms. A stack frame's separator is a single space or
  // tab in practice, so the bound costs nothing for real input.
  cleaned = cleaned.split(/[ \t]{1,16}at[ \t]{1,16}/)[0];

  // Remove file paths and line/column references
  // The repetition is bounded on purpose. Unbounded, this pattern scans from every
  // `/` to the end of the string looking for `:\d+` before failing, which is O(n^2):
  // a 20,000-character path-like error message took 760 ms. Real stack-trace paths
  // are far shorter than the bound, so behaviour for genuine input is unchanged.
  cleaned = cleaned.replace(/([A-Za-z]:)?[\\/][\w.\-/\\]{0,128}:\d+(:\d+)?/g, ' ');
  cleaned = cleaned.replace(/\([\w./\\-]{0,128}:\d+(:\d+)?\)/g, ' ');

  // Remove hex addresses and long numeric identifiers
  cleaned = cleaned.replace(/0x[0-9a-fA-F]+/g, ' ');
  cleaned = cleaned.replace(/\b[0-9a-fA-F]{8,}\b/g, ' ');

  // Square brackets are parsed as tag filters by the Stack Exchange search API
  cleaned = cleaned.replace(/[[\]]/g, ' ');

  // Unwrap quoted literals, keeping their content (e.g. 'length' -> length)
  cleaned = cleaned.replace(/['"`]/g, ' ');

  // Remove line/column suffixes like ":12:34"
  cleaned = cleaned.replace(/:\d+(:\d+)?\b/g, ' ');

  // Collapse whitespace and trim punctuation
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  cleaned = cleaned.replace(/^[\s:,-]+|[\s:,-]+$/g, '');

  return cleaned.length > 0 ? cleaned : message.trim();
}
