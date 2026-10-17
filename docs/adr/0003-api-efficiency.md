# ADR 0003 — API-call efficiency

- **Status:** Accepted
- **Date:** 2026-10-17
- **Phase:** 4 (API-call reduction)
- **Deciders:** maintainer (`sameersemna`), implementation by Copilot

## Context

Quota is the scarcest resource in this server. Verified live against the API
rather than assumed:

| Condition | Daily allowance |
|---|---|
| No API key | **300** requests/day, shared per IP |
| With an API key | **10,000** requests/day |

At the phase's start a typical search cost 2 requests (search + answers), 3 with
comments, and up to **7** when the query-fallback ladder ran (`error_id` variants +
tag relaxation + answers + comments), because the comment ID vector was not
chunked. That is roughly 37–150 searches per day on the anonymous allowance.

Three official documents changed the design, and two of them contradicted a
comment that was already in the code:

1. `https://api.stackexchange.com/docs/filters` — "Filters are **immutable and
   non-expiring**. An application can safely 'bake in' any filters that are
   created, it is not necessary (or advisable) to create filters at runtime."
   The code claimed built-in filters were used "to avoid invalidation issues",
   which is the opposite of what the API guarantees.
2. `https://api.stackexchange.com/docs/types/question` — a question "can
   optionally return comments and answers accordingly".
3. `https://api.stackexchange.com/docs/throttle` — quota is per day; the client
   must honour `backoff`, which Phase 1 already did.

## Decision

1. **Bake in a custom filter** that requests `question.body`,
   `question.answers`, `question.comments`, `answer.body`, `comment.body` and
   `question.accepted_answer_id`. Created once by hand with
   `scripts/create-filter.mjs` (the docs say filters should be pre-calculated,
   not created at runtime) and committed as `COMBINED_FILTER` in
   `src/stackexchange/filters.ts` together with the field list that produced it.
2. **Prefer inline data** in `processSearchResults`, falling back to separate
   `/questions/{ids}/answers` and `/posts/{ids}/comments` requests only when the
   inline fields are absent.
3. **Automatic fallback on rejection.** Because a rejected filter would break
   every search, a filter error (`error_id` 400/404 whose name/message mentions
   "filter") permanently flips the process back to built-in filters plus separate
   requests. Detection is narrow on purpose: an unrelated `bad_parameter` must not
   silently disable the optimisation and start costing extra quota.
4. **`acceptedOnly` deliberately opts out** of the combined filter. Earlier work
   in this repository observed that `accepted=True` was not honoured together with
   the combined filter; using the built-in path is preferable to quietly
   returning the wrong result set. Revisit if the API's behaviour changes.
5. **Normalize tags and resolve synonyms** (see below) rather than dropping a tag
   filter that matched nothing.

## Measured outcome

Verified end-to-end through the server against the live API:

| Tool call | Before | After |
|---|---|---|
| `search_by_error` (no comments) | 2 | **1** |
| `search_by_error` (`includeComments`) | 3 | **1** |
| `search_by_tags` (with comments) | 2–3 | **1** |
| Worst case with the fallback ladder | 7 | 1–2 |

Before implementing, the filter's inline answers were measured on the live API:
questions with **191, 55 and 36** answers returned every answer inline, so there is
no per-question cap to work around. `body` was present on questions and answers and
`comments` was populated.

## Consequences

- The anonymous allowance now supports roughly 300 searches/day instead of ~37–100.
- A search can return a large payload (a question with 191 answers). The existing
  `MAX_ANSWERS`/character-budget truncation already caps what is *rendered*; the
  bandwidth cost is real but is one request instead of several.
- The filter string is a committed constant. If Stack Exchange ever invalidates it
  (contrary to the documented guarantee), the fallback keeps the server working at
  the old request counts rather than failing.
- Phase 5's `structuredContent` work should expose the effective filter so a
  client can tell whether the optimisation is active.

## Tag normalization and synonyms (B13)

Tags are normalized (lowercased, trimmed, whitespace → hyphens, collapsed, deduped,
**sorted**) because the API matches tag names exactly: `JavaScript` or
`visual studio code` previously matched nothing at all. Sorting is correct because
the API documents vectors as unordered for caching and throttling purposes.

A tag that genuinely matches nothing is resolved through
`/tags/{tags}/synonyms`, whose documentation states a maximum of **20 tags per
request** (lower than the general 100-ID vector cap), cached for 24 h. The lookup is
**lazy — only on the miss path** — so a search whose tags are canonical still costs
one request, and the resolved attempt is added only when resolution actually changes
a tag.

## Alternatives considered

1. **Keep built-in filters and fetch answers/comments separately.** Rejected: it
   is strictly more requests for the same data, and the docs explicitly bless
   baking in filters.
2. **Create the filter at runtime on first use.** Rejected: the docs advise
   against it, it adds a request and a failure mode to normal operation, and it
   would make the filter id non-deterministic across restarts.
3. **Eagerly resolve synonyms before every search.** Rejected — implemented,
   measured, then reverted: it added a request to every call and broke five
   existing budget assertions. Lazy resolution on the miss path achieves the same
   correctness at no cost to the common case.
4. **Always drop the tag filter when it matches nothing.** Rejected: it answers a
   `react` search with unrelated questions from the entire site, which reads as a
   low-quality search rather than a resolution failure.
