/**
 * Lightweight HTTP client wrapper around native fetch
 * Replaces axios with ~0KB footprint vs ~400KB
 */

export interface HttpClientConfig {
  baseURL: string;
  /** Milliseconds before a request aborts. Pass a function to resolve it per
   *  request — clients are cached per endpoint, so a fixed number would pin
   *  whatever the setting was when the client was first built. */
  timeout?: number | (() => number);
  headers?: Record<string, string>;
}

/** Fallback when no timeout is configured. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 60000;

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
  private resolveTimeout: () => number;
  private defaultHeaders: Record<string, string>;

  constructor(config: HttpClientConfig) {
    this.baseURL = config.baseURL.replace(/\/$/, ''); // Remove trailing slash
    const t = config.timeout;
    this.resolveTimeout =
      typeof t === 'function' ? t :
      typeof t === 'number' ? () => t :
      () => DEFAULT_REQUEST_TIMEOUT_MS;
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
    const timeoutId = setTimeout(() => controller.abort(), this.resolveTimeout());

    // Honor BOTH the caller's signal and the timeout. The old selection
    // (`config?.signal ?? controller.signal`) orphaned whichever lost: a
    // caller signal silenced the timeout entirely (streaming requests ran
    // unbounded), while its absence left the request unreachable by Stop.
    // The timeout is cleared once headers arrive, so it bounds
    // time-to-headers only — a long-running stream body is never killed by
    // it, and mid-stream cancellation stays the caller signal's job.
    const signal = config?.signal
      ? AbortSignal.any([config.signal, controller.signal])
      : controller.signal;

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

      // Handle abort/timeout. With both signals combined, "which one fired?"
      // matters: a caller abort (Stop) must keep its AbortError identity so
      // abort branches recognize it — only the timeout controller's fire is
      // a timeout.
      if (error instanceof Error && error.name === 'AbortError') {
        if (config?.signal?.aborted) {
          throw error;
        }
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
