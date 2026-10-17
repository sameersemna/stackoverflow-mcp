/**
 * HTML-to-text conversion for Stack Exchange post bodies.
 *
 * Responsibility: turn the HTML that the API returns into readable plain text,
 * and decode the named/numeric entities Stack Overflow emits. Pure and
 * dependency-free so it can be unit-tested directly.
 */

/** Named HTML entities commonly found in Stack Overflow post bodies. */
const HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  times: '×',
  divide: '÷',
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°',
  middot: '·',
  bull: '•',
  laquo: '«',
  raquo: '»',
  euro: '€',
  pound: '£',
  yen: '¥',
  cent: '¢',
  sect: '§',
  para: '¶',
  dagger: '†',
  permil: '‰',
  prime: '′',
  Prime: '″',
  larr: '←',
  rarr: '→',
  harr: '↔',
  uarr: '↑',
  darr: '↓',
  infin: '∞',
  ne: '≠',
  le: '≤',
  ge: '≥',
  minus: '−',
  plusmn: '±',
  frac12: '½',
  frac14: '¼',
  frac34: '¾',
  sup2: '²',
  sup3: '³',
  alpha: 'α',
  beta: 'β',
  gamma: 'γ',
  delta: 'δ',
  lambda: 'λ',
  mu: 'μ',
  pi: 'π',
  sigma: 'σ',
  omega: 'ω',
  Delta: 'Δ',
  Sigma: 'Σ',
  Omega: 'Ω',
};

/**
 * Decodes HTML entities (named and numeric) found in Stack Overflow post bodies.
 */
export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isNaN(code) ? match : String.fromCodePoint(code);
    }
    if (entity.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isNaN(code) ? match : String.fromCodePoint(code);
    }
    return HTML_ENTITIES[entity] ?? match;
  });
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
    return '';
  }

  let text = html;

  // Normalise line breaks
  text = text.replace(/\r\n?/g, '\n');

  // Fenced code blocks: <pre><code class="...">...</code></pre>
  text = text.replace(
    /<pre[^>]*>\s*<code[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi,
    (_match, code: string) => `\n\`\`\`\n${decodeHtmlEntities(code).trim()}\n\`\`\`\n`
  );
  // <pre> without <code>
  text = text.replace(
    /<pre[^>]*>([\s\S]*?)<\/pre>/gi,
    (_match, code: string) => `\n\`\`\`\n${decodeHtmlEntities(code).trim()}\n\`\`\`\n`
  );
  // Inline code
  text = text.replace(
    /<code[^>]*>([\s\S]*?)<\/code>/gi,
    (_match, code: string) => `\`${decodeHtmlEntities(code).trim()}\``
  );

  // Block-level elements become newlines
  text = text.replace(/<\/(p|div|section|article|blockquote|h[1-6]|tr)>/gi, '\n\n');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<li[^>]*>/gi, '\n- ');
  text = text.replace(/<\/li>/gi, '');
  text = text.replace(/<hr\s*\/?>/gi, '\n---\n');

  // Links: keep the visible text and the href
  text = text.replace(
    /<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_match, href: string, label: string) => {
      const cleanLabel = label.replace(/<[^>]+>/g, '').trim();
      return cleanLabel && cleanLabel !== href ? `${cleanLabel} (${href})` : href;
    }
  );

  // Strip any remaining tags
  text = text.replace(/<[^>]+>/g, '');

  // Decode entities last so decoded `<`/`>` are not treated as markup
  text = decodeHtmlEntities(text);

  // Collapse excessive blank lines and trailing whitespace
  text = text.replace(/[ \t]+\n/g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');

  return text.trim();
}
