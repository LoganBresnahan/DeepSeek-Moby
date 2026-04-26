/**
 * Unit tests for WebSearchProviderRegistry.
 *
 * The registry is the single point of dispatch for web search — `webSearchManager`
 * doesn't know whether the active provider is Tavily or SearXNG. These tests
 * lock in:
 *   - active() resolves to the configured provider
 *   - unknown / unset config falls back to the default (tavily)
 *   - activeId() agrees with active()
 *   - getConfiguredStatus() reports per-provider configuration
 *   - typed accessors (getTavilyClient/getSearxngClient) return the right instance
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockConfigValues, mockTavily, mockSearxng } = vi.hoisted(() => ({
  mockConfigValues: new Map<string, any>(),
  mockTavily: { id: 'tavily' as const, isConfigured: vi.fn(async () => true), search: vi.fn() },
  mockSearxng: { id: 'searxng' as const, isConfigured: vi.fn(async () => false), search: vi.fn() }
}));

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: vi.fn((key: string) => mockConfigValues.get(key))
    }))
  }
}));

vi.mock('../../../src/clients/tavilyClient', () => ({
  TavilyClient: vi.fn(() => mockTavily)
}));
vi.mock('../../../src/clients/searxngClient', () => ({
  SearxngClient: vi.fn(() => mockSearxng)
}));

import {
  WebSearchProviderRegistry,
  DEFAULT_WEB_SEARCH_PROVIDER
} from '../../../src/clients/webSearchProviderRegistry';

function createContext() {
  return { secrets: { get: vi.fn() }, subscriptions: [] } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockConfigValues.clear();
  mockTavily.isConfigured.mockResolvedValue(true);
  mockSearxng.isConfigured.mockResolvedValue(false);
});

describe('WebSearchProviderRegistry', () => {
  describe('default routing', () => {
    it('defaults to tavily when nothing configured', () => {
      const reg = new WebSearchProviderRegistry(createContext());
      expect(reg.activeId()).toBe(DEFAULT_WEB_SEARCH_PROVIDER);
      expect(reg.activeId()).toBe('tavily');
      expect(reg.active()).toBe(mockTavily);
    });

    it('falls back to default for an unknown provider id', () => {
      mockConfigValues.set('webSearch.provider', 'bing'); // not registered
      const reg = new WebSearchProviderRegistry(createContext());
      expect(reg.activeId()).toBe('tavily');
      expect(reg.active()).toBe(mockTavily);
    });

    it('falls back to default for non-string config values', () => {
      mockConfigValues.set('webSearch.provider', 42 as any);
      const reg = new WebSearchProviderRegistry(createContext());
      expect(reg.activeId()).toBe('tavily');
    });
  });

  describe('explicit selection', () => {
    it('routes to searxng when configured', () => {
      mockConfigValues.set('webSearch.provider', 'searxng');
      const reg = new WebSearchProviderRegistry(createContext());
      expect(reg.activeId()).toBe('searxng');
      expect(reg.active()).toBe(mockSearxng);
    });

    it('routes to tavily when explicitly configured', () => {
      mockConfigValues.set('webSearch.provider', 'tavily');
      const reg = new WebSearchProviderRegistry(createContext());
      expect(reg.activeId()).toBe('tavily');
      expect(reg.active()).toBe(mockTavily);
    });

    it('re-reads config on every active() call (not cached)', () => {
      const reg = new WebSearchProviderRegistry(createContext());
      mockConfigValues.set('webSearch.provider', 'tavily');
      expect(reg.activeId()).toBe('tavily');
      mockConfigValues.set('webSearch.provider', 'searxng');
      expect(reg.activeId()).toBe('searxng');
    });
  });

  describe('typed accessors', () => {
    it('getTavilyClient returns the tavily instance regardless of active provider', () => {
      mockConfigValues.set('webSearch.provider', 'searxng');
      const reg = new WebSearchProviderRegistry(createContext());
      expect(reg.getTavilyClient()).toBe(mockTavily);
    });

    it('getSearxngClient returns the searxng instance regardless of active provider', () => {
      mockConfigValues.set('webSearch.provider', 'tavily');
      const reg = new WebSearchProviderRegistry(createContext());
      expect(reg.getSearxngClient()).toBe(mockSearxng);
    });
  });

  describe('getConfiguredStatus', () => {
    it('returns one entry per registered provider with their isConfigured() result', async () => {
      mockTavily.isConfigured.mockResolvedValue(true);
      mockSearxng.isConfigured.mockResolvedValue(false);
      const reg = new WebSearchProviderRegistry(createContext());
      const status = await reg.getConfiguredStatus();
      expect(status).toEqual({ tavily: true, searxng: false });
    });

    it('reflects updated provider configuration on each call', async () => {
      const reg = new WebSearchProviderRegistry(createContext());

      mockTavily.isConfigured.mockResolvedValue(false);
      mockSearxng.isConfigured.mockResolvedValue(true);
      const after = await reg.getConfiguredStatus();
      expect(after).toEqual({ tavily: false, searxng: true });
    });
  });
});
