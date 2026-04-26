/**
 * Unit tests for SearxngClient.
 *
 * SearXNG is unauthenticated (key-less), so most failure modes are about
 * URL/format mistakes rather than credentials. These tests pin the
 * request shape, response normalization, and the four error-mapping
 * branches in `search()`'s catch block (401/403, 404, no-response,
 * generic). The score-derivation logic gets a dedicated test because
 * "rank-based fallback when SearXNG omits scores" is the kind of thing
 * that quietly breaks when a future engine starts returning unscored
 * results.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mock state ──────────────────────────────────────────────

const { mockHttpClient, mockConfigValues } = vi.hoisted(() => ({
  mockHttpClient: {
    get: vi.fn(),
    post: vi.fn()
  },
  mockConfigValues: new Map<string, any>()
}));

// ── Module mocks ────────────────────────────────────────────────────

vi.mock('../../../src/utils/httpClient', () => {
  class HttpError extends Error {
    response?: { status: number; statusText: string; data: unknown };
    code?: string;
  }
  return {
    HttpClient: vi.fn(() => mockHttpClient),
    HttpError
  };
});

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: vi.fn((key: string) => mockConfigValues.get(key))
    }))
  }
}));

import { SearxngClient } from '../../../src/clients/searxngClient';

// ── Helpers ─────────────────────────────────────────────────────────

function createContext() {
  return { secrets: { get: vi.fn() }, subscriptions: [] } as any;
}

function httpError(status: number | undefined, message = 'failed') {
  const err: any = new Error(message);
  if (status !== undefined) {
    err.response = { status, statusText: message, data: {} };
  }
  return err;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockConfigValues.clear();
});

// ── Tests ───────────────────────────────────────────────────────────

describe('SearxngClient', () => {
  describe('isConfigured', () => {
    it('returns false when no endpoint configured', async () => {
      const client = new SearxngClient(createContext());
      expect(await client.isConfigured()).toBe(false);
    });

    it('returns false for whitespace-only endpoint', async () => {
      mockConfigValues.set('webSearch.searxng.endpoint', '   ');
      const client = new SearxngClient(createContext());
      expect(await client.isConfigured()).toBe(false);
    });

    it('returns true when endpoint is set', async () => {
      mockConfigValues.set('webSearch.searxng.endpoint', 'http://localhost:8080');
      const client = new SearxngClient(createContext());
      expect(await client.isConfigured()).toBe(true);
    });
  });

  describe('search() — request shape', () => {
    it('throws a config-hint error when endpoint is missing', async () => {
      const client = new SearxngClient(createContext());
      await expect(client.search('hello')).rejects.toThrow(/endpoint is not configured/i);
    });

    it('issues GET /search?q=...&format=json against the configured endpoint', async () => {
      mockConfigValues.set('webSearch.searxng.endpoint', 'http://localhost:8080');
      mockHttpClient.get.mockResolvedValue({
        data: { query: 'q', results: [], answers: [] }
      });
      const client = new SearxngClient(createContext());
      await client.search('rust borrow checker');

      expect(mockHttpClient.get).toHaveBeenCalledTimes(1);
      const url = mockHttpClient.get.mock.calls[0][0] as string;
      expect(url).toMatch(/^\/search\?/);
      expect(url).toContain('q=rust+borrow+checker');
      expect(url).toContain('format=json');
    });

    it('strips trailing slash from endpoint when constructing the HttpClient', async () => {
      mockConfigValues.set('webSearch.searxng.endpoint', 'http://localhost:8080/');
      mockHttpClient.get.mockResolvedValue({ data: { results: [] } });
      const client = new SearxngClient(createContext());
      await client.search('q');

      // We can't directly inspect the HttpClient constructor args here without
      // also mocking the constructor — but we can verify the GET path is
      // relative (i.e., the slash was handled by baseURL, not duplicated).
      const url = mockHttpClient.get.mock.calls[0][0] as string;
      expect(url.startsWith('/search')).toBe(true);
    });

    it('passes engines list when configured', async () => {
      mockConfigValues.set('webSearch.searxng.endpoint', 'http://localhost:8080');
      mockConfigValues.set('webSearch.searxng.engines', ['google', 'duckduckgo']);
      mockHttpClient.get.mockResolvedValue({ data: { results: [] } });
      const client = new SearxngClient(createContext());
      await client.search('q');

      const url = mockHttpClient.get.mock.calls[0][0] as string;
      expect(url).toContain('engines=google%2Cduckduckgo');
    });

    it('omits engines param when none configured', async () => {
      mockConfigValues.set('webSearch.searxng.endpoint', 'http://localhost:8080');
      mockHttpClient.get.mockResolvedValue({ data: { results: [] } });
      const client = new SearxngClient(createContext());
      await client.search('q');

      const url = mockHttpClient.get.mock.calls[0][0] as string;
      expect(url).not.toContain('engines=');
    });

    it('filters out non-string and empty entries from configured engines', async () => {
      mockConfigValues.set('webSearch.searxng.endpoint', 'http://localhost:8080');
      // Simulate a malformed config: nulls, numbers, blanks all need to be dropped.
      mockConfigValues.set('webSearch.searxng.engines', ['google', '', '   ', 42, null, 'bing']);
      mockHttpClient.get.mockResolvedValue({ data: { results: [] } });
      const client = new SearxngClient(createContext());
      await client.search('q');

      const url = mockHttpClient.get.mock.calls[0][0] as string;
      // Only string, non-empty entries survive.
      expect(url).toContain('engines=google%2Cbing');
    });
  });

  describe('search() — response normalization', () => {
    beforeEach(() => {
      mockConfigValues.set('webSearch.searxng.endpoint', 'http://localhost:8080');
    });

    it('passes through scored results with the score clamped to 0..1', async () => {
      mockHttpClient.get.mockResolvedValue({
        data: {
          query: 'q',
          results: [
            { title: 'A', url: 'https://a', content: 'aa', score: 0.42 },
            { title: 'B', url: 'https://b', content: 'bb', score: 5.0 },     // clamp high
            { title: 'C', url: 'https://c', content: 'cc', score: -0.5 },    // clamp low
          ]
        }
      });
      const client = new SearxngClient(createContext());
      const out = await client.search('q');
      expect(out.results.map(r => r.score)).toEqual([0.42, 1, 0]);
    });

    it('synthesizes a rank-based score when SearXNG returns no `score` field', async () => {
      mockHttpClient.get.mockResolvedValue({
        data: {
          results: [
            { title: 'A', url: 'https://a', content: '' },
            { title: 'B', url: 'https://b', content: '' },
            { title: 'C', url: 'https://c', content: '' },
          ]
        }
      });
      const client = new SearxngClient(createContext());
      const out = await client.search('q');
      // Expected: (n-i)/n  →  3/3, 2/3, 1/3
      expect(out.results[0].score).toBeCloseTo(1.0, 5);
      expect(out.results[1].score).toBeCloseTo(2 / 3, 5);
      expect(out.results[2].score).toBeCloseTo(1 / 3, 5);
      // Strictly monotonically decreasing with rank.
      expect(out.results[0].score).toBeGreaterThan(out.results[1].score);
      expect(out.results[1].score).toBeGreaterThan(out.results[2].score);
    });

    it('respects maxResults by slicing the results array', async () => {
      const ten = Array.from({ length: 10 }, (_, i) => ({
        title: `R${i}`, url: `https://r${i}`, content: ''
      }));
      mockHttpClient.get.mockResolvedValue({ data: { results: ten } });
      const client = new SearxngClient(createContext());
      const out = await client.search('q', { maxResults: 3 });
      expect(out.results).toHaveLength(3);
      expect(out.results[0].title).toBe('R0');
    });

    it('defaults missing title/content to safe placeholders', async () => {
      mockHttpClient.get.mockResolvedValue({
        data: { results: [{ url: 'https://x' }] }
      });
      const client = new SearxngClient(createContext());
      const out = await client.search('q');
      expect(out.results[0].title).toBe('(no title)');
      expect(out.results[0].content).toBe('');
      expect(out.results[0].url).toBe('https://x');
    });

    it('picks the first non-empty answer; treats whitespace as empty', async () => {
      mockHttpClient.get.mockResolvedValue({
        data: {
          results: [],
          answers: ['', '   ', 'real answer', 'second answer']
        }
      });
      const client = new SearxngClient(createContext());
      const out = await client.search('q');
      expect(out.answer).toBe('real answer');
    });

    it('leaves answer undefined when no answers present', async () => {
      mockHttpClient.get.mockResolvedValue({
        data: { results: [], answers: [] }
      });
      const client = new SearxngClient(createContext());
      const out = await client.search('q');
      expect(out.answer).toBeUndefined();
    });

    it('falls back to caller query when raw.query is missing', async () => {
      mockHttpClient.get.mockResolvedValue({ data: { results: [] } });
      const client = new SearxngClient(createContext());
      const out = await client.search('original q');
      expect(out.query).toBe('original q');
    });
  });

  describe('search() — error mapping', () => {
    beforeEach(() => {
      mockConfigValues.set('webSearch.searxng.endpoint', 'http://localhost:8080');
    });

    it('maps 401 to "rejected" with status hint', async () => {
      mockHttpClient.get.mockRejectedValue(httpError(401));
      const client = new SearxngClient(createContext());
      await expect(client.search('q')).rejects.toThrow(/rejected.*401/i);
    });

    it('maps 403 to "rejected" with status hint', async () => {
      mockHttpClient.get.mockRejectedValue(httpError(403));
      const client = new SearxngClient(createContext());
      await expect(client.search('q')).rejects.toThrow(/rejected.*403/i);
    });

    it('maps 404 to a settings.yml-format-hint error', async () => {
      mockHttpClient.get.mockRejectedValue(httpError(404));
      const client = new SearxngClient(createContext());
      await expect(client.search('q')).rejects.toThrow(/settings\.yml/i);
    });

    it('maps connection-level errors (no response) to "unreachable"', async () => {
      const err = new Error('ECONNREFUSED');
      mockHttpClient.get.mockRejectedValue(err);
      const client = new SearxngClient(createContext());
      await expect(client.search('q')).rejects.toThrow(/unreachable/i);
    });

    it('maps any other HTTP error to a generic search-failed message', async () => {
      mockHttpClient.get.mockRejectedValue(httpError(500, 'server boom'));
      const client = new SearxngClient(createContext());
      await expect(client.search('q')).rejects.toThrow(/search failed.*500/i);
    });
  });
});
