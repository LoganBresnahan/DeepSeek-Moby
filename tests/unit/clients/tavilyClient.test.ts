/**
 * Unit tests for TavilyClient
 *
 * Tests API key handling, search requests, error mapping, and usage tracking.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mock state ──────────────────────────────────────────────

const { mockHttpClient, mockSecrets, mockConfigValues } = vi.hoisted(() => ({
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
  mockConfigValues: new Map<string, any>([
    ['tavilySearchDepth', 'basic']
  ])
}));

// ── Module mocks ────────────────────────────────────────────────────

vi.mock('../../../src/utils/httpClient', () => ({
  HttpClient: vi.fn(() => mockHttpClient),
  HttpError: class HttpError extends Error {
    response?: { status: number; statusText: string; data: unknown };
    code?: string;
  }
}));

vi.mock('../../../src/utils/config', () => ({
  ConfigManager: {
    getInstance: vi.fn(() => ({
      get: vi.fn((key: string) => mockConfigValues.get(key))
    }))
  }
}));

vi.mock('../../../src/utils/logger', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

vi.mock('../../../src/tracing', () => ({
  tracer: { event: vi.fn(), setLogOutput: vi.fn() }
}));

import { TavilyClient } from '../../../src/clients/tavilyClient';
import type { TavilyUsageStats } from '../../../src/clients/tavilyClient';

// ── Helpers ─────────────────────────────────────────────────────────

function createContext() {
  return {
    secrets: mockSecrets,
    subscriptions: [],
    extensionPath: '/test',
    extensionUri: { fsPath: '/test' },
    globalState: { get: vi.fn(), update: vi.fn(), keys: vi.fn(() => []) },
    workspaceState: { get: vi.fn(), update: vi.fn(), keys: vi.fn(() => []) },
    storagePath: '/tmp/storage',
    globalStoragePath: '/tmp/global-storage',
    logPath: '/tmp/log'
  } as any;
}

function createHttpError(status: number, message: string) {
  const err: any = new Error(message);
  err.response = { status, statusText: message, data: {} };
  return err;
}

// ── Tests ───────────────────────────────────────────────────────────

describe('TavilyClient', () => {
  let client: TavilyClient;
  let savedTavilyKey: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    // Clear env var so isConfigured() tests aren't affected by real config
    savedTavilyKey = process.env.TAVILY_API_KEY;
    delete process.env.TAVILY_API_KEY;
    mockSecrets.get.mockResolvedValue('tvly-test-key-123');
    mockConfigValues.set('tavilySearchDepth', 'basic');
    client = new TavilyClient(createContext());
  });

  afterEach(() => {
    // Restore env var
    if (savedTavilyKey !== undefined) {
      process.env.TAVILY_API_KEY = savedTavilyKey;
    }
  });

  // ── isConfigured ─────────────────────────────────────────────────

  describe('isConfigured()', () => {
    it('returns true when API key is set', async () => {
      mockSecrets.get.mockResolvedValue('tvly-key');
      expect(await client.isConfigured()).toBe(true);
    });

    it('returns false when API key is not set', async () => {
      mockSecrets.get.mockResolvedValue(undefined);
      expect(await client.isConfigured()).toBe(false);
    });

    it('returns false when API key is empty string', async () => {
      mockSecrets.get.mockResolvedValue('');
      expect(await client.isConfigured()).toBe(false);
    });

    it('returns false when API key is whitespace only', async () => {
      mockSecrets.get.mockResolvedValue('   ');
      expect(await client.isConfigured()).toBe(false);
    });

    it('checks the correct secret key name', async () => {
      await client.isConfigured();
      expect(mockSecrets.get).toHaveBeenCalledWith('moby.tavilyApiKey');
    });
  });

  // ── search ───────────────────────────────────────────────────────

  describe('search()', () => {
    it('makes POST to /search with correct payload', async () => {
      mockHttpClient.post.mockResolvedValue({
        data: {
          results: [{ title: 'Test', url: 'https://example.com', content: 'Hello', score: 0.9 }],
          answer: 'The answer',
          query: 'test query',
          response_time: 1.5
        }
      });

      const result = await client.search('test query');

      expect(mockHttpClient.post).toHaveBeenCalledWith('/search', {
        api_key: 'tvly-test-key-123',
        query: 'test query',
        search_depth: 'basic',
        include_answer: true,
        max_results: 5
      });

      expect(result.results).toHaveLength(1);
      expect(result.results[0].title).toBe('Test');
      expect(result.answer).toBe('The answer');
      expect(result.query).toBe('test query');
      expect(result.responseTime).toBe(1.5);
    });

    it('uses custom searchDepth from options', async () => {
      mockHttpClient.post.mockResolvedValue({ data: { results: [] } });

      await client.search('query', { searchDepth: 'advanced' });

      expect(mockHttpClient.post).toHaveBeenCalledWith('/search',
        expect.objectContaining({ search_depth: 'advanced' })
      );
    });

    it('uses custom maxResults from options', async () => {
      mockHttpClient.post.mockResolvedValue({ data: { results: [] } });

      await client.search('query', { maxResults: 10 });

      expect(mockHttpClient.post).toHaveBeenCalledWith('/search',
        expect.objectContaining({ max_results: 10 })
      );
    });

    it('falls back to config searchDepth when no option provided', async () => {
      mockConfigValues.set('tavilySearchDepth', 'advanced');
      client = new TavilyClient(createContext());
      mockHttpClient.post.mockResolvedValue({ data: { results: [] } });

      await client.search('query');

      expect(mockHttpClient.post).toHaveBeenCalledWith('/search',
        expect.objectContaining({ search_depth: 'advanced' })
      );
    });

    it('handles missing fields in response gracefully', async () => {
      mockHttpClient.post.mockResolvedValue({
        data: {}
      });

      const result = await client.search('query');

      expect(result.results).toEqual([]);
      expect(result.answer).toBeUndefined();
      expect(result.query).toBe('query');
      expect(result.responseTime).toBe(0);
    });

    it('throws user-friendly error on 401', async () => {
      mockHttpClient.post.mockRejectedValue(createHttpError(401, 'Unauthorized'));

      await expect(client.search('query')).rejects.toThrow('Invalid Tavily API key');
    });

    it('throws user-friendly error on 429', async () => {
      mockHttpClient.post.mockRejectedValue(createHttpError(429, 'Too Many Requests'));

      await expect(client.search('query')).rejects.toThrow('rate limit exceeded');
    });

    it('throws wrapped error on network failure', async () => {
      const networkError: any = new Error('ECONNREFUSED');
      networkError.response = undefined;
      mockHttpClient.post.mockRejectedValue(networkError);

      await expect(client.search('query')).rejects.toThrow('Tavily search failed: ECONNREFUSED');
    });

    it('throws when no API key is configured', async () => {
      mockSecrets.get.mockResolvedValue(undefined);
      client = new TavilyClient(createContext());

      await expect(client.search('query')).rejects.toThrow('Tavily API key is not configured');
    });
  });

  // ── Usage tracking ───────────────────────────────────────────────

  describe('usage tracking', () => {
    it('tracks basic search as 1 credit', async () => {
      mockHttpClient.post.mockResolvedValue({ data: { results: [] } });
      mockConfigValues.set('tavilySearchDepth', 'basic');
      client = new TavilyClient(createContext());

      await client.search('query');

      const stats = client.getUsageStats();
      expect(stats.totalSearches).toBe(1);
      expect(stats.basicSearches).toBe(1);
      expect(stats.advancedSearches).toBe(0);
      expect(stats.totalCreditsUsed).toBe(1);
    });

    it('tracks advanced search as 2 credits', async () => {
      mockHttpClient.post.mockResolvedValue({ data: { results: [] } });

      await client.search('query', { searchDepth: 'advanced' });

      const stats = client.getUsageStats();
      expect(stats.totalSearches).toBe(1);
      expect(stats.basicSearches).toBe(0);
      expect(stats.advancedSearches).toBe(1);
      expect(stats.totalCreditsUsed).toBe(2);
    });

    it('accumulates across multiple searches', async () => {
      mockHttpClient.post.mockResolvedValue({ data: { results: [] } });

      await client.search('q1'); // basic = 1 credit
      await client.search('q2', { searchDepth: 'advanced' }); // advanced = 2 credits
      await client.search('q3'); // basic = 1 credit

      const stats = client.getUsageStats();
      expect(stats.totalSearches).toBe(3);
      expect(stats.basicSearches).toBe(2);
      expect(stats.advancedSearches).toBe(1);
      expect(stats.totalCreditsUsed).toBe(4);
    });
  });

  // ── getUsageStats ────────────────────────────────────────────────

  describe('getUsageStats()', () => {
    it('returns a copy (not a reference)', async () => {
      const stats1 = client.getUsageStats();
      stats1.totalSearches = 999;

      const stats2 = client.getUsageStats();
      expect(stats2.totalSearches).toBe(0);
    });

    it('returns zeroed stats initially', () => {
      const stats = client.getUsageStats();
      expect(stats).toEqual({
        totalSearches: 0,
        basicSearches: 0,
        advancedSearches: 0,
        totalCreditsUsed: 0
      });
    });
  });

  // ── resetUsageStats ──────────────────────────────────────────────

  describe('resetUsageStats()', () => {
    it('clears all accumulated stats', async () => {
      mockHttpClient.post.mockResolvedValue({ data: { results: [] } });

      await client.search('query');
      expect(client.getUsageStats().totalSearches).toBe(1);

      client.resetUsageStats();

      const stats = client.getUsageStats();
      expect(stats).toEqual({
        totalSearches: 0,
        basicSearches: 0,
        advancedSearches: 0,
        totalCreditsUsed: 0
      });
    });
  });

  // ── getApiUsage ──────────────────────────────────────────────────

  describe('getApiUsage()', () => {
    it('calls GET /usage with bearer token', async () => {
      mockHttpClient.get.mockResolvedValue({
        data: {
          key: { limit: 1000, usage: 42 },
          account: { current_plan: 'Researcher' }
        }
      });

      const usage = await client.getApiUsage();

      expect(mockHttpClient.get).toHaveBeenCalledWith('/usage', {
        headers: { Authorization: 'Bearer tvly-test-key-123' }
      });
      expect(usage.remaining).toBe(958);
      expect(usage.limit).toBe(1000);
      expect(usage.used).toBe(42);
      expect(usage.plan).toBe('Researcher');
    });

    it('handles missing key/account data', async () => {
      mockHttpClient.get.mockResolvedValue({ data: {} });

      const usage = await client.getApiUsage();

      expect(usage.remaining).toBeNull();
      expect(usage.limit).toBeNull();
      expect(usage.plan).toBe('Unknown');
      expect(usage.used).toBe(0);
    });

    it('throws on 401', async () => {
      mockHttpClient.get.mockRejectedValue(createHttpError(401, 'Unauthorized'));

      await expect(client.getApiUsage()).rejects.toThrow('Invalid Tavily API key');
    });

    it('throws wrapped error on other failures', async () => {
      const err: any = new Error('timeout');
      err.response = undefined;
      mockHttpClient.get.mockRejectedValue(err);

      await expect(client.getApiUsage()).rejects.toThrow('Failed to fetch Tavily usage: timeout');
    });
  });
});
