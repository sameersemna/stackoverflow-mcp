import { StackOverflowServer } from "../server.js"
import { COMBINED_FILTER } from "../stackexchange/filters.js"
import { jest, describe, test, expect } from "@jest/globals"
import type {
  SearchByErrorInput,
  SearchByTagsInput,
  AnalyzeStackTraceInput,
} from "../types/index.js"
import { internals } from "./helpers/serverInternals.js"

// Store the original fetch
const originalFetch = global.fetch

// The fetch signature the tests stub; jest's own type for it.
type FetchFunc = typeof global.fetch

describe("Tool Handlers", () => {
  let mockFetch: jest.MockedFunction<FetchFunc>

  beforeEach(() => {
    // Create a mocked fetch function
    mockFetch = jest.fn()
    global.fetch = mockFetch
  })

  afterEach(() => {
    // Restore original fetch
    global.fetch = originalFetch
    jest.clearAllMocks()
  })

  test("should handle search_by_error correctly", async () => {
    const server = new StackOverflowServer()

    // Mock the searchStackOverflow method
    const searchSpy = jest.spyOn(internals(server), "searchStackOverflow")
    searchSpy.mockResolvedValue({ results: [], page: 1, hasMore: false })

    // Create input parameters
    const input: SearchByErrorInput = {
      errorMessage: "TypeError: Cannot read property",
      language: "javascript",
      technologies: ["react"],
      minScore: 5,
      includeComments: true,
      responseFormat: "json",
      limit: 10,
    }

    // Call the handler
    await internals(server).handleSearchByError(input)

    // Verify searchStackOverflow was called with correct parameters
    expect(searchSpy).toHaveBeenCalledWith(
      "TypeError: Cannot read property",
      ["javascript", "react"],
      {
        minScore: 5,
        limit: 10,
        includeComments: true,
      }
    )
  })

  test("should handle search_by_tags correctly", async () => {
    const server = new StackOverflowServer()

    // Mock API responses
    const mockQuestionResponse = {
      items: [
        {
          question_id: 12345,
          title: "Test Question",
          body: "Test body",
          score: 10,
          answer_count: 2,
          is_answered: true,
          creation_date: 1615000000,
          tags: ["typescript", "jest"],
          link: "https://stackoverflow.com/q/12345",
        },
      ],
    }

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
    }

    // Mock fetch responses
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

    // Create input parameters
    const input: SearchByTagsInput = {
      tags: ["typescript", "jest"],
      minScore: 10,
      includeComments: false,
      responseFormat: "markdown",
      limit: 5,
    }

    // Call the handler
    const result = await internals(server).handleSearchByTags(input)

    // Verify the API was called with correct parameters
    const firstCallUrl = mockFetch.mock.calls[0][0] as string
    const url = new URL(firstCallUrl)
    expect(url.hostname).toBe("api.stackexchange.com")
    expect(url.pathname).toBe("/2.3/questions")
    // Tags are normalized and sorted (B13), so the request is order-independent
    // and a caller cannot defeat the cache by reordering tags.
    expect(url.searchParams.get("tagged")).toBe("jest;typescript")
    expect(url.searchParams.get("site")).toBe("stackoverflow")
    // The combined filter returns questions with their answers and comments, so
    // one request replaces the separate answers/comments calls (Phase 4).
    expect(url.searchParams.get("filter")).toBe(COMBINED_FILTER)
    expect(url.searchParams.get("pagesize")).toBe("5")

    // Verify the response format
    expect(result.content[0].type).toBe("text")
    expect(result.content[0].text).toContain("# Test Question")
    expect(result.content[0].text).toContain("**Score:** 10")
  })

  test("should handle analyze_stack_trace correctly", async () => {
    const server = new StackOverflowServer()

    // Mock the searchStackOverflow method
    const searchSpy = jest.spyOn(internals(server), "searchStackOverflow")
    searchSpy.mockResolvedValue({ results: [], page: 1, hasMore: false })

    // Create input parameters
    const input: AnalyzeStackTraceInput = {
      stackTrace: "Error: Something went wrong\n  at Function.Module._load (module.js:417:25)",
      language: "nodejs",
      includeComments: true,
      responseFormat: "json",
      limit: 3,
    }

    // Call the handler
    await internals(server).handleAnalyzeStackTrace(input)

    // Verify searchStackOverflow was called with correct parameters
    expect(searchSpy).toHaveBeenCalledWith("Error: Something went wrong", ["nodejs"], {
      minScore: 0,
      limit: 3,
      includeComments: true,
    })
  })
})
