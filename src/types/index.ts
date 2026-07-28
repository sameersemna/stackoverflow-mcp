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
});

export type SearchByErrorInput = z.infer<typeof SearchByErrorInputSchema>;

export const SearchByTagsInputSchema = z.object({
  tags: z.array(z.string().trim().min(1)).min(1, 'tags are required'),
  minScore: z.number().nonnegative().optional(),
  includeComments: z.boolean().optional(),
  responseFormat: z.enum(['json', 'markdown']).optional(),
  limit: z.number().int().positive().max(100).optional(),
});

export type SearchByTagsInput = z.infer<typeof SearchByTagsInputSchema>;

export const StackTraceInputSchema = z.object({
  stackTrace: z.string().trim().min(1, 'stackTrace is required').max(10000),
  language: z.string().trim().min(1, 'language is required'),
  includeComments: z.boolean().optional(),
  responseFormat: z.enum(['json', 'markdown']).optional(),
  limit: z.number().int().positive().max(100).optional(),
});

export type StackTraceInput = z.infer<typeof StackTraceInputSchema>;

/**
 * Stack Overflow question object
 */
export interface StackOverflowQuestion {
  question_id: number;
  title: string;
  body: string;
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
