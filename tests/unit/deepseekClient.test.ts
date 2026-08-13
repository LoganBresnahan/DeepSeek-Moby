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

    it('honors options.thinkingMode = "disabled" — sets type:disabled, omits reasoning_effort, and KEEPS temperature', async () => {
      mockConfigValues.set('model', 'deepseek-v4-flash-thinking');
      mockSecrets.get.mockResolvedValue('test-key');
      stubChatResponse();
      const client = new DeepSeekClient(createContext());

      await client.chat([{ role: 'user', content: 'hi' }], undefined, { thinkingMode: 'disabled', temperature: 0.42 });
      const body = lastRequestBody();
      expect(body.thinking).toEqual({ type: 'disabled' });
      expect(body).not.toHaveProperty('reasoning_effort');
      // The wire id comes from `wireModelId` now, not a suffix strip.
      expect(body.model).toBe('deepseek-v4-flash');
      // Sampling params are rejected BY THINKING MODE, not by the model. With
      // thinking off, V4 accepts temperature — stripping it here was the bug
      // `noSamplingParamsWhenThinking` exists to fix.
      expect(body.temperature).toBe(0.42);
    });

    it('omits reasoning_content from history when thinking is disabled, despite reasoningEcho: required', async () => {
      mockConfigValues.set('model', 'deepseek-v4-flash-thinking');
      mockSecrets.get.mockResolvedValue('test-key');
      stubChatResponse();
      const client = new DeepSeekClient(createContext());

      await client.chat(
        [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'hello', reasoning_content: 'pondering' },
        ],
        undefined,
        { thinkingMode: 'disabled' }
      );
      const messages = lastRequestBody().messages as Array<Record<string, unknown>>;
      const assistant = messages.find(m => m.role === 'assistant');
      // `reasoningEcho` is a property of thinking mode; the same model id
      // serves both modes, so echoing here claims a mode we're not in.
      expect(assistant).not.toHaveProperty('reasoning_content');
    });

    it('honors options.thinkingMode = "enabled" explicitly (same as default)', async () => {
      mockConfigValues.set('model', 'deepseek-v4-flash-thinking');
      mockSecrets.get.mockResolvedValue('test-key');
      stubChatResponse();
      const client = new DeepSeekClient(createContext());

      await client.chat([{ role: 'user', content: 'hi' }], undefined, { thinkingMode: 'enabled' });
      const body = lastRequestBody();
      expect(body.thinking).toEqual({ type: 'enabled' });
      expect(body.reasoning_effort).toBe('high');
    });

    it('thinkingMode override is silently ignored on non-thinking models', async () => {
      mockConfigValues.set('model', 'deepseek-chat');
      mockSecrets.get.mockResolvedValue('test-key');
      stubChatResponse();
      const client = new DeepSeekClient(createContext());

      await client.chat([{ role: 'user', content: 'hi' }], undefined, { thinkingMode: 'disabled' });
      const body = lastRequestBody();
      expect(body).not.toHaveProperty('thinking');
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

    it('maps 401 → "Invalid API key" message naming DeepSeek on a DeepSeek model', async () => {
      const err = await chatWithHttpError(401);
      expect(err.message).toMatch(/Invalid API key for DeepSeek/i);
      expect(err.message).toMatch(/DeepSeek API key/i);
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
        .rejects.toThrow(/Cannot connect to DeepSeek/i);
    });

    // Release-gate bug #1: a custom-model user must be pointed at THEIR
    // provider and THEIR key command — not told to check a DeepSeek key
    // that has nothing to do with the failure.
    describe('custom-model provider naming', () => {
      async function registerKimiAndSelect() {
        const { registerCustomModels } = await import('../../src/models/registry');
        registerCustomModels([{
          id: 'kimi-test', name: 'Kimi Test',
          toolCalling: 'native', reasoningTokens: 'inline',
          editProtocol: ['native-tool'], shellProtocol: 'native-tool',
          supportsTemperature: false, maxOutputTokens: 32768,
          maxTokensConfigKey: 'customModels.kimi-test.maxOutputTokens',
          streaming: true, apiEndpoint: 'https://api.moonshot.ai/v1',
          requestFormat: 'openai'
        }]);
        mockConfigValues.set('model', 'kimi-test');
      }

      afterEach(async () => {
        const { __resetCustomModelsForTests } = await import('../../src/models/registry');
        __resetCustomModelsForTests();
      });

      it('401 names the custom provider host and the per-model key command', async () => {
        await registerKimiAndSelect();
        mockSecrets.get.mockResolvedValue('test-key');
        const { HttpError } = await import('../../src/utils/httpClient');
        const httpErr: any = new HttpError('unauthorized');
        httpErr.response = { status: 401, statusText: 'X' };
        mockHttpClient.post.mockRejectedValue(httpErr);
        const client = new DeepSeekClient(createContext());

        const err = await client.chat([{ role: 'user', content: 'hi' }]).catch((e: Error) => e) as Error;
        expect(err.message).toContain('api.moonshot.ai');
        expect(err.message).toContain('kimi-test');
        expect(err.message).toContain('Set Custom Model API Key');
        expect(err.message).not.toMatch(/DeepSeek API key/);
      });

      it('ENOTFOUND names the custom provider host, not DeepSeek', async () => {
        await registerKimiAndSelect();
        mockSecrets.get.mockResolvedValue('test-key');
        const { HttpError } = await import('../../src/utils/httpClient');
        const httpErr: any = new HttpError('getaddrinfo ENOTFOUND');
        httpErr.code = 'ENOTFOUND';
        mockHttpClient.post.mockRejectedValue(httpErr);
        const client = new DeepSeekClient(createContext());

        const err = await client.chat([{ role: 'user', content: 'hi' }]).catch((e: Error) => e) as Error;
        expect(err.message).toContain('api.moonshot.ai');
        expect(err.message).not.toMatch(/DeepSeek/);
      });
    });
  });

  describe('temperatureFixedValue (release-gate bug #4)', () => {
    // Kimi rejects any temperature but 1 ("invalid temperature: only 1 is
    // allowed"); the boolean supportsTemperature could only express all-or-
    // nothing, so the only workaround was setting the GLOBAL temperature to
    // 1 for every model. A per-model pin beats both.
    afterEach(async () => {
      const { __resetCustomModelsForTests } = await import('../../src/models/registry');
      __resetCustomModelsForTests();
    });

    it('pins the request temperature regardless of the global setting', async () => {
      const { registerCustomModels } = await import('../../src/models/registry');
      registerCustomModels([{
        id: 'kimi-pin', name: 'Kimi Pin',
        toolCalling: 'native', reasoningTokens: 'none',
        editProtocol: ['native-tool'], shellProtocol: 'none',
        supportsTemperature: true, temperatureFixedValue: 1,
        maxOutputTokens: 8192,
        maxTokensConfigKey: 'customModels.kimi-pin.maxOutputTokens',
        streaming: true, apiEndpoint: 'https://api.moonshot.ai/v1',
        requestFormat: 'openai'
      }]);
      mockConfigValues.set('model', 'kimi-pin');
      mockConfigValues.set('temperature', 0.3);
      mockSecrets.get.mockResolvedValue('test-key');
      stubChatResponse();
      const client = new DeepSeekClient(createContext());

      await client.chat([{ role: 'user', content: 'hi' }]);

      expect(lastRequestBody().temperature).toBe(1);
    });

    it('without a pin, the global temperature still applies', async () => {
      mockConfigValues.set('model', 'deepseek-chat');
      mockConfigValues.set('temperature', 0.3);
      mockSecrets.get.mockResolvedValue('test-key');
      stubChatResponse();
      const client = new DeepSeekClient(createContext());

      await client.chat([{ role: 'user', content: 'hi' }]);

      expect(lastRequestBody().temperature).toBe(0.3);
    });
  });

  describe('disableThinkingParam on custom models (release-gate bug #3)', () => {
    // The router forces thinkingMode:'disabled' on every sub-call, but
    // applyThinkingMode returned early on !sendThinkingParam — so the force
    // never reached a custom backend and a Kimi image digest burned 30s of
    // reasoning. A custom entry can now DECLARE its provider's off-knob.
    async function registerCustomAndSelect(extra: Record<string, unknown> = {}) {
      const { registerCustomModels } = await import('../../src/models/registry');
      registerCustomModels([{
        id: 'qwen-test', name: 'Qwen Test',
        toolCalling: 'native', reasoningTokens: 'inline',
        editProtocol: ['native-tool'], shellProtocol: 'native-tool',
        supportsTemperature: true, maxOutputTokens: 8192,
        maxTokensConfigKey: 'customModels.qwen-test.maxOutputTokens',
        streaming: true, apiEndpoint: 'https://example.test/v1',
        requestFormat: 'openai',
        ...extra
      }]);
      mockConfigValues.set('model', 'qwen-test');
      mockSecrets.get.mockResolvedValue('test-key');
      stubChatResponse();
      return new DeepSeekClient(createContext());
    }

    afterEach(async () => {
      const { __resetCustomModelsForTests } = await import('../../src/models/registry');
      __resetCustomModelsForTests();
    });

    it('merges the declared params when a caller asks for thinkingMode disabled', async () => {
      const client = await registerCustomAndSelect({
        disableThinkingParam: { enable_thinking: false }
      });

      await client.chat([{ role: 'user', content: 'hi' }], undefined, { thinkingMode: 'disabled' });

      expect(lastRequestBody().enable_thinking).toBe(false);
    });

    it('sends nothing extra when the caller did not ask to disable', async () => {
      const client = await registerCustomAndSelect({
        disableThinkingParam: { enable_thinking: false }
      });

      await client.chat([{ role: 'user', content: 'hi' }]);

      expect(lastRequestBody().enable_thinking).toBeUndefined();
    });

    it('never invents a param when the entry declares none', async () => {
      const client = await registerCustomAndSelect();

      await client.chat([{ role: 'user', content: 'hi' }], undefined, { thinkingMode: 'disabled' });

      const body = lastRequestBody();
      expect(body.enable_thinking).toBeUndefined();
      expect(body.thinking).toBeUndefined();
      expect(body.reasoning_effort).toBeUndefined();
    });

    // Declared thinking levels. The claim `reasoningEffort` could never make:
    // it validated on a custom entry and was then dropped on the floor,
    // because applyThinkingMode returned early on !sendThinkingParam.
    // Shaped after Kimi K3 — bare top-level `reasoning_effort`, no wrapper.
    const K3_LEVELS = {
      thinkingLevels: {
        low: { reasoning_effort: 'low' },
        high: { reasoning_effort: 'high' },
        max: { reasoning_effort: 'max' },
      },
      defaultThinkingLevel: 'max',
    };

    it('sends a custom entry declared level params — the default when unset', async () => {
      const client = await registerCustomAndSelect(K3_LEVELS);

      await client.chat([{ role: 'user', content: 'hi' }]);

      const body = lastRequestBody();
      expect(body.reasoning_effort).toBe('max');
      // No `thinking` wrapper — K3 dropped it, and levels are declared per
      // model precisely so one vendor's shape isn't imposed on another.
      expect(body.thinking).toBeUndefined();
    });

    it('honors a user-selected level from moby.modelOptions', async () => {
      const client = await registerCustomAndSelect(K3_LEVELS);
      mockConfigValues.set('modelOptions', { 'qwen-test': { thinkingLevel: 'low' } });

      await client.chat([{ role: 'user', content: 'hi' }]);

      expect(lastRequestBody().reasoning_effort).toBe('low');
    });

    it('falls back to the legacy reasoningEffort key so 0.8.0 settings keep working', async () => {
      const client = await registerCustomAndSelect(K3_LEVELS);
      mockConfigValues.set('modelOptions', { 'qwen-test': { reasoningEffort: 'high' } });

      await client.chat([{ role: 'user', content: 'hi' }]);

      expect(lastRequestBody().reasoning_effort).toBe('high');
    });

    it('falls back to the default when the selected level is not declared', async () => {
      const client = await registerCustomAndSelect(K3_LEVELS);
      mockConfigValues.set('modelOptions', { 'qwen-test': { thinkingLevel: 'medium' } });

      await client.chat([{ role: 'user', content: 'hi' }]);

      // Never send an undeclared value — the provider 400s on it.
      expect(lastRequestBody().reasoning_effort).toBe('max');
    });

    it('degrades a forced-disable to the cheapest level when the model declares no off-knob', async () => {
      // K3 always thinks. Honouring "disable" as closely as the model allows
      // beats inventing a param (a 400) or paying max effort on a digest.
      const client = await registerCustomAndSelect(K3_LEVELS);

      await client.chat([{ role: 'user', content: 'hi' }], undefined, { thinkingMode: 'disabled' });

      expect(lastRequestBody().reasoning_effort).toBe('low');
    });

    it('lets a declared off-knob beat the levels when the caller forces disable', async () => {
      const client = await registerCustomAndSelect({
        ...K3_LEVELS,
        disableThinkingParam: { enable_thinking: false },
      });

      await client.chat([{ role: 'user', content: 'hi' }], undefined, { thinkingMode: 'disabled' });

      const body = lastRequestBody();
      expect(body.enable_thinking).toBe(false);
      expect(body.reasoning_effort).toBeUndefined();
    });

    it('lets a forced disable beat the user pill, so routed sub-calls stay cheap', async () => {
      const client = await registerCustomAndSelect({
        ...K3_LEVELS,
        disableThinkingParam: { enable_thinking: false },
      });
      mockConfigValues.set('modelOptions', { 'qwen-test': { thinking: 'on', thinkingLevel: 'max' } });

      await client.chat([{ role: 'user', content: 'hi' }], undefined, { thinkingMode: 'disabled' });

      expect(lastRequestBody().enable_thinking).toBe(false);
      expect(lastRequestBody().reasoning_effort).toBeUndefined();
    });

    it('honors the user thinking:off setting with no caller override', async () => {
      const client = await registerCustomAndSelect({
        ...K3_LEVELS,
        disableThinkingParam: { enable_thinking: false },
      });
      mockConfigValues.set('modelOptions', { 'qwen-test': { thinking: 'off' } });

      await client.chat([{ role: 'user', content: 'hi' }]);

      expect(lastRequestBody().enable_thinking).toBe(false);
    });
  });

  // ADR 0017 — serialization differences are declared, not coded. These two
  // axes are the escape hatch for providers Moby doesn't model.
  describe('maxTokensParam + extraParams (ADR 0017)', () => {
    async function registerAndSelect(extra: Record<string, unknown> = {}) {
      const { registerCustomModels } = await import('../../src/models/registry');
      registerCustomModels([{
        id: 'passthru-test', name: 'Passthrough Test',
        toolCalling: 'native', reasoningTokens: 'none',
        editProtocol: ['native-tool'], shellProtocol: 'none',
        supportsTemperature: true, maxOutputTokens: 8192,
        maxTokensConfigKey: 'customModels.passthru-test.maxOutputTokens',
        streaming: true, apiEndpoint: 'https://example.test/v1',
        requestFormat: 'openai',
        ...extra
      }]);
      mockConfigValues.set('model', 'passthru-test');
      mockSecrets.get.mockResolvedValue('test-key');
      stubChatResponse();
      return new DeepSeekClient(createContext());
    }

    afterEach(async () => {
      const { __resetCustomModelsForTests } = await import('../../src/models/registry');
      __resetCustomModelsForTests();
    });

    it('sends max_tokens by default', async () => {
      const client = await registerAndSelect();
      await client.chat([{ role: 'user', content: 'hi' }], undefined, { maxTokens: 1234 });
      const body = lastRequestBody();
      expect(body.max_tokens).toBe(1234);
      expect(body).not.toHaveProperty('max_completion_tokens');
    });

    it('renames the field when the model declares max_completion_tokens', async () => {
      // OpenAI's reasoning models reject max_tokens outright.
      const client = await registerAndSelect({ maxTokensParam: 'max_completion_tokens' });
      await client.chat([{ role: 'user', content: 'hi' }], undefined, { maxTokens: 1234 });
      const body = lastRequestBody();
      expect(body.max_completion_tokens).toBe(1234);
      expect(body).not.toHaveProperty('max_tokens');
    });

    it('merges extraParams onto every request', async () => {
      const client = await registerAndSelect({
        extraParams: { service_tier: 'flex', safety_settings: [{ category: 'X' }] }
      });
      await client.chat([{ role: 'user', content: 'hi' }]);
      const body = lastRequestBody();
      expect(body.service_tier).toBe('flex');
      expect(body.safety_settings).toEqual([{ category: 'X' }]);
    });

    it('lets a declared thinking level BEAT extraParams', async () => {
      // Static config must never deaden a live control — an extraParams
      // reasoning_effort winning here would make the effort pill inert, which
      // is the dead-control bug this whole design exists to prevent.
      const client = await registerAndSelect({
        extraParams: { reasoning_effort: 'max' },
        thinkingLevels: { low: { reasoning_effort: 'low' } },
        defaultThinkingLevel: 'low',
      });
      await client.chat([{ role: 'user', content: 'hi' }]);
      expect(lastRequestBody().reasoning_effort).toBe('low');
    });
  });

  describe('chat() abort signal (release-gate bug #2, half two)', () => {
    // chat() accepted options.signal but never passed it to the HTTP layer,
    // so Stop could not cancel a non-streaming runToolLoop probe — it stayed
    // parked until the request timeout. ADR 0008's teardown relies on the
    // abort actually reaching the request.
    it('forwards options.signal to the HTTP layer', async () => {
      mockConfigValues.set('model', 'deepseek-chat');
      mockSecrets.get.mockResolvedValue('test-key');
      mockHttpClient.post.mockResolvedValue({
        data: { choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }] }
      });
      const client = new DeepSeekClient(createContext());
      const controller = new AbortController();

      await client.chat([{ role: 'user', content: 'hi' }], undefined, { signal: controller.signal });

      const requestConfig = mockHttpClient.post.mock.calls[0][2];
      expect(requestConfig.signal).toBe(controller.signal);
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
      mockConfigValues.set('model', 'deepseek-v4-flash-thinking');
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
      client.setModel('deepseek-v4-flash-thinking');

      await client.chat([{ role: 'user', content: 'hi' }]);
      // setModel preserves the full id; wire serializer strips the -thinking
      // suffix before sending upstream.
      expect(lastRequestBody().model).toBe('deepseek-v4-flash');
    });
  });
});
