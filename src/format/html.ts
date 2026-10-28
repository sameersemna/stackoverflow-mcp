/**
 * HTML-to-text conversion for Stack Exchange post bodies.
 *
 * Responsibility: turn the HTML that the API returns into readable plain text,
 * and decode the named/numeric entities Stack Overflow emits. Pure and
 * dependency-free so it can be unit-tested directly.
 */

/** Named HTML entities commonly found in Stack Overflow post bodies. */
const HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  times: "×",
  divide: "÷",
  copy: "©",
  reg: "®",
  trade: "™",
  deg: "°",
  middot: "·",
  bull: "•",
  laquo: "«",
  raquo: "»",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
  sect: "§",
  para: "¶",
  dagger: "†",
  permil: "‰",
  prime: "′",
  Prime: "″",
  larr: "←",
  rarr: "→",
  harr: "↔",
  uarr: "↑",
  darr: "↓",
  infin: "∞",
  ne: "≠",
  le: "≤",
  ge: "≥",
  minus: "−",
  plusmn: "±",
  frac12: "½",
  frac14: "¼",
  frac34: "¾",
  sup2: "²",
  sup3: "³",
  alpha: "α",
  beta: "β",
  gamma: "γ",
  delta: "δ",
  lambda: "λ",
  mu: "μ",
  pi: "π",
  sigma: "σ",
  omega: "ω",
  Delta: "Δ",
  Sigma: "Σ",
  Omega: "Ω",
}

/**
 * Converts a numeric entity to a character, or leaves it alone.
 *
 * `String.fromCodePoint` throws a `RangeError` for anything above `0x10FFFF` — and
 * post bodies are untrusted input, so `&#999999999;` used to crash the whole tool
 * call. Surrogates are also rejected because an unpaired one produces invalid text.
 *
 * @param code - Parsed code point, possibly `NaN` or out of range.
 * @param original - The original match, returned when the code point is unusable.
 */
function codePointToString(code: number, original: string): string {
  if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) {
    return original
  }
  if (code >= 0xd800 && code <= 0xdfff) {
    return original
  }
  return String.fromCodePoint(code)
}

/**
 * Decodes HTML entities (named and numeric) found in Stack Overflow post bodies.
 */
export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      return codePointToString(Number.parseInt(entity.slice(2), 16), match)
    }
    if (entity.startsWith("#")) {
      return codePointToString(Number.parseInt(entity.slice(1), 10), match)
    }
    return HTML_ENTITIES[entity] ?? match
  })
}

/**
 * Removes everything from a `<` to the next `>`, in one linear pass.
 *
 * **Deliberate behaviour change:** when a `<` has no closing `>` the remainder of the
 * string is dropped. The previous `/<[^>]+>/g` left the unterminated fragment in place
 * (`'a<b'` came out as `'a<b'`), which put a dangling partial tag in the output. Post
 * bodies are well-formed in practice, so this affects only malformed input, and
 * dropping an incomplete tag reads better than emitting half of one. Recorded in
 * CHANGELOG.md.
 *
 * @param text - Text that may still contain tags.
 */
function stripTags(text: string): string {
  if (!text.includes("<")) {
    return text
  }
  let out = ""
  let index = 0
  for (;;) {
    const open = text.indexOf("<", index)
    if (open === -1) {
      return out + text.slice(index)
    }
    out += text.slice(index, open)
    const close = text.indexOf(">", open + 1)
    if (close === -1) {
      return out
    }
    index = close + 1
  }
}

/**
 * Converts a Stack Overflow HTML post body into readable plain text / Markdown.
 *
 * Stack Overflow bodies are HTML fragments. Returning them verbatim makes the
 * output hard to read (raw tags, escaped entities such as `&#39;`). This helper
 * converts code blocks to fenced Markdown, inline code to backticks, and strips
 * the remaining markup while preserving paragraph and list structure.
 */
export function htmlToText(html: string): string {
  if (!html) {
    return ""
  }

  let text = html

  // Normalise line breaks
  text = text.replace(/\r\n?/g, "\n")

  // Fenced code blocks: <pre><code class="...">...</code></pre>
  text = text.replace(
    /<pre[^>]*>\s*<code[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi,
    (_match, code: string) => `\n\`\`\`\n${code.trim()}\n\`\`\`\n`
  )
  // <pre> without <code>
  text = text.replace(
    /<pre[^>]*>([\s\S]*?)<\/pre>/gi,
    (_match, code: string) => `\n\`\`\`\n${code.trim()}\n\`\`\`\n`
  )
  // Inline code
  text = text.replace(
    /<code[^>]*>([\s\S]*?)<\/code>/gi,
    (_match, code: string) => `\`${code.trim()}\``
  )

  // Block-level elements become newlines
  text = text.replace(/<\/(p|div|section|article|blockquote|h[1-6]|tr)>/gi, "\n\n")
  text = text.replace(/<br\s*\/?>/gi, "\n")
  text = text.replace(/<li[^>]*>/gi, "\n- ")
  text = text.replace(/<\/li>/gi, "")
  text = text.replace(/<hr\s*\/?>/gi, "\n---\n")

  // Links: keep the visible text and the href
  text = text.replace(
    /<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_match, href: string, label: string) => {
      const cleanLabel = label.replace(/<[^>]+>/g, "").trim()
      return cleanLabel && cleanLabel !== href ? `${cleanLabel} (${href})` : href
    }
  )

  // Strip any remaining tags in a single pass. A regex such as `/<[^>]+>/g` scans to
  // the end of the string from every `<` before failing, so a body that is mostly
  // angle brackets was O(n^2) (10,000 `<` characters took 220 ms).
  text = stripTags(text)

  // Decode entities last so decoded `<`/`>` are not treated as markup
  text = decodeHtmlEntities(text)

  // Collapse excessive blank lines and trailing whitespace
  text = text.replace(/[ \t]+\n/g, "\n")
  text = text.replace(/\n{3,}/g, "\n\n")

  return text.trim()
}
