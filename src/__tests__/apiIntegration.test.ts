import { StackOverflowServer } from "../index.js";
import {
  jest,
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
} from "@jest/globals";

// Store the original fetch
const originalFetch = global.fetch;

// Mock data for testing
const mockQuestionResponse = {
  items: [
    {
      question_id: 12345,
      title: "Test Question",
      body: "Test body",
      score: 10,
      answer_count: 2,
      is_answered: true,
      accepted_answer_id: 67890,
      creation_date: 1615000000,
      tags: ["javascript"],
      link: "https://stackoverflow.com/q/12345",
    },
  ],
};

const mockAnswersResponse = {
  items: [
    {
      answer_id: 67890,
      question_id: 12345,
      score: 5,
      is_accepted: true,
      body: "Test answer",
      creation_date: 1615100000,
      link: "https://stackoverflow.com/a/67890",
    },
  ],
};

const mockCommentsResponse = {
  items: [
    {
      comment_id: 54321,
      post_id: 12345,
      score: 3,
      body: "Test comment",
      creation_date: 1615050000,
    },
  ],
};

// Create a custom fetch function type
// @ts-ignore
type FetchFunc = typeof global.fetch;

describe("Stack Exchange API Integration", () => {
  let server: StackOverflowServer;
  let mockFetch: jest.MockedFunction<FetchFunc>;

  beforeEach(() => {
    // Clear mocks and setup
    jest.clearAllMocks();

    // Create a mocked fetch function
    mockFetch = jest.fn() as jest.MockedFunction<FetchFunc>;
    global.fetch = mockFetch;

    // Create a new server instance for each test
    server = new StackOverflowServer();

    // Mock the server's runStdio method to prevent it from connecting to stdio transport
    // This is needed to ensure we don't leave connections open after tests
    jest
      .spyOn(server as any, "runStdio")
      .mockImplementation(() => Promise.resolve());

    // Create a mock implementation for the server to avoid connection issues
    if (server) {
      (server as any).server = {
        // @ts-ignore - Ignoring the type error for the test mock
        connect: jest.fn().mockResolvedValue(undefined),
        // @ts-ignore - Ignoring the type error for the test mock
        close: jest.fn().mockResolvedValue(undefined),
      };
    }
  });

  afterEach(async () => {
    // Restore global.fetch after test
    global.fetch = originalFetch;
  });

  test("should fetch questions from Stack Overflow API", async () => {
    // Mock the API responses
    mockFetch
      .mockImplementationOnce(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve(mockQuestionResponse),
        } as Response)
      )
      .mockImplementationOnce(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve(mockAnswersResponse),
        } as Response)
      );

    // Call the search method
    const paged = await (server as any).searchStackOverflow("test query");

    // Verify the results
    expect(paged.results).toHaveLength(1);
    expect(paged.page).toBe(1);
    expect(paged.hasMore).toBe(false);
    expect(paged.results[0].question.question_id).toBe(12345);
    expect(paged.results[0].answers.length).toBe(1);
    expect(paged.results[0].answers[0].answer_id).toBe(67890);

    // Verify the API was called with correct parameters
    const firstCallUrl = mockFetch.mock.calls[0][0] as string;
    const url = new URL(firstCallUrl);
    expect(url.pathname).toBe("/2.3/search/advanced");
    expect(url.searchParams.get("q")).toBe("test query");
    expect(url.searchParams.get("site")).toBe("stackoverflow");
    // Relevance sorting produces better error-message matches than votes
    expect(url.searchParams.get("sort")).toBe("relevance");
  });

  test("should fetch questions by tags from Stack Overflow API", async () => {
    // Mock the API responses
    mockFetch
      .mockImplementationOnce(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve(mockQuestionResponse),
        } as Response)
      )
      .mockImplementationOnce(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve(mockAnswersResponse),
        } as Response)
      );

    // Call the search by tags method
    const result = await (server as any).handleSearchByTags({
      tags: ["javascript"],
      limit: 1,
      responseFormat: "json",
    });

    // Verify the API was called with correct parameters
    const firstCallUrl = mockFetch.mock.calls[0][0] as string;
    const url = new URL(firstCallUrl);
    expect(url.pathname).toBe("/2.3/questions");
    expect(url.searchParams.get("tagged")).toBe("javascript");
    expect(url.searchParams.get("site")).toBe("stackoverflow");
    expect(url.searchParams.get("filter")).toBe("withbody");
    expect(url.searchParams.get("pagesize")).toBe("1");

    // Verify the response
    expect(result.content[0].type).toBe("text");
    const parsedResponse = JSON.parse(result.content[0].text);
    expect(parsedResponse.results[0].question.question_id).toBe(12345);
  });

  test("should handle API errors gracefully", async () => {
    // Mock API to return an error
    mockFetch.mockImplementationOnce(() =>
      Promise.resolve({
        ok: false,
        status: 400,
        json: () =>
          Promise.resolve({
            error_id: 400,
            error_name: "bad_parameter",
            error_message: "Invalid parameter",
          }),
      } as Response)
    );

    // Call the search method and expect it to throw
    let errorThrown = false;
    try {
      await (server as any).searchStackOverflow("test query");
    } catch (error: any) {
      errorThrown = true;
      expect(error.message).toContain("Stack Overflow API error");
      expect(error.message).toContain("Invalid parameter");
    }

    // Verify that an error was thrown
    expect(errorThrown).toBe(true);
  });

  test("should fetch comments when includeComments is true", async () => {
    // Comments for both the question and its answer are fetched in a single
    // batched request to /posts/{ids}/comments.
    const batchedCommentsResponse = {
      items: [
        ...mockCommentsResponse.items,
        {
          comment_id: 54322,
          post_id: 67890,
          score: 2,
          body: "Answer comment",
          creation_date: 1615150000,
        },
      ],
    };

    // Mock the API responses: questions, answers, then batched comments
    mockFetch
      .mockImplementationOnce(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve(mockQuestionResponse),
        } as Response)
      )
      .mockImplementationOnce(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve(mockAnswersResponse),
        } as Response)
      )
      .mockImplementationOnce(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve(batchedCommentsResponse),
        } as Response)
      );

    // Call the search method with includeComments
    const paged = await (server as any).searchStackOverflow(
      "test query",
      undefined,
      { includeComments: true }
    );

    // Verify the results include comments
    expect(paged.results).toHaveLength(1);
    expect(paged.results[0].comments).toBeDefined();
    expect(paged.results[0].comments?.question).toHaveLength(1);
    expect(paged.results[0].comments?.answers[67890]).toHaveLength(1);

    // Verify comments were fetched with a single batched request
    const commentCallUrl = mockFetch.mock.calls[2][0] as string;
    const commentUrl = new URL(commentCallUrl);
    expect(commentUrl.pathname).toBe("/2.3/posts/12345;67890/comments");
  });
});
