/**
 * Non-streaming DeepSeekClient tests.
 *
 * Covers the boring-but-load-bearing surface that, until now, only got
 * exercised end-to-end:
 *
 *   - `chat()` request-body shaping: serializeMessagesForRequest +
 *     applyThinkingMode side effects (reasoning_content echo, suffix
 *     stripping, reasoning_effort injection, sampling-param drop).
 *   - `chat()` tool-shape gating: tools dropped on `toolCalling: 'none'`.
 *   - `getApiKey()` precedence: per-model secret > registry > global > env.
 *   - `handleError()` HTTP status mapping (401 / 429 / 500 / generic).
 *   - `estimateTokens()` returns a positive number for non-empty input.
 *
 * Each test mocks the HttpClient post call with a minimal fake response,
 * then asserts on the captured request body. Streaming behavior lives in
 * `deepseekClient.streamChat.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mock state ──────────────────────────────────────────────

const { mockHttpClient, mockSecrets, mockConfigValues, mockEnv } = vi.hoisted(() => ({
  mockHttpClient: {
    post: vi.fn(),
    get: vi.fn()
  },
  mockSecrets: {
    get: vi.fn(),
    store: vi.fn(),
    delete: vi.fn(),
    onDidChange: vi.fn()
  },
  mockConfigValues: new Map<string, any>(),
  mockEnv: { DEEPSEEK_API_KEY: undefined as string | undefined }
}));

// ── Module mocks ────────────────────────────────────────────────────

vi.mock('../../src/utils/httpClient', () => {
  class HttpError extends Error {
    response?: { status: number; statusText: string; data: unknown };
    code?: string;
  }
  return {
    HttpClient: vi.fn(() => mockHttpClient),
    HttpError,
    createStreamReader: vi.fn(() => ({ on: () => {} }))
  };
});

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

/** Stub a non-streaming chat() response so the call resolves cleanly. */
function stubChatResponse(content = 'ok') {
  mockHttpClient.post.mockResolvedValue({
    data: {
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    }
  });
}

/** Pull the request body from the most recent post() call. */
function lastRequestBody(): any {
  const call = mockHttpClient.post.mock.calls.at(-1);
  return call?.[1];
}

beforeEach(() => {
  vi.clearAllMocks();
  mockConfigValues.clear();
  mockConfigValues.set('temperature', 0.7);
  mockSecrets.get.mockResolvedValue(undefined);
  mockEnv.DEEPSEEK_API_KEY = undefined;
  delete process.env.DEEPSEEK_API_KEY;
});

// ── Tests ───────────────────────────────────────────────────────────

describe('DeepSeekClient — non-streaming', () => {
  describe('serializeMessagesForRequest (via chat())', () => {
    it('echoes reasoning_content for V4-thinking assistant messages — even when empty', async () => {
      mockConfigValues.set('model', 'deepseek-v4-flash-thinking');
      mockSecrets.get.mockResolvedValue('test-key');
      stubChatResponse();
      const client = new DeepSeekClient(createContext());

      const messages: Message[] = [
        { role: 'user', content: 'do thing' },
        { role: 'assistant', content: 'sure', reasoning_content: 'thinking out loud' },
        { role: 'user', content: 'and again' },
        // Crucially: this assistant turn had NO reasoning. The serializer
        // must still attach reasoning_content: '' or the next request 400s.
        { role: 'assistant', content: 'ok' }
      ];

      await client.chat(messages);
      const body = lastRequestBody();
      const userMsg = body.messages.find((m: any) => m.role === 'user' && m.content === 'do thing');
      const assistantWithReasoning = body.messages.find((m: any) => m.role === 'assistant' && m.content === 'sure');
      const assistantNoReasoning = body.messages.find((m: any) => m.role === 'assistant' && m.content === 'ok');

      // User messages MUST NOT carry reasoning_content.
      expect(userMsg).toBeDefined();
      expect(userMsg).not.toHaveProperty('reasoning_content');
      // Assistant with reasoning passes it through.
      expect(assistantWithReasoning.reasoning_content).toBe('thinking out loud');
      // Assistant without reasoning gets the empty-string placeholder.
      expect(assistantNoReasoning.reasoning_content).toBe('');
    });

    it('drops reasoning_content for non-thinking models (privacy + forward compat)', async () => {
      mockConfigValues.set('model', 'deepseek-chat');
      mockSecrets.get.mockResolvedValue('test-key');
      stubChatResponse();
      const client = new DeepSeekClient(createContext());

      const messages: Message[] = [
        { role: 'assistant', content: 'sure', reasoning_content: 'should be dropped' }
      ];

      await client.chat(messages);
      const body = lastRequestBody();
      const assistantMsg = body.messages.find((m: any) => m.role === 'assistant');
      expect(assistantMsg).not.toHaveProperty('reasoning_content');
    });

    it('preserves tool_calls and tool_call_id when present', async () => {
      mockConfigValues.set('model', 'deepseek-chat');
      mockSecrets.get.mockResolvedValue('test-key');
      stubChatResponse();
      const client = new DeepSeekClient(createContext());

      const messages: Message[] = [
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'edit_file', arguments: '{}' } }]
        },
        { role: 'tool', content: 'ok', tool_call_id: 'call_1' }
      ];

      await client.chat(messages);
      const body = lastRequestBody();
      expect(body.messages[0].tool_calls).toEqual(messages[0].tool_calls);
      expect(body.messages[1].tool_call_id).toBe('call_1');
    });

    it('unshifts the system prompt onto the message array', async () => {
      mockConfigValues.set('model', 'deepseek-chat');
      mockSecrets.get.mockResolvedValue('test-key');
      stubChatResponse();
      const client = new DeepSeekClient(createContext());

      await client.chat([{ role: 'user', content: 'hi' }], 'YOU ARE A BOT');
      const body = lastRequestBody();
      expect(body.messages[0]).toEqual({ role: 'system', content: 'YOU ARE A BOT' });
      expect(body.messages[1].role).toBe('user');
    });
  });

  describe('applyThinkingMode (via chat())', () => {
    it('strips the -thinking suffix from the wire model id', async () => {
      mockConfigValues.set('model', 'deepseek-v4-flash-thinking');
      mockSecrets.get.mockResolvedValue('test-key');
      stubChatResponse();
      const client = new DeepSeekClient(createContext());

      await client.chat([{ role: 'user', content: 'hi' }]);
      const body = lastRequestBody();
      expect(body.model).toBe('deepseek-v4-flash');
    });

    it('injects thinking + reasoning_effort fields on V4-thinking', async () => {
      mockConfigValues.set('model', 'deepseek-v4-flash-thinking');
      mockSecrets.get.mockResolvedValue('test-key');
      stubChatResponse();
      const client = new DeepSeekClient(createContext());

      await client.chat([{ role: 'user', content: 'hi' }]);
      const body = lastRequestBody();
      expect(body.thinking).toEqual({ type: 'enabled' });
      expect(body.reasoning_effort).toBe('high'); // registry default for flash-thinking
    });

    it('honors per-model reasoning_effort override from moby.modelOptions', async () => {
      mockConfigValues.set('model', 'deepseek-v4-flash-thinking');
      mockConfigValues.set('modelOptions', {
        'deepseek-v4-flash-thinking': { reasoningEffort: 'max' }
      });
      mockSecrets.get.mockResolvedValue('test-key');
      stubChatResponse();
      const client = new DeepSeekClient(createContext());

      await client.chat([{ role: 'user', content: 'hi' }]);
      expect(lastRequestBody().reasoning_effort).toBe('max');
    });

    it('uses pro registry default of "max" when no override set', async () => {
      mockConfigValues.set('model', 'deepseek-v4-pro-thinking');
      mockSecrets.get.mockResolvedValue('test-key');
      stubChatResponse();
      const client = new DeepSeekClient(createContext());

      await client.chat([{ role: 'user', content: 'hi' }]);
      expect(lastRequestBody().reasoning_effort).toBe('max');
    });

    it('strips temperature/top_p/penalties on V4-thinking (API rejects them)', async () => {
      mockConfigValues.set('model', 'deepseek-v4-flash-thinking');
      mockConfigValues.set('temperature', 0.5);
      mockSecrets.get.mockResolvedValue('test-key');
      stubChatResponse();
      const client = new DeepSeekClient(createContext());

      await client.chat([{ role: 'user', content: 'hi' }], undefined, { temperature: 0.9 });
      const body = lastRequestBody();
      expect(body).not.toHaveProperty('temperature');
      expect(body).not.toHaveProperty('top_p');
      expect(body).not.toHaveProperty('presence_penalty');
      expect(body).not.toHaveProperty('frequency_penalty');
    });

    it('is a no-op for non-thinking models — no thinking field, temperature preserved', async () => {
      mockConfigValues.set('model', 'deepseek-chat');
      mockConfigValues.set('temperature', 0.42);
      mockSecrets.get.mockResolvedValue('test-key');
      stubChatResponse();
      const client = new DeepSeekClient(createContext());

      await client.chat([{ role: 'user', content: 'hi' }]);
      const body = lastRequestBody();
      expect(body).not.toHaveProperty('thinking');
      expect(body).not.toHaveProperty('reasoning_effort');
      expect(body.model).toBe('deepseek-chat'); // no suffix to strip
      expect(body.temperature).toBe(0.42);
    });
  });

  describe('chat() tool gating', () => {
    it('attaches tools when model toolCalling=native and tools provided', async () => {
      mockConfigValues.set('model', 'deepseek-chat');
      mockSecrets.get.mockResolvedValue('test-key');
      stubChatResponse();
      const client = new DeepSeekClient(createContext());

      const tools = [
        { type: 'function' as const, function: { name: 'foo', description: 'd', parameters: { type: 'object' as const, properties: {} } } }
      ];
      await client.chat([{ role: 'user', content: 'hi' }], undefined, { tools });
      expect(lastRequestBody().tools).toEqual(tools);
    });

    it('does NOT attach tools on toolCalling=none models (R1)', async () => {
      mockConfigValues.set('model', 'deepseek-reasoner');
      mockSecrets.get.mockResolvedValue('test-key');
      stubChatResponse();
      const client = new DeepSeekClient(createContext());

      const tools = [
        { type: 'function' as const, function: { name: 'foo', description: 'd', parameters: { type: 'object' as const, properties: {} } } }
      ];
      await client.chat([{ role: 'user', content: 'hi' }], undefined, { tools });
      expect(lastRequestBody()).not.toHaveProperty('tools');
    });

    it('does NOT attach tools when caller passes empty array', async () => {
      mockConfigValues.set('model', 'deepseek-chat');
      mockSecrets.get.mockResolvedValue('test-key');
      stubChatResponse();
      const client = new DeepSeekClient(createContext());

      await client.chat([{ role: 'user', content: 'hi' }], undefined, { tools: [] });
      expect(lastRequestBody()).not.toHaveProperty('tools');
    });
  });

  describe('getApiKey precedence (observed via chat() Authorization header)', () => {
    function authHeader(): string | undefined {
      const call = mockHttpClient.post.mock.calls.at(-1);
      return call?.[2]?.headers?.Authorization;
    }

    it('per-model secret wins over global secret', async () => {
      mockConfigValues.set('model', 'deepseek-chat');
      mockSecrets.get.mockImplementation(async (k: string) => {
        if (k === 'moby.customModelKey.deepseek-chat') return 'PER-MODEL-KEY';
        if (k === 'moby.apiKey') return 'GLOBAL-KEY';
        return undefined;
      });
      stubChatResponse();
      const client = new DeepSeekClient(createContext());

      await client.chat([{ role: 'user', content: 'hi' }]);
      expect(authHeader()).toBe('Bearer PER-MODEL-KEY');
    });

    it('global secret wins over env when no per-model key set', async () => {
      mockConfigValues.set('model', 'deepseek-chat');
      mockSecrets.get.mockImplementation(async (k: string) => {
        if (k === 'moby.apiKey') return 'GLOBAL-KEY';
        return undefined;
      });
      process.env.DEEPSEEK_API_KEY = 'ENV-KEY';
      stubChatResponse();
      const client = new DeepSeekClient(createContext());

      await client.chat([{ role: 'user', content: 'hi' }]);
      expect(authHeader()).toBe('Bearer GLOBAL-KEY');
    });

    it('falls back to DEEPSEEK_API_KEY env var when no secrets are set', async () => {
      mockConfigValues.set('model', 'deepseek-chat');
      mockSecrets.get.mockResolvedValue(undefined);
      process.env.DEEPSEEK_API_KEY = 'ENV-KEY';
      stubChatResponse();
      const client = new DeepSeekClient(createContext());

      await client.chat([{ role: 'user', content: 'hi' }]);
      expect(authHeader()).toBe('Bearer ENV-KEY');
    });

    it('throws a configuration error when nothing is set', async () => {
      mockConfigValues.set('model', 'deepseek-chat');
      mockSecrets.get.mockResolvedValue(undefined);
      const client = new DeepSeekClient(createContext());

      await expect(client.chat([{ role: 'user', content: 'hi' }]))
        .rejects.toThrow(/API key is not configured/);
    });
  });

  describe('isApiKeyConfigured()', () => {
    it('returns true when per-model secret is set', async () => {
      mockConfigValues.set('model', 'deepseek-chat');
      mockSecrets.get.mockImplementation(async (k: string) =>
        k === 'moby.customModelKey.deepseek-chat' ? 'k' : undefined
      );
      const client = new DeepSeekClient(createContext());
      expect(await client.isApiKeyConfigured()).toBe(true);
    });

    it('returns true when global secret is set', async () => {
      mockConfigValues.set('model', 'deepseek-chat');
      mockSecrets.get.mockImplementation(async (k: string) =>
        k === 'moby.apiKey' ? 'k' : undefined
      );
      const client = new DeepSeekClient(createContext());
      expect(await client.isApiKeyConfigured()).toBe(true);
    });

    it('returns true when env var is set', async () => {
      mockConfigValues.set('model', 'deepseek-chat');
      mockSecrets.get.mockResolvedValue(undefined);
      process.env.DEEPSEEK_API_KEY = 'env-k';
      const client = new DeepSeekClient(createContext());
      expect(await client.isApiKeyConfigured()).toBe(true);
    });

    it('returns false when nothing is set', async () => {
      mockConfigValues.set('model', 'deepseek-chat');
      mockSecrets.get.mockResolvedValue(undefined);
      const client = new DeepSeekClient(createContext());
      expect(await client.isApiKeyConfigured()).toBe(false);
    });
  });

  describe('handleError (via thrown chat() errors)', () => {
    async function chatWithHttpError(status: number, message?: string, data?: unknown): Promise<Error> {
      mockConfigValues.set('model', 'deepseek-chat');
      mockSecrets.get.mockResolvedValue('test-key');
      const { HttpError } = await import('../../src/utils/httpClient');
      const httpErr: any = new HttpError(message ?? 'http error');
      httpErr.response = { status, statusText: 'X', data };
      mockHttpClient.post.mockRejectedValue(httpErr);
      const client = new DeepSeekClient(createContext());
      try {
        await client.chat([{ role: 'user', content: 'hi' }]);
        throw new Error('did not throw');
      } catch (e) {
        return e as Error;
      }
    }

    it('maps 401 → "Invalid API key" message', async () => {
      const err = await chatWithHttpError(401);
      expect(err.message).toMatch(/Invalid API key/i);
    });

    it('maps 429 → rate-limit message', async () => {
      const err = await chatWithHttpError(429);
      expect(err.message).toMatch(/Rate limit/i);
    });

    it('maps 500 → server-error message', async () => {
      const err = await chatWithHttpError(500);
      expect(err.message).toMatch(/server error/i);
    });

    it('forwards API-provided error.message in the default branch', async () => {
      const err = await chatWithHttpError(400, 'fallback', { error: { message: 'thinking mode requires reasoning_content' } });
      expect(err.message).toMatch(/thinking mode requires reasoning_content/);
    });

    it('handles ENOTFOUND with a connection-failure message', async () => {
      mockConfigValues.set('model', 'deepseek-chat');
      mockSecrets.get.mockResolvedValue('test-key');
      const { HttpError } = await import('../../src/utils/httpClient');
      const httpErr: any = new HttpError('getaddrinfo ENOTFOUND');
      httpErr.code = 'ENOTFOUND';
      mockHttpClient.post.mockRejectedValue(httpErr);
      const client = new DeepSeekClient(createContext());

      await expect(client.chat([{ role: 'user', content: 'hi' }]))
        .rejects.toThrow(/Cannot connect to DeepSeek API/i);
    });
  });

  describe('estimateTokens', () => {
    it('returns a positive integer for non-empty input', () => {
      mockConfigValues.set('model', 'deepseek-chat');
      const client = new DeepSeekClient(createContext());
      const n = client.estimateTokens('hello world');
      expect(n).toBeGreaterThan(0);
      expect(Number.isFinite(n)).toBe(true);
    });

    it('scales (roughly) with input length', () => {
      mockConfigValues.set('model', 'deepseek-chat');
      const client = new DeepSeekClient(createContext());
      const small = client.estimateTokens('hi');
      const big = client.estimateTokens('hi'.repeat(500));
      expect(big).toBeGreaterThan(small);
    });
  });

  describe('chat() max_tokens clamping', () => {
    it('clamps requested max_tokens to the model cap', async () => {
      mockConfigValues.set('model', 'deepseek-chat');
      mockSecrets.get.mockResolvedValue('test-key');
      stubChatResponse();
      const client = new DeepSeekClient(createContext());

      // deepseek-chat has maxOutputTokens=8192, no maxOutputTokensCap.
      await client.chat([{ role: 'user', content: 'hi' }], undefined, { maxTokens: 99999 });
      expect(lastRequestBody().max_tokens).toBe(8192);
    });

    it('respects the V4 cap when user requests up to 384k', async () => {
      mockConfigValues.set('model', 'deepseek-v4-flash');
      mockSecrets.get.mockResolvedValue('test-key');
      stubChatResponse();
      const client = new DeepSeekClient(createContext());

      await client.chat([{ role: 'user', content: 'hi' }], undefined, { maxTokens: 384000 });
      expect(lastRequestBody().max_tokens).toBe(384000);
    });

    it('floors max_tokens at 1', async () => {
      mockConfigValues.set('model', 'deepseek-chat');
      mockSecrets.get.mockResolvedValue('test-key');
      stubChatResponse();
      const client = new DeepSeekClient(createContext());

      await client.chat([{ role: 'user', content: 'hi' }], undefined, { maxTokens: -50 });
      expect(lastRequestBody().max_tokens).toBe(1);
    });
  });

  describe('setModel() override', () => {
    it('takes effect immediately, ahead of the underlying config value', async () => {
      mockConfigValues.set('model', 'deepseek-chat');
      mockSecrets.get.mockResolvedValue('test-key');
      stubChatResponse();
      const client = new DeepSeekClient(createContext());
      client.setModel('deepseek-v4-flash');

      await client.chat([{ role: 'user', content: 'hi' }]);
      expect(lastRequestBody().model).toBe('deepseek-v4-flash');
    });
  });
});
