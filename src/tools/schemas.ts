/**
 * Tool input schemas — the shapes published to MCP clients.
 *
 * Responsibility: hold the zod shapes registered as each tool's `inputSchema`.
 *
 * IMPORTANT (Phase 5): these shapes are the *published* schema. They were moved
 * here verbatim from `server.ts` so the contract snapshot stays byte-identical.
 * They are hand-written duplicates of the stricter schemas in `types/index.ts`,
 * and they advertise **no** constraints — no `max(100)` on `limit`, no `int()`,
 * no `positive()`, no `max(2000)` on `errorMessage` — so an LLM cannot see the
 * limits. Phase 5 collapses both sets into one shape used for registration *and*
 * parsing; because that adds constraints, it is an additive change to the
 * published schema and needs a CHANGELOG entry.
 */
import * as z from 'zod';

/** Input shape published for the `search_by_error` tool. */
export const searchByErrorInputSchema = {
    errorMessage: z.string().describe('Error message to search for'),
    language: z.string().optional().describe('Programming language (e.g., "javascript", "python")'),
    technologies: z.array(z.string()).optional().describe('Related technologies or frameworks'),
    minScore: z.number().optional().describe('Minimum score threshold for results'),
    includeComments: z.boolean().optional().describe('Include question and answer comments in results'),
    responseFormat: z.enum(['json', 'markdown']).optional().describe('Response format: json or markdown'),
    limit: z.number().optional().describe('Maximum number of results (1-100)'),
    page: z.number().optional().describe('Page number for pagination (default: 1)'),
};

/** Input shape published for the `search_by_tags` tool. */
export const searchByTagsInputSchema = {
    tags: z.array(z.string()).describe('Tags to search for (e.g., ["python", "pandas", "dataframe"])'),
    minScore: z.number().optional().describe('Minimum score threshold for results'),
    includeComments: z.boolean().optional().describe('Include question and answer comments in results'),
    responseFormat: z.enum(['json', 'markdown']).optional().describe('Response format: json or markdown'),
    limit: z.number().optional().describe('Maximum number of results (1-100)'),
    page: z.number().optional().describe('Page number for pagination (default: 1)'),
};

/** Input shape published for the `analyze_stack_trace` tool. */
export const analyzeStackTraceInputSchema = {
    stackTrace: z.string().describe('Full stack trace to analyze'),
    language: z.string().describe('Programming language of the stack trace'),
    includeComments: z.boolean().optional().describe('Include question and answer comments in results'),
    responseFormat: z.enum(['json', 'markdown']).optional().describe('Response format: json or markdown'),
    limit: z.number().optional().describe('Maximum number of results (1-100)'),
    page: z.number().optional().describe('Page number for pagination (default: 1)'),
};

/** Input shape published for the `search_by_query` tool. */
export const searchByQueryInputSchema = {
    query: z.string().describe('Free-text search query'),
    tags: z.array(z.string()).optional().describe('Optional tags to filter results'),
    minScore: z.number().optional().describe('Minimum score threshold for results'),
    acceptedOnly: z.boolean().optional().describe('Only return questions with accepted answers'),
    includeComments: z.boolean().optional().describe('Include question and answer comments in results'),
    responseFormat: z.enum(['json', 'markdown']).optional().describe('Response format: json or markdown'),
    limit: z.number().optional().describe('Maximum number of results (1-100)'),
    page: z.number().optional().describe('Page number for pagination (default: 1)'),
};

/** Input shape published for the `search_by_question_id` tool. */
export const searchByQuestionIdInputSchema = {
    questionId: z.number().describe('Stack Overflow question ID (e.g., 12345)'),
    includeAnswers: z.boolean().optional().describe('Include answers in the response (default: true)'),
    includeComments: z.boolean().optional().describe('Include question and answer comments'),
    responseFormat: z.enum(['json', 'markdown']).optional().describe('Response format: json or markdown'),
};

