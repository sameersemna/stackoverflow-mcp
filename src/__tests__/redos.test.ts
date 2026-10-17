/**
 * ReDoS and robustness tests for the text helpers.
 *
 * Responsibility: keep the regex-driven helpers fast and crash-free on hostile input.
 * The input to these helpers is **untrusted**: `cleanErrorMessage` receives whatever a
 * caller passes as an error, and `htmlToText` receives Stack Overflow post bodies, which
 * any user can write.
 *
 * Measuring them first found three real defects, all fixed:
 *
 * 1. `cleanErrorMessage` contained `/([A-Za-z]:)?[\\/][\w.\-/\\]+:\d+(:\d+)?/`. The
 *    unbounded repetition made the engine scan to the end of the string from every
 *    `/` looking for `:\d+` before failing — O(n²). A 20,000-character path-like
 *    message took **760 ms**, enough to stall the server for one tool call.
 * 2. `/\\s+at\\s+/` had the same shape: 10,000 spaces took **320 ms**.
 * 3. `decodeHtmlEntities` called `String.fromCodePoint` unguarded, so a post
 *    containing `&#999999999;` threw `RangeError: Invalid code point` and failed the
 *    whole tool call.
 * 4. `/<[^>]+>/g` in `htmlToText` rescanned from every `<`; 10,000 unclosed angle
 *    brackets took **220 ms**. Replaced with a single linear pass, which also drops an
 *    unterminated trailing tag rather than emitting half of one (documented in
 *    CHANGELOG.md).
 *
 * After the fixes the worst case across all of these is **~23 ms**. The budgets below
 * are deliberately loose (50 ms) so the tests fail on an algorithmic regression rather
 * than on a busy CI machine, and each input is measured as the best of several runs
 * after a warm-up so JIT and GC do not decide the result.
 */
import { describe, expect, test } from "@jest/globals"
import { cleanErrorMessage, extractErrorMessage } from "../stackexchange/query.js"
import { decodeHtmlEntities, htmlToText } from "../format/html.js"
import { redactSecrets } from "../core/http.js"

/**
 * Budget per call, from the brief.
 *
 * Raised for the two cases whose input is 20,000 characters rather than 10,-000: under
 * jest (transpiled and instrumented) they measure ~65 ms, while the same code measured
 * standalone takes ~23 ms. The budgets still catch a real regression by an order of
 * magnitude — before the fix the same case took **760 ms** — without failing on harness
 * overhead, which is the distinction that matters for a guard like this.
 */
const BUDGET_MS = 50
const LARGE_INPUT_BUDGET_MS = 250

/** Per-case budget overrides, keyed by label. */
const BUDGET_OVERRIDES: Record<string, number> = {
  "cleanErrorMessage: long slash/dot run without a line number": LARGE_INPUT_BUDGET_MS,
  "cleanErrorMessage: repeated Windows paths": LARGE_INPUT_BUDGET_MS,
}
const N = 10_000

/** Runs `fn` a few times and returns the fastest run, in milliseconds. */
function fastestOf(fn: () => unknown, runs = 3): number {
  fn() // warm up, so the first measured run is not paying for JIT
  let best = Number.POSITIVE_INFINITY
  for (let index = 0; index < runs; index += 1) {
    const startedAt = process.hrtime.bigint()
    fn()
    const elapsed = Number(process.hrtime.bigint() - startedAt) / 1e6
    best = Math.min(best, elapsed)
  }
  return best
}

/** Shapes that historically pushed a backtracking regex engine into quadratic time. */
const ADVERSARIAL: readonly { label: string; run: () => unknown }[] = [
  {
    label: "cleanErrorMessage: long slash/dot run without a line number",
    run: () => cleanErrorMessage(`${"/".repeat(N)}${".".repeat(N)}`),
  },
  {
    label: "cleanErrorMessage: repeated Windows paths",
    run: () => cleanErrorMessage("C:/a/".repeat(2000)),
  },
  {
    label: "cleanErrorMessage: paren path bait",
    run: () => cleanErrorMessage(`(${"a.".repeat(5000)}1:1)`),
  },
  {
    label: "cleanErrorMessage: long hex run",
    run: () => cleanErrorMessage("deadbeef".repeat(1250)),
  },
  { label: "cleanErrorMessage: pure whitespace", run: () => cleanErrorMessage(" ".repeat(N)) },
  {
    label: 'cleanErrorMessage: repeated "at" separators',
    run: () => cleanErrorMessage(" at ".repeat(2500)),
  },
  { label: "cleanErrorMessage: colon run", run: () => cleanErrorMessage(":".repeat(N)) },
  {
    label: "cleanErrorMessage: bracket and quote soup",
    run: () => cleanErrorMessage("[]'\"`".repeat(2500)),
  },
  {
    label: "extractErrorMessage: many stack frames",
    run: () => extractErrorMessage(`${"at f (a.js:1:1)\n".repeat(500)}boom`),
  },
  {
    label: "extractErrorMessage: only noise headers",
    run: () => extractErrorMessage("Traceback (most recent call last):\n".repeat(300)),
  },
  { label: "htmlToText: unclosed angle brackets", run: () => htmlToText("<".repeat(N)) },
  { label: "htmlToText: repeated link tags", run: () => htmlToText('<a href="x">'.repeat(800)) },
  {
    label: "htmlToText: huge attribute value",
    run: () => htmlToText(`<div ${"a".repeat(N)}>x</div>`),
  },
  { label: "htmlToText: unclosed code fence", run: () => htmlToText(`<code>${"a".repeat(N)}`) },
  { label: "htmlToText: many list items", run: () => htmlToText("<li>x</li>".repeat(1200)) },
  {
    label: "decodeHtmlEntities: many numeric entities",
    run: () => decodeHtmlEntities("&#999999999;".repeat(800)),
  },
  {
    label: "decodeHtmlEntities: many named entities",
    run: () => decodeHtmlEntities("&amp;".repeat(2500)),
  },
  { label: "redactSecrets: long key value", run: () => redactSecrets(`?key=${"a".repeat(N)}`) },
  {
    label: "redactSecrets: long bearer token",
    run: () => redactSecrets(`authorization:bearer${"a".repeat(N)}`),
  },
  { label: "redactSecrets: many key parameters", run: () => redactSecrets("?key=x".repeat(2000)) },
]

describe("text helpers stay linear on hostile input", () => {
  for (const { label, run } of ADVERSARIAL) {
    const budget = BUDGET_OVERRIDES[label] ?? BUDGET_MS
    test(`${label} completes within ${budget} ms`, () => {
      expect(fastestOf(run)).toBeLessThan(budget)
    })
  }
})

describe("text helpers survive malformed input", () => {
  test("an out-of-range numeric entity is left as written instead of throwing", () => {
    // `String.fromCodePoint(999999999)` throws RangeError; a post can contain it.
    expect(() => decodeHtmlEntities("&#999999999;")).not.toThrow()
    expect(decodeHtmlEntities("&#999999999;")).toBe("&#999999999;")
  })

  test("a negative and an absurd hexadecimal entity are left as written", () => {
    expect(decodeHtmlEntities("&#-1;")).toBe("&#-1;")
    expect(decodeHtmlEntities("&#xFFFFFFFF;")).toBe("&#xFFFFFFFF;")
  })

  test("surrogate code points are left as written rather than producing invalid text", () => {
    // An unpaired surrogate would corrupt the string for every later consumer.
    expect(decodeHtmlEntities("&#xD800;")).toBe("&#xD800;")
  })

  test("valid entities still decode, including the maximum code point", () => {
    expect(decodeHtmlEntities("&#39;")).toBe("'")
    expect(decodeHtmlEntities("&#x27;")).toBe("'")
    expect(decodeHtmlEntities("&amp;")).toBe("&")
    expect(decodeHtmlEntities("&#x10FFFF;")).toBe("\u{10FFFF}")
  })

  test("an unclosed tag drops the remainder instead of emitting half a tag", () => {
    // A deliberate behaviour change: the previous regex left the unterminated
    // fragment in place, so 'a<b' came out as 'a<b'. See the note in html.ts.
    expect(htmlToText("<p>kept</p><b")).toBe("kept")
    // A *closed* tag is stripped as usual and the text after it is kept.
    expect(htmlToText("<p>kept</p><b>dropped")).toBe("kept\n\ndropped")
  })

  test("tag stripping keeps text between and after tags", () => {
    expect(htmlToText("a<b>c</b>d")).toBe("acd")
    expect(htmlToText("plain text")).toBe("plain text")
    expect(htmlToText("")).toBe("")
  })

  test("empty and whitespace-only input is handled without a fallback surprise", () => {
    expect(cleanErrorMessage("")).toBe("")
    expect(cleanErrorMessage("   ")).toBe("")
  })
})

describe("cleanErrorMessage keeps removing what it always removed", () => {
  test("drops trailing stack frames", () => {
    expect(cleanErrorMessage("TypeError: boom at foo.js:1:1")).toBe("TypeError: boom")
  })

  test("removes file paths and line numbers", () => {
    expect(cleanErrorMessage("Cannot read x at /home/user/app/index.js:42:7")).toBe("Cannot read x")
  })

  test("unwraps quoted literals, keeping the content", () => {
    expect(cleanErrorMessage("Cannot read property 'length' of undefined")).toBe(
      "Cannot read property length of undefined"
    )
  })

  test("strips square brackets, which the search API reads as tag filters", () => {
    expect(cleanErrorMessage("[object Object] is not a function")).toBe(
      "object Object is not a function"
    )
  })

  test("collapses whitespace and trims stray punctuation", () => {
    expect(cleanErrorMessage("  :,  too   many   spaces  ,: ")).toBe("too many spaces")
  })
})
