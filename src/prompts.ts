/**
 * MCP prompt registration.
 *
 * Responsibility: expose the reusable prompt templates that guide a model through
 * common Stack Overflow workflows. Prompts are pure text builders, so this module
 * takes only the MCP server.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import * as z from "zod"

/**
 * Registers both prompts on the given MCP server.
 *
 * @param server - The MCP server to register on.
 */
export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "stackoverflow_search",
    {
      title: "Search Stack Overflow",
      description:
        "Template for searching Stack Overflow with a query and optional language filter",
      argsSchema: {
        query: z.string().describe("What to search for on Stack Overflow"),
        language: z
          .string()
          .optional()
          .describe("Programming language to filter by (e.g., javascript, python, rust)"),
      },
    },
    ({ query, language }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: language
              ? `Search Stack Overflow for "${query}" in ${language}. Find the most helpful questions and answers.`
              : `Search Stack Overflow for "${query}". Find the most helpful questions and answers.`,
          },
        },
      ],
    })
  )

  server.registerPrompt(
    "stackoverflow_debug",
    {
      title: "Debug with Stack Overflow",
      description:
        "Template for debugging an error by searching Stack Overflow with the error message and language",
      argsSchema: {
        errorMessage: z.string().describe("The error message or stack trace to search for"),
        language: z
          .string()
          .describe("Programming language of the code (e.g., javascript, python, java)"),
      },
    },
    ({ errorMessage, language }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `I'm encountering this error in ${language}:\n\n\`\`\`\n${errorMessage}\n\`\`\`\n\nSearch Stack Overflow for solutions. Use the analyze_stack_trace tool with this error and language="${language}".`,
          },
        },
      ],
    })
  )

  server.registerPrompt(
    "stackoverflow_explain_answer",
    {
      title: "Explain a Stack Overflow Answer",
      description:
        "Template for having a specific answer explained in the context of the question it answers",
      argsSchema: {
        questionId: z.string().describe("Stack Overflow question id the answer belongs to"),
        answerId: z
          .string()
          .optional()
          .describe("Answer id to focus on; omitted means the accepted answer"),
        context: z
          .string()
          .optional()
          .describe("What the caller is trying to achieve, to tailor the explanation"),
      },
    },
    ({ questionId, answerId, context }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Fetch Stack Overflow question ${questionId} with search_by_question_id` +
              (answerId
                ? `, then explain answer ${answerId}`
                : ", then explain its accepted answer") +
              ". Walk through why the answer works, name the APIs or language features it relies on, " +
              "and say when it does not apply." +
              (context ? ` The caller is trying to: ${context}.` : ""),
          },
        },
      ],
    })
  )
}
