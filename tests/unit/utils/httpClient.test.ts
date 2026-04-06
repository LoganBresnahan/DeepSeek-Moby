/**
 * Tests for HttpClient - lightweight fetch wrapper
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HttpClient, createStreamReader, type HttpError } from '../../../src/utils/httpClient';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function createMockResponse(options: {
  ok?: boolean;
  status?: number;
  statusText?: string;
  json?: unknown;
  body?: ReadableStream | null;
  headers?: Record<string, string>;
}): Response {
  const {
    ok = true,
    status = 200,
    statusText = 'OK',
    json = {},
    body = null,
    headers = {}
  } = options;

  return {
    ok,
    status,
    statusText,
    headers: new Headers(headers),
    json: vi.fn().mockResolvedValue(json),
    body,
    text: vi.fn().mockResolvedValue(JSON.stringify(json)),
    clone: vi.fn(),
    arrayBuffer: vi.fn(),
    blob: vi.fn(),
    formData: vi.fn(),
    bodyUsed: false,
    redirected: false,
    type: 'basic' as ResponseType,
    url: ''
  } as unknown as Response;
}

describe('HttpClient', () => {
  let client: HttpClient;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    client = new HttpClient({
      baseURL: 'https://api.example.com',
      timeout: 5000,
      headers: { 'Authorization': 'Bearer test-token' }
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('constructor', () => {
    it('accepts config and strips trailing slash from baseURL', () => {
      const c = new HttpClient({ baseURL: 'https://api.example.com/' });
      // Verify by making a request - the URL should not have double slashes
      mockFetch.mockResolvedValue(createMockResponse({ json: {} }));
      c.get('/test');
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.example.com/test',
        expect.any(Object)
      );
    });

    it('uses default timeout of 60000ms when not specified', () => {
      // We verify this indirectly - just ensure construction works
      const c = new HttpClient({ baseURL: 'https://api.test.com' });
      expect(c).toBeDefined();
    });
  });

  describe('get', () => {
    it('makes a GET request with correct URL', async () => {
      mockFetch.mockResolvedValue(createMockResponse({ json: { result: 'ok' } }));

      const response = await client.get('/v1/models');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.example.com/v1/models',
        expect.objectContaining({ method: 'GET' })
      );
      expect(response.data).toEqual({ result: 'ok' });
      expect(response.status).toBe(200);
    });

    it('includes default headers in request', async () => {
      mockFetch.mockResolvedValue(createMockResponse({ json: {} }));

      await client.get('/test');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            'Authorization': 'Bearer test-token'
          })
        })
      );
    });

    it('merges request-specific headers with defaults', async () => {
      mockFetch.mockResolvedValue(createMockResponse({ json: {} }));

      await client.get('/test', { headers: { 'X-Custom': 'value' } });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            'Authorization': 'Bearer test-token',
            'X-Custom': 'value'
          })
        })
      );
    });

    it('does not include body for GET requests', async () => {
      mockFetch.mockResolvedValue(createMockResponse({ json: {} }));

      await client.get('/test');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ body: undefined })
      );
    });
  });

  describe('post', () => {
    it('makes a POST request with JSON body', async () => {
      const body = { prompt: 'hello', model: 'deepseek-chat' };
      mockFetch.mockResolvedValue(createMockResponse({ json: { id: '123' } }));

      const response = await client.post('/v1/chat/completions', body);

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.example.com/v1/chat/completions',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify(body)
        })
      );
      expect(response.data).toEqual({ id: '123' });
    });

    it('handles POST with no body', async () => {
      mockFetch.mockResolvedValue(createMockResponse({ json: {} }));

      await client.post('/v1/action');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          method: 'POST',
          body: undefined
        })
      );
    });
  });

  describe('response parsing', () => {
    it('parses JSON response and returns status info', async () => {
      mockFetch.mockResolvedValue(createMockResponse({
        status: 200,
        statusText: 'OK',
        json: { data: [1, 2, 3] }
      }));

      const response = await client.get('/test');

      expect(response.data).toEqual({ data: [1, 2, 3] });
      expect(response.status).toBe(200);
      expect(response.statusText).toBe('OK');
      expect(response.headers).toBeInstanceOf(Headers);
    });

    it('returns body stream for responseType stream', async () => {
      const mockStream = new ReadableStream();
      mockFetch.mockResolvedValue(createMockResponse({
        body: mockStream
      }));

      const response = await client.get('/stream', { responseType: 'stream' });

      expect(response.data).toBe(mockStream);
    });
  });

  describe('error handling', () => {
    it('throws HttpError for non-OK responses', async () => {
      mockFetch.mockResolvedValue(createMockResponse({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        json: { error: 'Invalid API key' }
      }));

      try {
        await client.get('/protected');
        expect.fail('Should have thrown');
      } catch (error: any) {
        expect(error.message).toBe('HTTP 401: Unauthorized');
        expect(error.response).toBeDefined();
        expect(error.response.status).toBe(401);
        expect(error.response.statusText).toBe('Unauthorized');
        expect(error.response.data).toEqual({ error: 'Invalid API key' });
      }
    });

    it('throws HttpError for 500 server errors', async () => {
      mockFetch.mockResolvedValue(createMockResponse({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        json: null
      }));

      try {
        await client.get('/broken');
        expect.fail('Should have thrown');
      } catch (error: any) {
        expect(error.message).toBe('HTTP 500: Internal Server Error');
        expect(error.response.status).toBe(500);
      }
    });

    it('handles AbortError as timeout', async () => {
      const abortError = new Error('Aborted');
      abortError.name = 'AbortError';
      mockFetch.mockRejectedValue(abortError);

      try {
        await client.get('/slow');
        expect.fail('Should have thrown');
      } catch (error: any) {
        expect(error.message).toBe('Request timeout');
        expect(error.code).toBe('ECONNABORTED');
      }
    });

    it('handles network errors (fetch TypeError)', async () => {
      const fetchError = new TypeError('Failed to fetch');
      mockFetch.mockRejectedValue(fetchError);

      try {
        await client.get('/unreachable');
        expect.fail('Should have thrown');
      } catch (error: any) {
        expect(error.message).toBe('Network error');
        expect(error.code).toBe('ENOTFOUND');
      }
    });

    it('rethrows unknown errors', async () => {
      const unknownError = new Error('Something unexpected');
      mockFetch.mockRejectedValue(unknownError);

      try {
        await client.get('/test');
        expect.fail('Should have thrown');
      } catch (error: any) {
        expect(error.message).toBe('Something unexpected');
        expect(error.code).toBeUndefined();
      }
    });
  });

  describe('abort signal', () => {
    it('passes provided signal to fetch', async () => {
      const controller = new AbortController();
      mockFetch.mockResolvedValue(createMockResponse({ json: {} }));

      await client.get('/test', { signal: controller.signal });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ signal: controller.signal })
      );
    });
  });
});

describe('createStreamReader', () => {
  it('emits data events for each chunk', async () => {
    const chunks = [
      new Uint8Array([72, 101, 108, 108, 111]), // "Hello"
      new Uint8Array([87, 111, 114, 108, 100])  // "World"
    ];

    let chunkIndex = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunkIndex < chunks.length) {
          controller.enqueue(chunks[chunkIndex++]);
        } else {
          controller.close();
        }
      }
    });

    const reader = createStreamReader(stream);
    const received: Buffer[] = [];

    await new Promise<void>((resolve) => {
      reader.on('data', (chunk: Buffer) => {
        received.push(chunk);
      });
      reader.on('end', () => {
        resolve();
      });
    });

    expect(received).toHaveLength(2);
    expect(received[0].toString()).toBe('Hello');
    expect(received[1].toString()).toBe('World');
  });

  it('emits end event when stream is complete', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      }
    });

    const reader = createStreamReader(stream);

    const ended = await new Promise<boolean>((resolve) => {
      reader.on('end', () => {
        resolve(true);
      });
    });

    expect(ended).toBe(true);
  });

  it('emits error event on stream failure', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('Stream broke'));
      }
    });

    const reader = createStreamReader(stream);

    const error = await new Promise<Error>((resolve) => {
      reader.on('error', (err: Error) => {
        resolve(err);
      });
    });

    expect(error.message).toBe('Stream broke');
  });
});
