/**
 * Lightweight HTTP client wrapper around native fetch
 * Replaces axios with ~0KB footprint vs ~400KB
 */

export interface HttpClientConfig {
  baseURL: string;
  timeout?: number;
  headers?: Record<string, string>;
}

export interface RequestConfig {
  headers?: Record<string, string>;
  responseType?: 'json' | 'stream';
  signal?: AbortSignal;
}

export interface HttpResponse<T = unknown> {
  data: T;
  status: number;
  statusText: string;
  headers: Headers;
}

export interface HttpError extends Error {
  response?: {
    status: number;
    statusText: string;
    data: unknown;
  };
  code?: string;
}

export class HttpClient {
  private baseURL: string;
  private timeout: number;
  private defaultHeaders: Record<string, string>;

  constructor(config: HttpClientConfig) {
    this.baseURL = config.baseURL.replace(/\/$/, ''); // Remove trailing slash
    this.timeout = config.timeout ?? 60000;
    this.defaultHeaders = config.headers ?? {};
  }

  async get<T = unknown>(path: string, config?: RequestConfig): Promise<HttpResponse<T>> {
    return this.request<T>('GET', path, undefined, config);
  }

  async post<T = unknown>(path: string, body?: unknown, config?: RequestConfig): Promise<HttpResponse<T>> {
    return this.request<T>('POST', path, body, config);
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    config?: RequestConfig
  ): Promise<HttpResponse<T>> {
    const url = `${this.baseURL}${path}`;
    const headers = {
      ...this.defaultHeaders,
      ...(config?.headers ?? {})
    };

    // Set up timeout via AbortController
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    // Use provided signal or our timeout signal
    const signal = config?.signal ?? controller.signal;

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal
      });

      clearTimeout(timeoutId);

      // Handle error responses
      if (!response.ok) {
        const errorData = await this.safeParseJson(response);
        const error = new Error(`HTTP ${response.status}: ${response.statusText}`) as HttpError;
        error.response = {
          status: response.status,
          statusText: response.statusText,
          data: errorData
        };
        throw error;
      }

      // For streaming responses, return the body stream directly
      if (config?.responseType === 'stream') {
        return {
          data: response.body as T,
          status: response.status,
          statusText: response.statusText,
          headers: response.headers
        };
      }

      // Parse JSON response
      const data = await response.json() as T;
      return {
        data,
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      };
    } catch (error: unknown) {
      clearTimeout(timeoutId);

      // Handle abort/timeout
      if (error instanceof Error && error.name === 'AbortError') {
        const httpError = new Error('Request timeout') as HttpError;
        httpError.code = 'ECONNABORTED';
        throw httpError;
      }

      // Handle network errors
      if (error instanceof TypeError && error.message.includes('fetch')) {
        const httpError = new Error('Network error') as HttpError;
        httpError.code = 'ENOTFOUND';
        throw httpError;
      }

      throw error;
    }
  }

  private async safeParseJson(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }
}

/**
 * Event-based stream reader interface for compatibility with axios-style streaming
 */
export interface StreamReader {
  on(event: 'data', handler: (chunk: Buffer) => void): void;
  on(event: 'error', handler: (error: Error) => void): void;
  on(event: 'end', handler: () => void): void;
}

/**
 * Helper to create a streaming reader from a fetch response body
 * Compatible with Node.js environment in VS Code extensions
 */
export function createStreamReader(body: ReadableStream<Uint8Array>): StreamReader {
  const handlers: {
    data: ((chunk: Buffer) => void)[];
    error: ((error: Error) => void)[];
    end: (() => void)[];
  } = {
    data: [],
    error: [],
    end: []
  };

  // Start reading in the background
  (async () => {
    try {
      const reader = body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          handlers.end.forEach(h => h());
          break;
        }
        const buffer = Buffer.from(value);
        handlers.data.forEach(h => h(buffer));
      }
    } catch (error) {
      handlers.error.forEach(h => h(error as Error));
    }
  })();

  return {
    on(event: 'data' | 'error' | 'end', handler: ((chunk: Buffer) => void) | ((error: Error) => void) | (() => void)) {
      if (event === 'data') {
        handlers.data.push(handler as (chunk: Buffer) => void);
      } else if (event === 'error') {
        handlers.error.push(handler as (error: Error) => void);
      } else if (event === 'end') {
        handlers.end.push(handler as () => void);
      }
    }
  };
}
