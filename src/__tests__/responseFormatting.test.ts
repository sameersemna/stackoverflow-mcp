import { StackOverflowServer } from "../index.js";
import { describe, test, expect } from "@jest/globals";
import type { SearchResult } from "../types/index.js";

// Sample data for testing response formatting
const sampleSearchResult: SearchResult = {
  question: {
    question_id: 12345,
    title: "How to test TypeScript code?",
    body: "<p>I need help testing my TypeScript code. What are the best practices?</p>",
    score: 25,
    answer_count: 2,
    is_answered: true,
    accepted_answer_id: 67890,
    creation_date: 1615000000,
    tags: ["typescript", "testing", "jest"],
    link: "https://stackoverflow.com/questions/12345",
  },
  answers: [
    {
      answer_id: 67890,
      question_id: 12345,
      score: 15,
      is_accepted: true,
      body: "<p>Use Jest with ts-jest for TypeScript testing.</p><pre><code>npm install jest ts-jest @types/jest</code></pre>",
      creation_date: 1615100000,
      link: "https://stackoverflow.com/a/67890",
    },
    {
      answer_id: 67891,
      question_id: 12345,
      score: 5,
      is_accepted: false,
      body: "<p>You can also use Mocha with ts-node.</p>",
      creation_date: 1615200000,
      link: "https://stackoverflow.com/a/67891",
    },
  ],
  comments: {
    question: [
      {
        comment_id: 54321,
        post_id: 12345,
        score: 3,
        body: "Have you tried Jest?",
        creation_date: 1615050000,
      },
    ],
    answers: {
      67890: [
        {
          comment_id: 54322,
          post_id: 67890,
          score: 2,
          body: "Great answer, thanks!",
          creation_date: 1615150000,
        },
      ],
      67891: [],
    },
  },
};

describe("Response Formatting", () => {
  test("should format response as JSON correctly", () => {
    const server = new StackOverflowServer();

    // Call the formatResponse method with JSON format
    const jsonResponse = (server as any).formatResponse(
      [sampleSearchResult],
      "json"
    );

    // Parse the JSON response
    const parsedResponse = JSON.parse(jsonResponse);

    // Verify the JSON structure
    expect(parsedResponse).toHaveProperty('pagination');
    expect(parsedResponse).toHaveProperty('results');
    expect(parsedResponse.results).toBeInstanceOf(Array);
    expect(parsedResponse.results.length).toBe(1);
    expect(parsedResponse.results[0].question.question_id).toBe(12345);
    expect(parsedResponse.results[0].answers.length).toBe(2);
    expect(parsedResponse.results[0].comments.question.length).toBe(1);
  });

  test("should format response as Markdown correctly", () => {
    const server = new StackOverflowServer();

    // Call the formatResponse method with Markdown format
    const markdownResponse = (server as any).formatResponse(
      [sampleSearchResult],
      "markdown"
    );

    // Verify the Markdown structure
    expect(markdownResponse).toContain("# How to test TypeScript code?");
    expect(markdownResponse).toContain("**Score:** 25");
    expect(markdownResponse).toContain("### ✓ Answer (Score: 15)");
    expect(markdownResponse).toContain("### Answer (Score: 5)");
    expect(markdownResponse).toContain("### Question Comments");
    expect(markdownResponse).toContain("#### Answer Comments");
    expect(markdownResponse).toContain("[View on Stack Overflow]");
  });

  test("should handle empty results correctly", () => {
    const server = new StackOverflowServer();

    // Call the formatResponse method with empty results
    const jsonResponse = (server as any).formatResponse([], "json");
    const markdownResponse = (server as any).formatResponse([], "markdown");

    // Verify empty responses
    const parsedEmpty = JSON.parse(jsonResponse);
    expect(parsedEmpty).toHaveProperty('pagination');
    expect(parsedEmpty).toHaveProperty('results');
    expect(parsedEmpty.results).toEqual([]);
    expect(markdownResponse).toBe("");
  });
});
