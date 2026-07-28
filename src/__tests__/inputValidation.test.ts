import { describe, expect, jest, test } from '@jest/globals';
import { StackOverflowServer } from '../index.js';

describe('Tool input validation', () => {
  test('rejects invalid search_by_error inputs before calling the API', async () => {
    const server = new StackOverflowServer();
    const searchSpy = jest.spyOn(server as any, 'searchStackOverflow').mockResolvedValue([]);

    const result = await (server as any).handleSearchByError({
      errorMessage: 'TypeError: boom',
      limit: -1,
      responseFormat: 'yaml',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Validation failed');
    expect(searchSpy).not.toHaveBeenCalled();
  });
});
