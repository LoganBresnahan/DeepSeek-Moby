import { describe, it, expect, vi, beforeEach } from 'vitest';

// The default __mocks__/vscode.ts EventEmitter uses vi.fn() stubs that don't
// wire event→fire. We need real subscriptions for testing event-driven classes.
// Use vi.hoisted so the class is defined before the vi.mock factory runs.
const { WorkingEventEmitter } = vi.hoisted(() => ({
  WorkingEventEmitter: class WorkingEventEmitter {
    private _listeners: Array<(e: any) => void> = [];
    event = (listener: (e: any) => void) => {
      this._listeners.push(listener);
      return { dispose: () => { this._listeners = this._listeners.filter(l => l !== listener); } };
    };
    fire = (data: any) => { for (const l of this._listeners) l(data); };
    dispose = () => { this._listeners = []; };
  }
}));

vi.mock('vscode', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return { ...original, EventEmitter: WorkingEventEmitter };
});

import { WebSearchManager } from '../../../src/providers/webSearchManager';
import type { SearchProgress } from '../../../src/providers/webSearchManager';

// ── TavilyClient mock ──
function createMockTavilyClient(configured = true) {
  return {
    id: 'tavily' as const,
    isConfigured: vi.fn(async () => configured),
    search: vi.fn(async (query: string, _options?: any) => ({
      results: [
        { title: 'Result 1', url: 'https://example.com/1', content: 'Content for result 1', score: 0.95 },
        { title: 'Result 2', url: 'https://example.com/2', content: 'Content for result 2', score: 0.85 },
      ],
      answer: 'Summary answer',
      query,
      responseTime: 150
    })),
    getApiUsage: vi.fn(),
    getUsageStats: vi.fn(),
    resetUsageStats: vi.fn(),
  };
}

// ── Registry mock ──
// WebSearchManager now dispatches through a WebSearchProviderRegistry rather
// than holding a direct TavilyClient reference. Tests wrap the mock Tavily
// in a minimal registry surface that returns it from active().
function createMockRegistry(tavily: ReturnType<typeof createMockTavilyClient>) {
  return {
    active: () => tavily,
    getTavilyClient: () => tavily
  };
}

describe('WebSearchManager', () => {
  let manager: WebSearchManager;
  let mockTavily: ReturnType<typeof createMockTavilyClient>;

  beforeEach(() => {
    mockTavily = createMockTavilyClient();
    manager = new WebSearchManager(createMockRegistry(mockTavily) as any);
  });

  // ── setMode / getMode ──

  describe('setMode / getMode', () => {
    it('should default to auto mode', () => {
      expect(manager.getMode()).toBe('auto');
    });

    it('should change mode and fire onModeChanged', () => {
      const events: Array<{ mode: string }> = [];
      manager.onModeChanged(e => events.push(e));

      manager.setMode('manual');

      expect(manager.getMode()).toBe('manual');
      expect(events).toEqual([{ mode: 'manual' }]);
    });

    it('should not fire event when setting same mode', () => {
      const events: Array<{ mode: string }> = [];
      manager.onModeChanged(e => events.push(e));

      manager.setMode('auto'); // already auto

      expect(events).toHaveLength(0);
    });

    it('should disable manual toggle when switching to off', async () => {
      await manager.toggle(true); // enable first
      expect(manager.isEnabled).toBe(true);

      const toggleEvents: Array<{ enabled: boolean }> = [];
      manager.onToggled(e => toggleEvents.push(e));

      manager.setMode('off');

      expect(manager.isEnabled).toBe(false);
      expect(toggleEvents).toEqual([{ enabled: false }]);
    });

    it('should not fire onToggled when switching to off if already disabled', () => {
      expect(manager.isEnabled).toBe(false);
      const toggleEvents: Array<{ enabled: boolean }> = [];
      manager.onToggled(e => toggleEvents.push(e));

      manager.setMode('off');

      expect(toggleEvents).toHaveLength(0);
    });

    it('should cycle through all modes', () => {
      const events: Array<{ mode: string }> = [];
      manager.onModeChanged(e => events.push(e));

      manager.setMode('manual');
      manager.setMode('off');
      manager.setMode('auto');

      expect(events).toEqual([
        { mode: 'manual' },
        { mode: 'off' },
        { mode: 'auto' }
      ]);
    });
  });

  // ── toggle ──

  describe('toggle', () => {
    it('should enable web search and fire onToggled', async () => {
      const events: Array<{ enabled: boolean }> = [];
      manager.onToggled(e => events.push(e));

      await manager.toggle(true);

      expect(manager.isEnabled).toBe(true);
      expect(events).toEqual([{ enabled: true }]);
    });

    it('should disable web search and fire onToggled', async () => {
      await manager.toggle(true); // enable first
      const events: Array<{ enabled: boolean }> = [];
      manager.onToggled(e => events.push(e));

      await manager.toggle(false);

      expect(manager.isEnabled).toBe(false);
      expect(events).toEqual([{ enabled: false }]);
    });

    it('should reject toggle when mode is off', async () => {
      manager.setMode('off');
      const toggleEvents: Array<{ enabled: boolean }> = [];
      manager.onToggled(e => toggleEvents.push(e));

      await manager.toggle(true);

      expect(manager.isEnabled).toBe(false);
      expect(toggleEvents).toEqual([{ enabled: false }]);
    });

    it('should reject toggle when API key not configured', async () => {
      mockTavily.isConfigured.mockResolvedValue(false);
      const toggleEvents: Array<{ enabled: boolean }> = [];
      const errorEvents: Array<{ message: string }> = [];
      manager.onToggled(e => toggleEvents.push(e));
      manager.onSearchError(e => errorEvents.push(e));

      await manager.toggle(true);

      expect(manager.isEnabled).toBe(false);
      expect(toggleEvents).toEqual([{ enabled: false }]);
      expect(errorEvents).toHaveLength(1);
      expect(errorEvents[0].message).toContain('Tavily API key not configured');
    });
  });

  // ── updateSettings ──

  describe('updateSettings', () => {
    it('should update partial settings and fire onSettingsChanged', async () => {
      const events: void[] = [];
      manager.onSettingsChanged(() => events.push(undefined));

      manager.updateSettings({ searchDepth: 'advanced' });

      expect((await manager.getSettings()).settings.searchDepth).toBe('advanced');
      expect(events).toHaveLength(1);
    });

    it('should update multiple fields at once', async () => {
      manager.updateSettings({
        searchDepth: 'advanced',
        cacheDuration: 30,
        creditsPerPrompt: 4,
        maxResultsPerSearch: 15
      });

      const { settings } = await manager.getSettings();
      expect(settings.searchDepth).toBe('advanced');
      expect(settings.cacheDuration).toBe(30);
      expect(settings.creditsPerPrompt).toBe(4);
      expect(settings.maxResultsPerSearch).toBe(15);
    });

    it('should not fire event when no fields provided', () => {
      const events: void[] = [];
      manager.onSettingsChanged(() => events.push(undefined));

      manager.updateSettings({});

      expect(events).toHaveLength(0);
    });
  });

  // ── getSettings ──

  describe('getSettings', () => {
    it('should return current state with new defaults', async () => {
      const result = await manager.getSettings();

      expect(result.enabled).toBe(false);
      expect(result.configured).toBe(true);
      expect(result.mode).toBe('auto');
      expect(result.settings.searchDepth).toBe('basic');
      expect(result.settings.cacheDuration).toBe(15);
      expect(result.settings.creditsPerPrompt).toBe(1);
      expect(result.settings.maxResultsPerSearch).toBe(5);
    });

    it('should reflect current mode in getSettings', async () => {
      manager.setMode('manual');
      const result = await manager.getSettings();
      expect(result.mode).toBe('manual');

      manager.setMode('off');
      const result2 = await manager.getSettings();
      expect(result2.mode).toBe('off');
    });

    it('should return a copy of settings (not a reference)', async () => {
      const result1 = await manager.getSettings();
      result1.settings.cacheDuration = 999;

      const result2 = await manager.getSettings();
      expect(result2.settings.cacheDuration).toBe(15);
    });
  });

  // ── clearCache ──

  describe('clearCache', () => {
    it('should clear cached search results', async () => {
      // Populate cache by searching
      await manager.toggle(true);
      await manager.searchForMessage('test query');
      expect(mockTavily.search).toHaveBeenCalledTimes(1);

      // Search again — should use cache
      await manager.searchForMessage('test query');
      expect(mockTavily.search).toHaveBeenCalledTimes(1); // not called again

      // Clear cache and search again — should re-fetch
      manager.clearCache();
      await manager.searchForMessage('test query');
      expect(mockTavily.search).toHaveBeenCalledTimes(2);
    });
  });

  // ── searchForMessage ──

  describe('searchForMessage', () => {
    it('should return empty string when mode is off', async () => {
      manager.setMode('off');
      // Even if we somehow had it enabled before, mode=off should block
      const result = await manager.searchForMessage('hello');

      expect(result).toBe('');
      expect(mockTavily.search).not.toHaveBeenCalled();
    });

    it('should return empty string when disabled', async () => {
      const result = await manager.searchForMessage('hello');

      expect(result).toBe('');
      expect(mockTavily.search).not.toHaveBeenCalled();
    });

    it('should return empty string when not configured', async () => {
      mockTavily.isConfigured.mockResolvedValue(false);
      // Force enable without going through toggle (which would reject)
      await manager.toggle(true); // will be rejected
      const result = await manager.searchForMessage('hello');

      expect(result).toBe('');
      expect(mockTavily.search).not.toHaveBeenCalled();
    });

    it('should fetch from Tavily and return formatted results', async () => {
      await manager.toggle(true);
      const searchingEvents: SearchProgress[] = [];
      const completeEvents: Array<{ context: string }> = [];
      manager.onSearching(e => searchingEvents.push(e));
      manager.onSearchComplete(e => completeEvents.push(e));

      const result = await manager.searchForMessage('test query');

      expect(mockTavily.search).toHaveBeenCalledWith('test query', { searchDepth: 'basic', maxResults: 5 });
      expect(result).toContain('Result 1');
      expect(result).toContain('Summary answer');
      // Progress: initial (0/1) + completion (1/1) = 2 events
      expect(searchingEvents).toHaveLength(2);
      expect(searchingEvents[0]).toEqual({ current: 0, total: 1 });
      expect(searchingEvents[1]).toEqual({ current: 1, total: 1 });
      expect(completeEvents).toHaveLength(1);
    });

    it('should use cached results on second call', async () => {
      await manager.toggle(true);

      await manager.searchForMessage('test query');
      const cachedEvents: void[] = [];
      manager.onSearchCached(() => cachedEvents.push(undefined));

      const result = await manager.searchForMessage('test query');

      expect(mockTavily.search).toHaveBeenCalledTimes(1); // only called once
      expect(result).toContain('Result 1');
      expect(cachedEvents).toHaveLength(1);
    });

    it('should treat cache keys case-insensitively', async () => {
      await manager.toggle(true);

      await manager.searchForMessage('Test Query');
      await manager.searchForMessage('test query');

      expect(mockTavily.search).toHaveBeenCalledTimes(1);
    });

    it('should re-fetch when cache expires', async () => {
      await manager.toggle(true);
      // Set very short cache duration
      manager.updateSettings({ cacheDuration: 0 }); // 0 minutes = always expired

      await manager.searchForMessage('test query');
      await manager.searchForMessage('test query');

      expect(mockTavily.search).toHaveBeenCalledTimes(2);
    });

    it('should fire onSearchError and return empty on API failure', async () => {
      await manager.toggle(true);
      mockTavily.search.mockRejectedValueOnce(new Error('Rate limit exceeded'));
      const errorEvents: Array<{ message: string }> = [];
      manager.onSearchError(e => errorEvents.push(e));

      const result = await manager.searchForMessage('test query');

      expect(result).toBe('');
      expect(errorEvents).toEqual([{ message: 'Rate limit exceeded' }]);
    });

    it('should use advanced search depth when configured', async () => {
      await manager.toggle(true);
      manager.updateSettings({ searchDepth: 'advanced', creditsPerPrompt: 2 });

      await manager.searchForMessage('test query');

      expect(mockTavily.search).toHaveBeenCalledWith('test query', { searchDepth: 'advanced', maxResults: 5 });
    });

    it('should pass maxResults to TavilyClient', async () => {
      await manager.toggle(true);
      manager.updateSettings({ maxResultsPerSearch: 15 });

      await manager.searchForMessage('test query');

      expect(mockTavily.search).toHaveBeenCalledWith('test query', { searchDepth: 'basic', maxResults: 15 });
    });

    it('should make multiple API calls based on credits (basic)', async () => {
      await manager.toggle(true);
      manager.updateSettings({ creditsPerPrompt: 3 }); // basic = 1 credit/call => 3 calls

      await manager.searchForMessage('test query');

      expect(mockTavily.search).toHaveBeenCalledTimes(3);
    });

    it('should make multiple API calls based on credits (advanced)', async () => {
      await manager.toggle(true);
      manager.updateSettings({ creditsPerPrompt: 6, searchDepth: 'advanced' }); // advanced = 2 credits/call => 3 calls

      await manager.searchForMessage('test query');

      expect(mockTavily.search).toHaveBeenCalledTimes(3);
    });

    it('should fire onSearching with progress for multi-call', async () => {
      await manager.toggle(true);
      manager.updateSettings({ creditsPerPrompt: 2 }); // 2 calls
      const progressEvents: SearchProgress[] = [];
      manager.onSearching(e => progressEvents.push(e));

      await manager.searchForMessage('test query');

      // Initial event (0/2) + two completion events (1/2, 2/2) = 3 events
      expect(progressEvents).toHaveLength(3);
      expect(progressEvents[0]).toEqual({ current: 0, total: 2 });
    });

    it('should use settings-aware cache key', async () => {
      await manager.toggle(true);
      await manager.searchForMessage('test query');
      expect(mockTavily.search).toHaveBeenCalledTimes(1);

      // Same query, different settings — should NOT use cache
      manager.updateSettings({ maxResultsPerSearch: 10 });
      await manager.searchForMessage('test query');
      expect(mockTavily.search).toHaveBeenCalledTimes(2);
    });

    it('should handle partial failures with Promise.allSettled', async () => {
      await manager.toggle(true);
      manager.updateSettings({ creditsPerPrompt: 3 }); // 3 calls

      let callCount = 0;
      mockTavily.search.mockImplementation(async (query: string) => {
        callCount++;
        if (callCount === 2) throw new Error('Temporary failure');
        return {
          results: [{ title: `Result ${callCount}`, url: `https://example.com/${callCount}`, content: `Content ${callCount}`, score: 0.9 }],
          answer: 'Summary',
          query,
          responseTime: 100
        };
      });

      const result = await manager.searchForMessage('test query');

      // Should still return results from the 2 successful calls
      expect(result).toContain('Result');
      expect(result).not.toBe('');
    });
  });

  // ── formatSearchResults ──

  describe('formatSearchResults', () => {
    it('should format results with title, URL, and content', () => {
      const result = manager.formatSearchResults({
        results: [
          { title: 'Test Page', url: 'https://test.com', content: 'Test content here', score: 0.9 }
        ],
        query: 'my query',
        responseTime: 100
      });

      expect(result).toContain('Web search results for: "my query"');
      expect(result).toContain('**Test Page**');
      expect(result).toContain('URL: https://test.com');
      expect(result).toContain('Test content here');
    });

    it('should include summary when present', () => {
      const result = manager.formatSearchResults({
        results: [],
        answer: 'Quick summary',
        query: 'my query',
        responseTime: 100
      });

      expect(result).toContain('Summary: Quick summary');
    });

    it('should truncate long content at 500 chars', () => {
      const longContent = 'x'.repeat(600);
      const result = manager.formatSearchResults({
        results: [
          { title: 'Long', url: 'https://test.com', content: longContent, score: 0.9 }
        ],
        query: 'q',
        responseTime: 100
      });

      expect(result).toContain('...');
      // Should not contain full 600 chars
      expect(result.length).toBeLessThan(longContent.length + 200);
    });

    it('should limit to 5 results', () => {
      const results = Array.from({ length: 10 }, (_, i) => ({
        title: `Result ${i}`,
        url: `https://test.com/${i}`,
        content: `Content ${i}`,
        score: 0.9 - i * 0.05
      }));

      const formatted = manager.formatSearchResults({
        results,
        query: 'q',
        responseTime: 100
      });

      expect(formatted).toContain('Result 0');
      expect(formatted).toContain('Result 4');
      expect(formatted).not.toContain('Result 5');
    });
  });

  // ── formatMultiSearchResults ──

  describe('formatMultiSearchResults', () => {
    it('should format single response same as formatSearchResults', () => {
      const response = {
        results: [{ title: 'A', url: 'https://a.com', content: 'text', score: 0.9 }],
        query: 'q',
        responseTime: 100
      };
      expect(manager.formatMultiSearchResults([response])).toBe(manager.formatSearchResults(response));
    });

    it('should return empty string for empty array', () => {
      expect(manager.formatMultiSearchResults([])).toBe('');
    });

    it('should deduplicate results by URL keeping highest score', () => {
      const r1 = { results: [{ title: 'A v1', url: 'https://a.com', content: 'version 1', score: 0.8 }], query: 'q', responseTime: 100 };
      const r2 = { results: [{ title: 'A v2', url: 'https://a.com', content: 'version 2', score: 0.95 }], query: 'q', responseTime: 100 };

      const result = manager.formatMultiSearchResults([r1, r2]);
      // Should contain URL only once
      expect((result.match(/https:\/\/a\.com/g) || []).length).toBe(1);
      // Should keep v2 (higher score)
      expect(result).toContain('version 2');
    });

    it('should merge results from multiple responses', () => {
      const r1 = { results: [{ title: 'A', url: 'https://a.com', content: 'a', score: 0.9 }], query: 'q', responseTime: 100 };
      const r2 = { results: [{ title: 'B', url: 'https://b.com', content: 'b', score: 0.8 }], query: 'q', responseTime: 100 };

      const result = manager.formatMultiSearchResults([r1, r2]);
      expect(result).toContain('**A**');
      expect(result).toContain('**B**');
    });

    it('should use first non-empty answer as summary', () => {
      const r1 = { results: [], query: 'q', responseTime: 100 };
      const r2 = { results: [], answer: 'The answer', query: 'q', responseTime: 100 };

      const result = manager.formatMultiSearchResults([r1, r2]);
      expect(result).toContain('Summary: The answer');
    });

    it('should sort merged results by score descending', () => {
      const r1 = { results: [{ title: 'Low', url: 'https://low.com', content: 'low', score: 0.5 }], query: 'q', responseTime: 100 };
      const r2 = { results: [{ title: 'High', url: 'https://high.com', content: 'high', score: 0.99 }], query: 'q', responseTime: 100 };

      const result = manager.formatMultiSearchResults([r1, r2]);
      const highIdx = result.indexOf('**High**');
      const lowIdx = result.indexOf('**Low**');
      expect(highIdx).toBeLessThan(lowIdx);
    });
  });

  // ── resetToDefaults ──

  describe('resetToDefaults', () => {
    it('should reset settings and clear cache', async () => {
      await manager.toggle(true);
      manager.updateSettings({ searchDepth: 'advanced', cacheDuration: 60, creditsPerPrompt: 4 });
      await manager.searchForMessage('populate cache');

      manager.resetToDefaults();

      const { settings } = await manager.getSettings();
      expect(settings.searchDepth).toBe('basic');
      expect(settings.cacheDuration).toBe(15);
      expect(settings.creditsPerPrompt).toBe(1);
      expect(settings.maxResultsPerSearch).toBe(5);

      // Cache should be cleared — next search should call API
      mockTavily.search.mockClear();
      await manager.searchForMessage('populate cache');
      expect(mockTavily.search).toHaveBeenCalledTimes(1);
    });
  });

  // ── searchByQuery ──

  describe('searchByQuery', () => {
    it('should return error when mode is off', async () => {
      manager.setMode('off');

      const result = await manager.searchByQuery('test query');

      expect(result).toContain('Error:');
      expect(result).toContain('auto mode is not enabled');
      expect(mockTavily.search).not.toHaveBeenCalled();
    });

    it('should return error when mode is manual', async () => {
      manager.setMode('manual');

      const result = await manager.searchByQuery('test query');

      expect(result).toContain('Error:');
      expect(result).toContain('auto mode is not enabled');
      expect(mockTavily.search).not.toHaveBeenCalled();
    });

    it('should return error when API key not configured', async () => {
      mockTavily.isConfigured.mockResolvedValue(false);

      const result = await manager.searchByQuery('test query');

      expect(result).toContain('Error:');
      expect(result).toContain('Tavily API key not configured');
      expect(mockTavily.search).not.toHaveBeenCalled();
    });

    it('should fetch from Tavily without requiring enabled toggle', async () => {
      // Do NOT toggle on — searchByQuery bypasses the toggle
      expect(manager.isEnabled).toBe(false);

      const result = await manager.searchByQuery('test query');

      expect(mockTavily.search).toHaveBeenCalledWith('test query', { searchDepth: 'basic', maxResults: 5 });
      expect(result).toContain('Result 1');
      expect(result).toContain('Summary answer');
    });

    it('should make a single API call per invocation', async () => {
      // Even with creditsPerPrompt > 1, searchByQuery should be 1 call
      manager.updateSettings({ creditsPerPrompt: 5 });

      await manager.searchByQuery('test query');

      expect(mockTavily.search).toHaveBeenCalledTimes(1);
    });

    it('should use shared cache with tool| prefix', async () => {
      await manager.searchByQuery('test query');
      expect(mockTavily.search).toHaveBeenCalledTimes(1);

      // Second call with same query should use cache
      await manager.searchByQuery('test query');
      expect(mockTavily.search).toHaveBeenCalledTimes(1);
    });

    it('should be case-insensitive for cache keys', async () => {
      await manager.searchByQuery('Test Query');
      await manager.searchByQuery('test query');

      expect(mockTavily.search).toHaveBeenCalledTimes(1);
    });

    it('should NOT share cache with searchForMessage (different prefix)', async () => {
      await manager.toggle(true);
      await manager.searchForMessage('test query');
      expect(mockTavily.search).toHaveBeenCalledTimes(1);

      // searchByQuery uses 'tool|' prefix — should NOT hit searchForMessage cache
      await manager.searchByQuery('test query');
      expect(mockTavily.search).toHaveBeenCalledTimes(2);
    });

    it('should return error string on API failure', async () => {
      mockTavily.search.mockRejectedValueOnce(new Error('Rate limit exceeded'));

      const result = await manager.searchByQuery('test query');

      expect(result).toContain('Error:');
      expect(result).toContain('Rate limit exceeded');
    });

    it('should use current search depth and maxResults settings', async () => {
      manager.updateSettings({ searchDepth: 'advanced', maxResultsPerSearch: 10 });

      await manager.searchByQuery('test query');

      expect(mockTavily.search).toHaveBeenCalledWith('test query', { searchDepth: 'advanced', maxResults: 10 });
    });

    it('should be cleared by clearCache()', async () => {
      await manager.searchByQuery('test query');
      expect(mockTavily.search).toHaveBeenCalledTimes(1);

      manager.clearCache();

      await manager.searchByQuery('test query');
      expect(mockTavily.search).toHaveBeenCalledTimes(2);
    });
  });

  // ── dispose ──

  describe('dispose', () => {
    it('should not throw when disposed', () => {
      expect(() => manager.dispose()).not.toThrow();
    });

    it('should not fire events after dispose', async () => {
      const events: Array<{ enabled: boolean }> = [];
      manager.onToggled(e => events.push(e));
      manager.dispose();

      await manager.toggle(true);

      // After dispose, listeners are cleared — no events should fire
      expect(events).toHaveLength(0);
    });
  });
});
