/**
 * Fixture-based tests for `streamChat`'s SSE accumulator.
 *
 * Highest-leverage missing test in the repo: the Phase 4.5 streaming
 * tool-call accumulator and the existing content+reasoning streaming
 * paths are exercised here against synthetic SSE byte sequences. Each
 * test feeds a sequence of `data: {...}\n` lines through a controllable
 * stream-reader and asserts the resolved `ChatResponse`.
 *
 * What we cover:
 *   - content-only stream → resolved.content matches concatenation
 *   - reasoning-only stream (R1 / V4-thinking) → fullReasoning + chunks
 *   - tool-call streaming: single call split across N deltas
 *   - tool-call streaming: parallel tool calls interleaved by index
 *   - tool-call streaming: empty arguments {} → final argumentsStr is "{}"
 *   - finish_reason is exposed on ChatResponse
 *   - usage info captured from the tail chunk
 *   - malformed JSON in a `data:` line is ignored, stream continues
 *   - [DONE] sentinel resolves before stream.on('end') fires
 *
 * What we do NOT cover here:
 *   - HTTP error paths (handled by separate `chat()` non-streaming tests).
 *   - Inactivity timeout (real-time test would slow the suite).
 *   - The orchestrator's reaction to tool_calls (covered by integration
 *     tests once they're written).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mock state ──────────────────────────────────────────────

const { mockHttpClient, mockSecrets, mockConfigValues, mockReader } = vi.hoisted(() => {
  type Handler<T> = (arg: T) => void;
  const handlers: {
    data: Handler<Buffer>[];
    error: Handler<Error>[];
    end: Handler<void>[];
  } = { data: [], error: [], end: [] };

  return {
    mockHttpClient: {
      post: vi.fn(async () => ({ data: {} as any })),
      get: vi.fn()
    },
    mockSecrets: {
      get: vi.fn(async () => 'test-api-key'),
      store: vi.fn(),
      delete: vi.fn(),
      onDidChange: vi.fn()
    },
    mockConfigValues: new Map<string, any>([
      ['model', 'deepseek-v4-flash-thinking'],
      ['temperature', 0.7]
    ]),
    mockReader: {
      handlers,
      // Test helpers:
      pushData: (text: string) => handlers.data.forEach(h => h(Buffer.from(text))),
      pushError: (err: Error) => handlers.error.forEach(h => h(err)),
      pushEnd: () => handlers.end.forEach(h => h()),
      reset: () => {
        handlers.data.length = 0;
        handlers.error.length = 0;
        handlers.end.length = 0;
      }
    }
  };
});

// ── Module mocks ────────────────────────────────────────────────────

vi.mock('../../src/utils/httpClient', () => ({
  HttpClient: vi.fn(() => mockHttpClient),
  HttpError: class HttpError extends Error {
    response?: { status: number; statusText: string; data: unknown };
    code?: string;
  },
  createStreamReader: vi.fn(() => ({
    on(event: 'data' | 'error' | 'end', handler: any) {
      mockReader.handlers[event].push(handler);
    }
  }))
}));

vi.mock('../../src/utils/config', () => ({
  ConfigManager: {
    getInstance: vi.fn(() => ({
      get: vi.fn((key: string) => mockConfigValues.get(key))
    }))
  }
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    apiRequest: vi.fn(() => ''),
    apiResponse: vi.fn(),
    apiAborted: vi.fn(),
    apiError: vi.fn(),
    apiStreamProgress: vi.fn(),
    apiStreamChunk: vi.fn(),
    setIteration: vi.fn(),
    getCurrentApiCorrelationId: vi.fn(() => 'corr-1'),
    getCurrentIteration: vi.fn(() => 1),
    show: vi.fn()
  }
}));

vi.mock('../../src/tracing', () => ({
  tracer: {
    event: vi.fn(),
    startSpan: vi.fn(() => 'span-1'),
    endSpan: vi.fn(),
    trace: vi.fn(),
    setLogOutput: vi.fn()
  }
}));

import { DeepSeekClient } from '../../src/deepseekClient';
import type { Message } from '../../src/deepseekClient';

// ── Helpers ─────────────────────────────────────────────────────────

function createContext() {
  return {
    secrets: mockSecrets,
    subscriptions: [],
    extensionPath: '/test'
  } as any;
}

/** Format a JS object as a single SSE `data:` line + newline. */
function sse(obj: any): string {
  return `data: ${JSON.stringify(obj)}\n`;
}

/** Emit one SSE delta wrapped in a single OpenAI-style chunk. */
function delta(delta: any, opts: { finish_reason?: string; usage?: any } = {}): string {
  const chunk: any = {
    choices: [{ delta, ...(opts.finish_reason && { finish_reason: opts.finish_reason }) }]
  };
  if (opts.usage) chunk.usage = opts.usage;
  return sse(chunk);
}

/** Drive a streamChat call to completion by feeding chunks then [DONE]. */
async function runStream(
  client: DeepSeekClient,
  messages: Message[],
  chunks: string[],
  callbacks: { onToken?: (t: string) => void; onReasoning?: (t: string) => void } = {}
): Promise<any> {
  mockReader.reset();

  // Kick off the streamChat call. Because mockReader.handlers are not
  // attached until after `await getHttpClient().post()` resolves, we
  // need to wait one microtask before pushing chunks. The simplest way
  // is to start the call, then microtask-await, then push.
  const promise = client.streamChat(
    messages,
    callbacks.onToken ?? (() => {}),
    undefined,
    callbacks.onReasoning,
    {}
  );

  // Yield microtasks until handlers are attached. The streamChat
  // implementation awaits `post()` then synchronously attaches
  // listeners — so two microtask flushes is enough.
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));

  for (const c of chunks) {
    mockReader.pushData(c);
  }
  mockReader.pushData('data: [DONE]\n');

  return promise;
}

// ── Tests ───────────────────────────────────────────────────────────

describe('DeepSeekClient.streamChat — SSE accumulator', () => {
  let client: DeepSeekClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mockReader.reset();
    mockHttpClient.post.mockResolvedValue({ data: {} });
    mockSecrets.get.mockResolvedValue('test-api-key');
    client = new DeepSeekClient(createContext());
  });

  describe('content-only streams', () => {
    it('concatenates content deltas in order', async () => {
      const tokens: string[] = [];
      const result = await runStream(
        client,
        [{ role: 'user', content: 'hi' }],
        [
          delta({ content: 'Hello' }),
          delta({ content: ', ' }),
          delta({ content: 'world!' }),
          delta({}, { finish_reason: 'stop', usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } })
        ],
        { onToken: (t) => tokens.push(t) }
      );

      expect(result.content).toBe('Hello, world!');
      expect(tokens).toEqual(['Hello', ', ', 'world!']);
      expect(result.finish_reason).toBe('stop');
      expect(result.tool_calls).toBeUndefined();
      expect(result.usage?.prompt_tokens).toBe(10);
    });

    it('skips empty delta objects without firing onToken', async () => {
      const tokens: string[] = [];
      const result = await runStream(
        client,
        [{ role: 'user', content: 'hi' }],
        [
          delta({}),
          delta({ content: 'A' }),
          delta({}),
          delta({ content: 'B' }),
          delta({}, { finish_reason: 'stop' })
        ],
        { onToken: (t) => tokens.push(t) }
      );

      expect(result.content).toBe('AB');
      expect(tokens).toEqual(['A', 'B']);
    });
  });

  describe('reasoning streams', () => {
    it('captures reasoning_content separate from content; fires onReasoning', async () => {
      const reasoningChunks: string[] = [];
      const contentChunks: string[] = [];
      const result = await runStream(
        client,
        [{ role: 'user', content: 'hi' }],
        [
          delta({ reasoning_content: 'Let me think...' }),
          delta({ reasoning_content: ' about this.' }),
          delta({ content: 'The answer is 42.' }),
          delta({}, { finish_reason: 'stop' })
        ],
        {
          onToken: (t) => contentChunks.push(t),
          onReasoning: (t) => reasoningChunks.push(t)
        }
      );

      expect(result.reasoning_content).toBe('Let me think... about this.');
      expect(result.content).toBe('The answer is 42.');
      expect(reasoningChunks).toEqual(['Let me think...', ' about this.']);
      expect(contentChunks).toEqual(['The answer is 42.']);
    });

    it('reasoning + content + tool_calls coexist in the same stream', async () => {
      const result = await runStream(
        client,
        [{ role: 'user', content: 'hi' }],
        [
          delta({ reasoning_content: 'I should call edit_file.' }),
          delta({ content: 'Editing now.' }),
          delta({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'edit_file', arguments: '' }}]}),
          delta({ tool_calls: [{ index: 0, function: { arguments: '{"file":"a.ts"}' }}]}),
          delta({}, { finish_reason: 'tool_calls' })
        ]
      );

      expect(result.reasoning_content).toBe('I should call edit_file.');
      expect(result.content).toBe('Editing now.');
      expect(result.tool_calls).toHaveLength(1);
      expect(result.tool_calls?.[0].function.name).toBe('edit_file');
      expect(result.tool_calls?.[0].function.arguments).toBe('{"file":"a.ts"}');
      expect(result.finish_reason).toBe('tool_calls');
    });
  });

  describe('tool-call accumulation (Phase 4.5)', () => {
    it('assembles a single tool call split across N deltas', async () => {
      const result = await runStream(
        client,
        [{ role: 'user', content: 'edit my file' }],
        [
          // First delta — id, type, name, opening of arguments.
          delta({ tool_calls: [{
            index: 0,
            id: 'call_abc',
            type: 'function',
            function: { name: 'write_file', arguments: '{"path":' }
          }]}),
          // Subsequent deltas — only argument extensions.
          delta({ tool_calls: [{ index: 0, function: { arguments: '"src/foo' } }]}),
          delta({ tool_calls: [{ index: 0, function: { arguments: '.ts","content":"' } }]}),
          delta({ tool_calls: [{ index: 0, function: { arguments: 'export {};"}' } }]}),
          delta({}, { finish_reason: 'tool_calls' })
        ]
      );

      expect(result.tool_calls).toHaveLength(1);
      const tc = result.tool_calls![0];
      expect(tc.id).toBe('call_abc');
      expect(tc.type).toBe('function');
      expect(tc.function.name).toBe('write_file');
      expect(tc.function.arguments).toBe('{"path":"src/foo.ts","content":"export {};"}');
      // Round-trip must produce valid JSON.
      expect(() => JSON.parse(tc.function.arguments)).not.toThrow();
    });

    it('assembles two parallel tool calls with interleaved deltas (different indices)', async () => {
      const result = await runStream(
        client,
        [{ role: 'user', content: 'do two things' }],
        [
          // Index 0 metadata.
          delta({ tool_calls: [{ index: 0, id: 'call_0', type: 'function', function: { name: 'read_file', arguments: '' }}]}),
          // Index 1 metadata arrives BEFORE index 0's args complete — the
          // accumulator must tolerate any arrival order.
          delta({ tool_calls: [{ index: 1, id: 'call_1', type: 'function', function: { name: 'grep', arguments: '' }}]}),
          // Index 0 args.
          delta({ tool_calls: [{ index: 0, function: { arguments: '{"path":"a.ts"}' }}]}),
          // Index 1 args.
          delta({ tool_calls: [{ index: 1, function: { arguments: '{"query":"foo"}' }}]}),
          delta({}, { finish_reason: 'tool_calls' })
        ]
      );

      expect(result.tool_calls).toHaveLength(2);
      const [c0, c1] = result.tool_calls!;
      expect(c0.id).toBe('call_0');
      expect(c0.function.name).toBe('read_file');
      expect(c0.function.arguments).toBe('{"path":"a.ts"}');
      expect(c1.id).toBe('call_1');
      expect(c1.function.name).toBe('grep');
      expect(c1.function.arguments).toBe('{"query":"foo"}');
    });

    it('handles tool call with empty arguments {}', async () => {
      const result = await runStream(
        client,
        [{ role: 'user', content: 'list dir' }],
        [
          delta({ tool_calls: [{ index: 0, id: 'call_x', type: 'function', function: { name: 'list_directory', arguments: '' }}]}),
          delta({ tool_calls: [{ index: 0, function: { arguments: '{}' } }]}),
          delta({}, { finish_reason: 'tool_calls' })
        ]
      );

      expect(result.tool_calls).toHaveLength(1);
      expect(result.tool_calls![0].function.arguments).toBe('{}');
      expect(JSON.parse(result.tool_calls![0].function.arguments)).toEqual({});
    });

    it('tolerates a tool_calls delta with no `index` field (defaults to 0)', async () => {
      // Some providers omit `index` when there's only one tool call. The
      // accumulator falls back to 0.
      const result = await runStream(
        client,
        [{ role: 'user', content: 'hi' }],
        [
          delta({ tool_calls: [{ id: 'c0', type: 'function', function: { name: 'read_file', arguments: '' }}]}),
          delta({ tool_calls: [{ function: { arguments: '{"path":"x"}' }}]}),
          delta({}, { finish_reason: 'tool_calls' })
        ]
      );

      expect(result.tool_calls).toHaveLength(1);
      expect(result.tool_calls![0].id).toBe('c0');
      expect(result.tool_calls![0].function.arguments).toBe('{"path":"x"}');
    });

    it('finish_reason: "stop" produces no tool_calls field', async () => {
      const result = await runStream(
        client,
        [{ role: 'user', content: 'hi' }],
        [
          delta({ content: 'just a plain answer' }),
          delta({}, { finish_reason: 'stop' })
        ]
      );

      expect(result.tool_calls).toBeUndefined();
      expect(result.finish_reason).toBe('stop');
    });
  });

  describe('robustness', () => {
    it('ignores malformed JSON in a data: line and continues', async () => {
      const result = await runStream(
        client,
        [{ role: 'user', content: 'hi' }],
        [
          delta({ content: 'A' }),
          'data: {this is not valid JSON\n',
          delta({ content: 'B' }),
          delta({}, { finish_reason: 'stop' })
        ]
      );

      expect(result.content).toBe('AB');
    });

    it('captures usage from the final chunk', async () => {
      const result = await runStream(
        client,
        [{ role: 'user', content: 'hi' }],
        [
          delta({ content: 'ok' }),
          delta(
            {},
            {
              finish_reason: 'stop',
              usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105, prompt_cache_hit_tokens: 50 }
            }
          )
        ]
      );

      expect(result.usage?.prompt_tokens).toBe(100);
      expect(result.usage?.completion_tokens).toBe(5);
      expect(result.usage?.prompt_cache_hit_tokens).toBe(50);
    });

    it('resolves on [DONE] without a separate stream.on(end)', async () => {
      // [DONE] in the data chunks should be enough to resolve. Test
      // verifies `runStream` (which appends [DONE] at the end) settles
      // without needing pushEnd().
      const result = await runStream(
        client,
        [{ role: 'user', content: 'hi' }],
        [delta({ content: 'ok' })]
      );

      expect(result.content).toBe('ok');
    });
  });
});
