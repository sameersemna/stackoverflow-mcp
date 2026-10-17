# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **Default page size is now 5 results when `limit` is omitted.** Previously no
  `pagesize` was sent at all, so the Stack Exchange default of 30 applied. With
  bodies, answers and comments that is 30 posts of content, which the 25,000
  character budget then truncated anyway — wasting API quota and context. Pass
  `limit` explicitly to restore the previous behaviour (up to 100).
  *(Owner sign-off requested: `PROGRESS.md` question 1.)*
- `pagination.totalCount` is now omitted unless the API reported a real total.
  It used to mirror the page size, which read like a total.
  *(Compatibility: the key is still present whenever a true total is known.)*
- `truncateText` truncation notices name the effective character limit instead of
  always reporting the global 25,000 default.

### Added

- `effectiveQuery`, `effectiveTags` and `usedFallback` on search results, so a
  client can page through the query that actually matched.

### Fixed

- Comments for large result sets no longer fail: vectorized ID lists are chunked
  to the API's 100-ID limit (a single request previously carried 144+ IDs and was
  rejected outright).
- Answers are paged until `has_more` is false (bounded), so questions other than
  the most popular ones no longer appear to have zero answers.
- The query-shortening / tag-relaxation fallback only runs on page 1, so page 2
  can no longer silently come from a different query than page 1.
- The Stack Exchange `key` query parameter is redacted from error messages, and
  pino redaction paths now cover `key`/`apiKey`/`token`/`authorization` at depth.
- Importing the server module no longer starts a stdio server (`src/index.ts` is
  now a legacy entry shim; the pure implementation lives in `src/server.ts`).
- The version is read from `package.json` instead of being hard-coded in three
  separate places.

[Unreleased]: https://github.com/sameersemna/stackoverflow-mcp/commits/HEAD
