/**
 * Type definitions for Stack Overflow MCP Server
 */

/**
 * Input parameters for search_by_error tool
 */
export interface SearchByErrorInput {
  errorMessage: string;
  language?: string;
  technologies?: string[];
  minScore?: number;
  includeComments?: boolean;
  responseFormat?: 'json' | 'markdown';
  limit?: number;
}

/**
 * Input parameters for search_by_tags tool
 */
export interface SearchByTagsInput {
  tags: string[];
  minScore?: number;
  includeComments?: boolean;
  responseFormat?: 'json' | 'markdown';
  limit?: number;
}

/**
 * Input parameters for analyze_stack_trace tool
 */
export interface StackTraceInput {
  stackTrace: string;
  language: string;
  includeComments?: boolean;
  responseFormat?: 'json' | 'markdown';
  limit?: number;
}

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
