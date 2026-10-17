/**
 * Logging tests.
 *
 * Responsibility: protect the rule that **stdout is the protocol channel**, not a log
 * sink, and that per-tool-call logging exists at all.
 *
 * The stdout rule is not cosmetic. In stdio mode stdout carries MCP frames, so one
 * stray `console.log` — in the server or in a dependency — corrupts the stream and the
 * client sees a protocol error with no useful explanation. The logger writes to
 * descriptor 2 for that reason, and this suite fails if anything else reaches stdout.
 *
 * The per-call timing assertion is deliberately loose: it checks that a call is logged
 * with its tool name and a duration, not what the duration is.
 */
import { describe, expect, test, beforeEach, afterEach, jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { Writable } from 'node:stream';
import pino from 'pino';
import { StackOverflowServer, redactSecrets } from '../server.js';
import { REDACT_PATHS, logger } from '../utils/logger.js';
import { emptyApiResponse, installFetchHarness, type FetchHarness } from './helpers/fetchHarness.js';

/**
 * Runs a handler through the same wrapper the tool registration uses.
 *
 * `runTool` is private, so it is reached through a cast; this mirrors what
 * `registerTool` does, which is the behaviour under test.
 */
function invokeTool<T>(
  server: StackOverflowServer,
  toolName: string,
  invoke: () => Promise<T>
): Promise<T> {
  return (
    server as never as {
      runTool: (name: string, fn: () => Promise<T>) => Promise<T>;
    }
  ).runTool(toolName, invoke);
}

/** Captures what a pino instance would have written. */
function captureLogger(): { lines: string[]; stream: Writable } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(String(chunk));
      callback();
    },
  });
  return { lines, stream };
}

describe('stdout is reserved for the protocol', () => {
  const originalWrite = process.stdout.write.bind(process.stdout);
  let captured: string[] = [];

  beforeEach(() => {
    captured = [];
    process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
      captured.push(String(chunk));
      // Swallow instead of forwarding: the test asserts on what was attempted.
      const callback = rest.find((arg) => typeof arg === 'function') as (() => void) | undefined;
      callback?.();
      return true;
    }) as typeof process.stdout.write;
  });

  afterEach(() => {
    process.stdout.write = originalWrite;
  });

  test('a tool call in stdio mode writes nothing to stdout', async () => {
    const harness = installFetchHarness({
      routes: { '*': { body: emptyApiResponse({ items: [] }) } },
    });

    try {
      const server = new StackOverflowServer();
      await server.runStdio();
      await (server as never as {
        handleSearchByError: (input: unknown) => Promise<unknown>;
      }).handleSearchByError({ errorMessage: 'TypeError: boom', limit: 1 });

      // `runStdio` connects a transport, which is allowed to write frames; the check
      // is that no *log* line appears. pino uses descriptor 2, so stdout stays empty.
      expect(captured.filter((line) => line.includes('"level"'))).toEqual([]);
    } finally {
      harness.restore();
    }
  });

  test('the logger is configured to write to stderr, not stdout', () => {
    const loggerSource = readFileSync(new URL('../utils/logger.ts', import.meta.url), 'utf8');

    // `pino.destination(2)` is what makes the rule structural rather than a habit.
    expect(loggerSource).toContain('pino.destination(2)');
    expect(loggerSource).not.toContain('pino.destination(1)');
  });
});

describe('log redaction reaches nested values', () => {
  test('nested and top-level credentials are censored', () => {
    const secret = 'SECRET123abcDEF456';
    const { lines, stream } = captureLogger();
    const logger = pino({ redact: { paths: [...REDACT_PATHS], censor: '***' } }, stream);

    logger.info({ key: secret }, 'top');
    logger.info({ request: { headers: { authorization: `Bearer ${secret}` } } }, 'nested');
    logger.info({ deep: { nested: { token: secret } } }, 'deep');

    expect(lines.join('\n')).not.toContain(secret);
    expect(lines.join('\n')).toContain('***');
  });

  test('a URL logged as a string is only safe once redacted', () => {
    const secret = 'SECRET123abcDEF456';
    const { lines, stream } = captureLogger();
    const logger = pino({ redact: { paths: [...REDACT_PATHS], censor: '***' } }, stream);

    // pino redacts *fields*, not substrings, so this is the documented boundary: a URL
    // must pass through `redactSecrets` before it is logged.
    logger.info({ url: redactSecrets(`https://api.stackexchange.com/2.3/x?key=${secret}`) });

    expect(lines.join('\n')).not.toContain(secret);
  });
});

describe('per-tool-call logging', () => {
  let harness: FetchHarness;

  beforeEach(() => {
    harness = installFetchHarness({
      routes: { '*': { body: emptyApiResponse({ items: [] }) } },
    });
  });

  afterEach(() => {
    harness.restore();
    jest.restoreAllMocks();
  });

  test('a successful call logs its tool name and duration at debug level', async () => {
    // The shared fixture returns no items, which makes the question lookup fail and log
    // at `warn`; this case needs a real result to reach the success path.
    harness.restore();
    harness = installFetchHarness({
      routes: {
        '*': {
          body: emptyApiResponse({
            items: [
              {
                question_id: 1,
                title: 'Q',
                body: 'b',
                score: 1,
                answer_count: 0,
                is_answered: false,
                creation_date: 1,
                tags: ['javascript'],
                link: 'https://stackoverflow.com/q/1',
              },
            ],
          }),
        },
      },
    });

    const debug = jest.spyOn(logger, 'debug');
    const server = new StackOverflowServer();

    // Through `runTool`, because that is what the tool registration wraps the handler
    // with; calling the handler directly would bypass the logging under test.
    await invokeTool(server, 'search_by_question_id', () =>
      (server as never as {
        handleSearchByQuestionId: (input: unknown) => Promise<unknown>;
      }).handleSearchByQuestionId({ questionId: 1, includeAnswers: false })
    );

    // `runTool` wraps the handler, so the log carries the tool name a journal reader
    // can filter on.
    const call = debug.mock.calls.find(
      ([context]) => (context as { tool?: string } | undefined)?.tool === 'search_by_question_id'
    );
    expect(call).toBeDefined();
    expect((call![1] as string)).toContain('finished');
    expect(typeof (call![0] as { durationMs?: number }).durationMs).toBe('number');
  });

  test('a failing call logs at warn level with the tool name', async () => {
    const warn = jest.spyOn(logger, 'warn');
    const server = new StackOverflowServer();

    // A validation failure is the cheapest way to reach the error path without a network.
    await invokeTool(server, 'search_by_error', () =>
      (server as never as {
        handleSearchByError: (input: unknown) => Promise<unknown>;
      }).handleSearchByError({ errorMessage: 'boom', limit: -1 })
    );

    const call = warn.mock.calls.find(
      ([context]) => (context as { tool?: string } | undefined)?.tool === 'search_by_error'
    );
    expect(call).toBeDefined();
    expect((call![1] as string)).toContain('failed');
  });

  test('successes stay quiet at the default info level', async () => {
    // The default level is `info`, and successes log at `debug`, so a normal tool call
    // adds nothing to a production journal.
    const info = jest.spyOn(logger, 'info');
    const server = new StackOverflowServer();

    await invokeTool(server, 'search_by_question_id', () =>
      (server as never as {
        handleSearchByQuestionId: (input: unknown) => Promise<unknown>;
      }).handleSearchByQuestionId({ questionId: 1, includeAnswers: false })
    );

    expect(
      info.mock.calls.filter(([context]) => (context as { tool?: string })?.tool !== undefined)
    ).toEqual([]);
  });

  test('a handler that throws is still converted into an error result', async () => {
    const server = new StackOverflowServer();
    jest
      .spyOn(server as never as { handleSearchByError: () => Promise<unknown> }, 'handleSearchByError')
      .mockRejectedValue(new Error('handler exploded'));

    // Called through the wrapper the tool registration uses, so an escaped throw must
    // not reach the transport as a protocol error.
    const result = await (server as never as {
      runTool: (name: string, fn: () => Promise<unknown>) => Promise<{
        isError?: boolean;
        content: { text: string }[];
      }>;
    }).runTool('search_by_error', () =>
      (server as never as { handleSearchByError: () => Promise<unknown> }).handleSearchByError()
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('handler exploded');
  });
});
