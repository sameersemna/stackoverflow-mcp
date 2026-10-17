/**
 * User-facing message builders.
 *
 * Responsibility: turn internal error state into text an LLM can act on. Kept
 * apart from the error classes so that the wording and the mechanics can change
 * independently.
 */

export function buildQuotaMessage(
  quotaRemaining: number | undefined,
  quotaMax: number | undefined,
  hasApiKey: boolean
): string {
  const usage =
    quotaRemaining !== undefined && quotaMax !== undefined ? ` (${quotaRemaining}/${quotaMax})` : ""
  const base =
    `Stack Exchange API quota exhausted${usage}. Requests are counted per day and reset at ` +
    "00:00 UTC (see https://api.stackexchange.com/docs/throttle)."
  return hasApiKey
    ? `${base} The configured API key allowance is spent; retry after the reset.`
    : `${base} Without an API key the allowance is roughly 300 requests/day per IP; set ` +
        "STACKOVERFLOW_API_KEY to raise it to about 10,000/day."
}
