import { StackOverflowServer } from "../index.js";
import { jest, describe, test, expect, beforeEach, afterEach } from "@jest/globals";
import type { SearchResult, PagedSearchResults } from "../types/index.js";

/**
 * Regression tests for the client-facing problems fixed in this change set:
 * - Tools must not declare an outputSchema / return thin structuredContent
 * - JSON output must always be valid JSON, even when truncated
 * - HTML post bodies must be converted to readable text
 * - Stack traces must yield a meaningful search query
 * - acceptedOnly must filter on accepted answers, not merely "answered"
 * - Pagination must be reflected in the response
 */

const makeResult = (overrides: Partial<SearchResult["question"]> = {}): SearchResult => ({
  question: {
    question_id: 12345,
    title: "Test Question",
    body: "<p>Hello &amp; welcome to <code>testing</code></p>",
    score: 10,
    answer_count: 1,
    is_answered: true,
    accepted_answer_id: 67890,
    creation_date: 1615000000,
    tags: ["javascript"],
    link: "https://stackoverflow.com/q/12345",
    ...overrides,
  },
  answers: [
    {
      answer_id: 67890,
      question_id: 12345,
      score: 5,
      is_accepted: true,
      body: "<p>Use <code>jest</code> &amp; <code>ts-jest</code></p>",
      creation_date: 1615100000,
      link: "https://stackoverflow.com/a/67890",
    },
  ],
});

describe("Regression fixes", () => {
  let server: StackOverflowServer;

  beforeEach(() => {
    server = new StackOverflowServer();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("tool handlers must not return structuredContent", async () => {
    jest.spyOn(server as any, "searchStackOverflow").mockResolvedValue({
      results: [makeResult()],
      page: 1,
      hasMore: false,
    } satisfies PagedSearchResults);

    const result = await (server as any).handleSearchByError({
      errorMessage: "TypeError: x is undefined",
      responseFormat: "json",
    });

    expect(result).not.toHaveProperty("structuredContent");
    expect(result.content[0].type).toBe("text");
  });

  test("JSON output stays valid JSON when it exceeds the character limit", () => {
    // Build a result whose serialized form is far larger than the 25k limit
    const huge = makeResult({
      body: `<p>${"x".repeat(40000)}</p>`,
    });

    const json = (server as any).formatResponse([huge], "json");

    // Must not throw
    const parsed = JSON.parse(json);
    expect(parsed).toHaveProperty("pagination");
    expect(parsed).toHaveProperty("results");
    expect(Array.isArray(parsed.results)).toBe(true);
  });

  test("JSON output caps answers and reports omitted count", () => {
    const manyAnswers: SearchResult = {
      ...makeResult(),
      answers: Array.from({ length: 12 }, (_, i) => ({
        answer_id: 1000 + i,
        question_id: 12345,
        score: 12 - i,
        is_accepted: i === 0,
        body: `<p>Answer ${i}</p>`,
        creation_date: 1615100000 + i,
        link: `https://stackoverflow.com/a/${1000 + i}`,
      })),
    };

    const parsed = JSON.parse((server as any).formatResponse([manyAnswers], "json"));
    expect(parsed.results[0].answers.length).toBeLessThanOrEqual(5);
    expect(parsed.results[0].answers_omitted).toBe(7);
  });

  test("markdown output converts HTML to readable text", () => {
    const md = (server as any).formatResponse([makeResult()], "markdown");

    expect(md).not.toContain("<p>");
    expect(md).not.toContain("&amp;");
    expect(md).toContain("Hello & welcome");
    expect(md).toContain("`testing`");
  });

  test("JSON output decodes HTML entities in question titles", () => {
    const result = makeResult({ title: "Cannot &#39;map&#39; &gt; undefined" });

    const parsed = JSON.parse((server as any).formatResponse([result], "json"));

    expect(parsed.results[0].question.title).toBe("Cannot 'map' > undefined");
  });

  test("analyze_stack_trace skips generic traceback headers", async () => {
    const spy = jest
      .spyOn(server as any, "searchStackOverflow")
      .mockResolvedValue({ results: [], page: 1, hasMore: false } satisfies PagedSearchResults);

    await (server as any).handleAnalyzeStackTrace({
      stackTrace:
        "Traceback (most recent call last):\n" +
        '  File "/app/main.py", line 42, in <module>\n' +
        "    df = pd.read_csv('data.csv')\n" +
        "FileNotFoundError: [Errno 2] No such file or directory: 'data.csv'",
      language: "python",
    });

    const query = spy.mock.calls[0][0] as string;
    expect(query).not.toContain("Traceback");
    expect(query).toContain("FileNotFoundError");
    // Square brackets are tag syntax on Stack Exchange and must be stripped
    expect(query).not.toContain("[");
    expect(query).not.toContain("]");
  });

  test("acceptedOnly filters on accepted answers, not merely answered", async () => {
    const withAccepted = makeResult({ question_id: 1, accepted_answer_id: 111 });
    const answeredOnly = makeResult({ question_id: 2, accepted_answer_id: undefined });

    jest.spyOn(server as any, "searchStackOverflow").mockResolvedValue({
      results: [withAccepted, answeredOnly],
      page: 1,
      hasMore: false,
    } satisfies PagedSearchResults);

    const result = await (server as any).handleSearchByQuery({
      query: "test",
      acceptedOnly: true,
      responseFormat: "json",
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0].question.question_id).toBe(1);
  });

  test("pagination from the API response is reflected in output", async () => {
    jest.spyOn(server as any, "searchStackOverflow").mockResolvedValue({
      results: [makeResult()],
      page: 3,
      hasMore: true,
    } satisfies PagedSearchResults);

    const result = await (server as any).handleSearchByQuery({
      query: "test",
      page: 3,
      responseFormat: "json",
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.pagination.page).toBe(3);
    expect(parsed.pagination.hasMore).toBe(true);
  });

  test("API errors returned with HTTP 200 are surfaced as errors", async () => {
    const originalFetch = global.fetch;
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            error_id: 400,
            error_name: "bad_parameter",
            error_message: "No site found for name `nope`",
          }),
      } as Response)
    ) as unknown as typeof global.fetch;

    try {
      await expect(
        (server as any).searchStackOverflow("test query")
      ).rejects.toThrow(/No site found/);
    } finally {
      global.fetch = originalFetch;
    }
  });

  test("minScore switches sort away from relevance (API rejects min+relevance)", async () => {
    const originalFetch = global.fetch;
    const urls: string[] = [];
    global.fetch = jest.fn((url: string) => {
      urls.push(url);
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ items: [], has_more: false }),
      } as Response);
    }) as unknown as typeof global.fetch;

    try {
      await (server as any).searchStackOverflow("test query", undefined, {
        minScore: 5,
      });
      const url = new URL(urls[0]);
      expect(url.searchParams.get("min")).toBe("5");
      expect(url.searchParams.get("sort")).toBe("votes");
    } finally {
      global.fetch = originalFetch;
    }
  });

  test("retries with a broader query when the full query matches nothing", async () => {
    const originalFetch = global.fetch;
    const queries: string[] = [];
    let call = 0;
    global.fetch = jest.fn((url: string) => {
      const q = new URL(url).searchParams.get("q") ?? "";
      queries.push(q);
      call += 1;
      // First (full) query returns nothing; the shortened variant matches
      const items =
        call === 1
          ? []
          : [
              {
                question_id: 1,
                title: "Match",
                body: "b",
                score: 1,
                answer_count: 0,
                is_answered: false,
                creation_date: 0,
                tags: ["java"],
                link: "https://stackoverflow.com/q/1",
              },
            ];
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ items, has_more: false }),
      } as Response);
    }) as unknown as typeof global.fetch;

    try {
      const paged = await (server as any).searchStackOverflow(
        "NullPointerException Cannot invoke String.length because s is null"
      );
      expect(queries.length).toBeGreaterThan(1);
      expect(queries[1].split(" ").length).toBeLessThan(queries[0].split(" ").length);
      expect(paged.results).toHaveLength(1);
    } finally {
      global.fetch = originalFetch;
    }
  });

  test("markdown omits the answers section when there are no answers", () => {
    const noAnswers: SearchResult = { ...makeResult(), answers: [] };
    const md = (server as any).formatResponse([noAnswers], "markdown");

    expect(md).not.toContain("## Answers");
    expect(md).toContain("## Question");
  });

  test("relaxes an unmatched tag filter and reports it as a note", async () => {
    const originalFetch = global.fetch;
    const urls: string[] = [];
    global.fetch = jest.fn((url: string) => {
      urls.push(url);
      const hasTag = new URL(url).searchParams.has("tagged");
      // Tagged search matches nothing; untagged search matches
      const items = hasTag
        ? []
        : [
            {
              question_id: 1,
              title: "Match",
              body: "b",
              score: 1,
              answer_count: 0,
              is_answered: false,
              creation_date: 0,
              tags: ["reactjs"],
              link: "https://stackoverflow.com/q/1",
            },
          ];
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ items, has_more: false }),
      } as Response);
    }) as unknown as typeof global.fetch;

    try {
      const paged = await (server as any).searchStackOverflow(
        "Cannot read property map of undefined",
        ["react"]
      );
      expect(paged.results).toHaveLength(1);
      expect(paged.notes?.[0]).toMatch(/tag filter was relaxed/i);
      // The final attempt must not carry the tag filter
      expect(new URL(urls[urls.length - 1]).searchParams.has("tagged")).toBe(false);
    } finally {
      global.fetch = originalFetch;
    }
  });

  test("notes are surfaced in both JSON and markdown output", () => {
    const note = "Tag filter was relaxed.";
    const json = JSON.parse(
      (server as any).formatResponse([makeResult()], "json", { notes: [note] })
    );
    expect(json.notes).toEqual([note]);

    const md = (server as any).formatResponse([makeResult()], "markdown", {
      notes: [note],
    });
    expect(md).toContain(note);
  });
});
