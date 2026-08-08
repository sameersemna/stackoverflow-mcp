import { StackOverflowServer } from "../index.js";
import { jest } from "@jest/globals";

// Store the original fetch
const originalFetch = global.fetch;

// Create a custom fetch function type
// @ts-ignore
type FetchFunc = typeof global.fetch;

describe("StackOverflowServer", () => {
  let server: StackOverflowServer;
  let mockFetch: jest.MockedFunction<FetchFunc>;

  beforeEach(() => {
    // Create a fresh mock and server for each test
    server = new StackOverflowServer();
    jest.clearAllMocks();

    // Setup a fetch mock
    mockFetch = jest.fn() as jest.MockedFunction<FetchFunc>;
    global.fetch = mockFetch;
  });

  afterEach(() => {
    // Restore original fetch
    global.fetch = originalFetch;
  });

  test("should be instantiated correctly", () => {
    expect(server).toBeInstanceOf(StackOverflowServer);
  });

  test("should format response as JSON correctly", () => {
    const mockResult = {
      question: {
        question_id: 12345,
        title: "Test Question",
        body: "Test body",
        score: 10,
        answer_count: 2,
        is_answered: true,
        creation_date: 1615000000,
        tags: ["javascript"],
        link: "https://stackoverflow.com/q/12345",
      },
      answers: [
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

    const jsonResponse = (server as any).formatResponse([mockResult], "json");
    const parsedResponse = JSON.parse(jsonResponse);

    expect(parsedResponse).toHaveProperty('pagination');
    expect(parsedResponse).toHaveProperty('results');
    expect(parsedResponse.results).toBeInstanceOf(Array);
    expect(parsedResponse.results.length).toBe(1);
    expect(parsedResponse.results[0].question.question_id).toBe(12345);
  });

  test("should format response as Markdown correctly", () => {
    const mockResult = {
      question: {
        question_id: 12345,
        title: "Test Question",
        body: "Test body",
        score: 10,
        answer_count: 2,
        is_answered: true,
        creation_date: 1615000000,
        tags: ["javascript"],
        link: "https://stackoverflow.com/q/12345",
      },
      answers: [
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

    const markdownResponse = (server as any).formatResponse(
      [mockResult],
      "markdown"
    );

    expect(markdownResponse).toContain("# Test Question");
    expect(markdownResponse).toContain("**Score:** 10");
    expect(markdownResponse).toContain("### ✓ Answer (Score: 5)");
  });
});
