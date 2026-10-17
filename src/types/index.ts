import { z } from 'zod';

/**
 * Type definitions for Stack Overflow MCP Server
 */

export const SearchByErrorInputSchema = z.object({
  errorMessage: z.string().trim().min(1, 'errorMessage is required').max(2000),
  language: z.string().trim().min(1).optional(),
  technologies: z.array(z.string().trim().min(1)).optional(),
  minScore: z.number().nonnegative().optional(),
  includeComments: z.boolean().optional(),
  responseFormat: z.enum(['json', 'markdown']).optional(),
  limit: z.number().int().positive().max(100).optional(),
  page: z.number().int().positive().optional(),
});

export type SearchByErrorInput = z.infer<typeof SearchByErrorInputSchema>;

export const SearchByTagsInputSchema = z.object({
  tags: z.array(z.string().trim().min(1)).min(1, 'tags are required'),
  minScore: z.number().nonnegative().optional(),
  includeComments: z.boolean().optional(),
  responseFormat: z.enum(['json', 'markdown']).optional(),
  limit: z.number().int().positive().max(100).optional(),
  page: z.number().int().positive().optional(),
});

export type SearchByTagsInput = z.infer<typeof SearchByTagsInputSchema>;

export const StackTraceInputSchema = z.object({
  stackTrace: z.string().trim().min(1, 'stackTrace is required').max(10000),
  language: z.string().trim().min(1, 'language is required'),
  includeComments: z.boolean().optional(),
  responseFormat: z.enum(['json', 'markdown']).optional(),
  limit: z.number().int().positive().max(100).optional(),
  page: z.number().int().positive().optional(),
});

export type StackTraceInput = z.infer<typeof StackTraceInputSchema>;

export const SearchByQueryInputSchema = z.object({
  query: z.string().trim().min(1, 'query is required').max(2000),
  tags: z.array(z.string().trim().min(1)).optional(),
  minScore: z.number().nonnegative().optional(),
  acceptedOnly: z.boolean().optional(),
  includeComments: z.boolean().optional(),
  responseFormat: z.enum(['json', 'markdown']).optional(),
  limit: z.number().int().positive().max(100).optional(),
  page: z.number().int().positive().optional(),
});

export type SearchByQueryInput = z.infer<typeof SearchByQueryInputSchema>;

export const SearchByQuestionIdInputSchema = z.object({
  questionId: z.number().int().positive('questionId must be a positive integer'),
  includeAnswers: z.boolean().optional(),
  includeComments: z.boolean().optional(),
  responseFormat: z.enum(['json', 'markdown']).optional(),
});

export type SearchByQuestionIdInput = z.infer<typeof SearchByQuestionIdInputSchema>;

/**
 * Pagination metadata for search results
 */
export interface PaginationMeta {
  page: number;
  pageSize: number;
  /**
   * Total number of matched results, **only when the API reported one**.
   *
   * Stack Exchange returns `total` only for certain response shapes, so this is
   * omitted rather than set to the page size — presenting `pageSize` as a total
   * led clients to believe a page was the entire result set.
   */
  totalCount?: number;
  hasMore: boolean;
}

/**
 * Stack Overflow question object
 */
export interface StackOverflowQuestion {
  question_id: number;
  title: string;
  body: string;
  /**
   * Answers returned inline by the custom filter.
   *
   * The question type documentation says a question "can optionally return
   * comments and answers accordingly"; requesting those fields is what lets one
   * search request replace the separate answers/comments calls. Absent when the
   * built-in filters are in use, which is why the client still has a fallback.
   */
  answers?: StackOverflowAnswer[];
  /** Comments returned inline by the custom filter (see {@link answers}). */
  comments?: StackOverflowComment[];
  score: number;
  answer_count: number;
  is_answered: boolean;
  accepted_answer_id?: number;
  creation_date: number;
  tags: string[];
  link: string;
}

/**
 * Stack Overflow answer object
 */
export interface StackOverflowAnswer {
  answer_id: number;
  question_id: number;
  score: number;
  is_accepted: boolean;
  body: string;
  /** Comments returned inline by the custom filter (see StackOverflowQuestion.answers). */
  comments?: StackOverflowComment[];
  creation_date: number;
  link: string;
}

/**
 * Stack Overflow comment object
 */
export interface StackOverflowComment {
  comment_id: number;
  post_id: number;
  score: number;
  body: string;
  creation_date: number;
}

/**
 * Comments structure for search results
 */
export interface SearchResultComments {
  question: StackOverflowComment[];
  answers: { [answerId: number]: StackOverflowComment[] };
}

/**
 * Complete search result including question, answers, and optional comments
 */
export interface SearchResult {
  question: StackOverflowQuestion;
  answers: StackOverflowAnswer[];
  comments?: SearchResultComments;
}

/**
 * Search results together with pagination state derived from the API response.
 */
export interface PagedSearchResults {
  results: SearchResult[];
  page: number;
  hasMore: boolean;
  /**
   * Human-readable notes about how the search was adjusted to produce results
   * (e.g. a tag filter that was relaxed because it matched nothing).
   */
  notes?: string[];
  /**
   * The query that actually produced these results. It equals the requested
   * query unless a fallback variant matched instead, in which case the client
   * can use it to request further pages of the same variant.
   */
  effectiveQuery?: string;
  /**
   * The tags that actually produced these results. `undefined` means the tag
   * filter was relaxed because it matched nothing.
   */
  effectiveTags?: string[];
  /** True when a fallback (shorter query and/or relaxed tags) produced the results. */
  usedFallback?: boolean;
}

/**
 * Stack Exchange API error response
 */
export interface ApiErrorResponse {
  error_id: number;
  error_name: string;
  error_message: string;
}

/**
 * Stack Exchange API response wrapper
 *
 * @template T - The type of items in the response (e.g., StackOverflowQuestion)
 */
export interface ApiResponse<T> {
  items: T[];
  has_more: boolean;
  quota_max: number;
  quota_remaining: number;
  /** Seconds to wait before next request to this method (if present) */
  backoff?: number;
}
