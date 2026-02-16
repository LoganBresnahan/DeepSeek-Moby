/**
 * WebSearchManager — Owns web search state, caching, and Tavily API integration.
 *
 * Extracted from ChatProvider (Phase 1 of ChatProvider refactor).
 * Communicates via vscode.EventEmitter — ChatProvider subscribes to events
 * and forwards them to the webview via postMessage.
 */

import * as vscode from 'vscode';
import { TavilyClient, TavilySearchResponse, TavilySearchResult } from '../clients/tavilyClient';
import { logger } from '../utils/logger';
import { tracer } from '../tracing';
import { WebSearchSettings, WebSearchResultEvent } from './types';

export interface SearchProgress {
  current: number;
  total: number;
}

export class WebSearchManager {
  // ── Events ──

  private readonly _onSearching = new vscode.EventEmitter<SearchProgress>();
  private readonly _onSearchComplete = new vscode.EventEmitter<WebSearchResultEvent>();
  private readonly _onSearchCached = new vscode.EventEmitter<void>();
  private readonly _onSearchError = new vscode.EventEmitter<{ message: string }>();
  private readonly _onToggled = new vscode.EventEmitter<{ enabled: boolean }>();
  private readonly _onSettingsChanged = new vscode.EventEmitter<void>();

  readonly onSearching = this._onSearching.event;
  readonly onSearchComplete = this._onSearchComplete.event;
  readonly onSearchCached = this._onSearchCached.event;
  readonly onSearchError = this._onSearchError.event;
  readonly onToggled = this._onToggled.event;
  readonly onSettingsChanged = this._onSettingsChanged.event;

  // ── State ──

  private enabled = false;
  private settings: WebSearchSettings = {
    creditsPerPrompt: 1,
    searchDepth: 'basic',
    cacheDuration: 15,
    maxResultsPerSearch: 5
  };
  private cache = new Map<string, { results: string; timestamp: number }>();

  constructor(private tavilyClient: TavilyClient) {}

  // ── Public Methods ──

  /**
   * Toggle web search on/off. Validates API key is configured before enabling.
   */
  async toggle(enabled: boolean): Promise<void> {
    this.enabled = enabled;

    if (enabled && !(await this.tavilyClient.isConfigured())) {
      logger.info('[WebSearch] Toggle rejected: Tavily API key not configured');
      tracer.trace('state.publish', 'webSearch.toggle.rejected', {
        data: { reason: 'api_key_not_configured' }
      });
      this.enabled = false;
      this._onToggled.fire({ enabled: false });
      this._onSearchError.fire({
        message: 'Tavily API key not configured. Use the "DeepSeek Moby: Set Tavily API Key" command.'
      });
      return;
    }

    logger.info(`[WebSearch] Toggled: enabled=${enabled}`);
    tracer.trace('state.publish', 'webSearch.toggled', {
      data: { enabled }
    });
    this._onToggled.fire({ enabled });
  }

  /**
   * Update web search settings. Only provided fields are changed.
   */
  updateSettings(settings: Partial<WebSearchSettings>): void {
    const changed: string[] = [];

    if (settings.creditsPerPrompt !== undefined) {
      this.settings.creditsPerPrompt = settings.creditsPerPrompt;
      changed.push(`creditsPerPrompt=${settings.creditsPerPrompt}`);
    }
    if (settings.searchDepth !== undefined) {
      this.settings.searchDepth = settings.searchDepth;
      changed.push(`searchDepth=${settings.searchDepth}`);
    }
    if (settings.cacheDuration !== undefined) {
      this.settings.cacheDuration = settings.cacheDuration;
      changed.push(`cacheDuration=${settings.cacheDuration}`);
    }
    if (settings.maxResultsPerSearch !== undefined) {
      this.settings.maxResultsPerSearch = settings.maxResultsPerSearch;
      changed.push(`maxResultsPerSearch=${settings.maxResultsPerSearch}`);
    }

    if (changed.length > 0) {
      logger.info(`[WebSearch] Settings updated: ${changed.join(', ')}`);
      tracer.trace('state.publish', 'webSearch.settingsChanged', {
        data: { ...this.settings }
      });
      this._onSettingsChanged.fire();
    }
  }

  /**
   * Get current settings snapshot for webview sync.
   */
  async getSettings(): Promise<{ enabled: boolean; settings: WebSearchSettings; configured: boolean }> {
    return {
      enabled: this.enabled,
      settings: { ...this.settings },
      configured: await this.tavilyClient.isConfigured()
    };
  }

  /**
   * Clear the search results cache.
   */
  clearCache(): void {
    const count = this.cache.size;
    this.cache.clear();
    logger.webSearchCacheCleared();
    if (count > 0) {
      logger.info(`[WebSearch] Cleared ${count} cached entries`);
    }
  }

  /**
   * Compute number of API calls from credits and depth.
   * Basic: 1 credit per call. Advanced: 2 credits per call.
   */
  private computeApiCallCount(): number {
    const costPerCall = this.settings.searchDepth === 'advanced' ? 2 : 1;
    return Math.max(1, Math.floor(this.settings.creditsPerPrompt / costPerCall));
  }

  /**
   * Execute a web search for the given user message.
   * Returns formatted search context string for injection into system prompt,
   * or empty string if disabled/unconfigured/error.
   *
   * Runs multiple API calls in parallel based on creditsPerPrompt setting.
   * Fires onSearching (with progress), onSearchComplete/onSearchCached/onSearchError events
   * so ChatProvider can forward status to the webview.
   */
  async searchForMessage(message: string): Promise<string> {
    if (!this.enabled || !(await this.tavilyClient.isConfigured())) {
      return '';
    }

    const callCount = this.computeApiCallCount();

    // Cache key incorporates settings so changed settings don't serve stale results
    const cacheKey = `${message.toLowerCase().trim()}|credits=${this.settings.creditsPerPrompt}|maxResults=${this.settings.maxResultsPerSearch}|depth=${this.settings.searchDepth}`;
    const cached = this.cache.get(cacheKey);

    // Check cache with TTL (cacheDuration is in minutes)
    if (cached) {
      const ttlMs = this.settings.cacheDuration * 60 * 1000;
      const age = Date.now() - cached.timestamp;

      if (age < ttlMs) {
        logger.webSearchCached(message);
        this._onSearchCached.fire();
        return cached.results;
      }

      // Cache expired — evict and re-fetch
      this.cache.delete(cacheKey);
      logger.info(`[WebSearch] Cache expired for query (age=${Math.round(age / 1000)}s, ttl=${this.settings.cacheDuration}min)`);
    }

    // Cache miss or expired — fetch from Tavily
    try {
      this._onSearching.fire({ current: 0, total: callCount });
      logger.webSearchRequest(message, this.settings.searchDepth);
      logger.info(`[WebSearch] Starting ${callCount} API call(s), maxResults=${this.settings.maxResultsPerSearch}, depth=${this.settings.searchDepth}`);

      const searchStartTime = Date.now();

      // Execute all API calls in parallel
      const searchPromises = Array.from({ length: callCount }, (_, i) =>
        this.tavilyClient.search(message, {
          searchDepth: this.settings.searchDepth,
          maxResults: this.settings.maxResultsPerSearch
        }).then(result => {
          this._onSearching.fire({ current: i + 1, total: callCount });
          return result;
        })
      );

      const settled = await Promise.allSettled(searchPromises);
      const fulfilled = settled
        .filter((r): r is PromiseFulfilledResult<TavilySearchResponse> => r.status === 'fulfilled')
        .map(r => r.value);

      if (fulfilled.length === 0) {
        // All calls failed — report the first error
        const firstRejected = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
        const errorMsg = firstRejected?.reason?.message || 'All search calls failed';
        throw new Error(errorMsg);
      }

      const webSearchContext = this.formatMultiSearchResults(fulfilled);
      const totalResults = fulfilled.reduce((sum, r) => sum + r.results.length, 0);
      logger.webSearchResult(totalResults, Date.now() - searchStartTime);

      if (fulfilled.length < callCount) {
        logger.info(`[WebSearch] ${callCount - fulfilled.length} of ${callCount} calls failed, proceeding with ${fulfilled.length} successful`);
      }

      // Cache the results
      this.cache.set(cacheKey, {
        results: webSearchContext,
        timestamp: Date.now()
      });

      this._onSearchComplete.fire({ context: webSearchContext });
      return webSearchContext;
    } catch (error: any) {
      logger.webSearchError(error.message);
      this._onSearchError.fire({ message: error.message });
      return '';
    }
  }

  /**
   * Format a single Tavily API response into a readable string for the system prompt.
   */
  formatSearchResults(response: TavilySearchResponse): string {
    let output = `Web search results for: "${response.query}"\n`;
    output += '─'.repeat(50) + '\n\n';

    if (response.answer) {
      output += `Summary: ${response.answer}\n\n`;
    }

    for (const result of response.results.slice(0, 5)) {
      output += `**${result.title}**\n`;
      output += `URL: ${result.url}\n`;
      output += `${result.content.substring(0, 500)}${result.content.length > 500 ? '...' : ''}\n\n`;
    }

    return output;
  }

  /**
   * Format multiple Tavily API responses into a single readable string.
   * Deduplicates results by URL, keeping the highest-scored version.
   */
  formatMultiSearchResults(responses: TavilySearchResponse[]): string {
    if (responses.length === 0) return '';
    if (responses.length === 1) return this.formatSearchResults(responses[0]);

    const query = responses[0].query;
    let output = `Web search results for: "${query}"\n`;
    output += '─'.repeat(50) + '\n\n';

    // Use first non-empty answer as summary
    const answer = responses.find(r => r.answer)?.answer;
    if (answer) {
      output += `Summary: ${answer}\n\n`;
    }

    // Deduplicate results by URL, keeping highest score
    const seen = new Map<string, TavilySearchResult>();
    for (const response of responses) {
      for (const result of response.results) {
        const existing = seen.get(result.url);
        if (!existing || result.score > existing.score) {
          seen.set(result.url, result);
        }
      }
    }

    // Sort by score descending
    const deduped = Array.from(seen.values()).sort((a, b) => b.score - a.score);

    for (const result of deduped) {
      output += `**${result.title}**\n`;
      output += `URL: ${result.url}\n`;
      output += `${result.content.substring(0, 500)}${result.content.length > 500 ? '...' : ''}\n\n`;
    }

    return output;
  }

  /**
   * Reset all web search state to defaults (called from ChatProvider.resetToDefaults).
   */
  resetToDefaults(): void {
    this.settings = {
      creditsPerPrompt: 1,
      searchDepth: 'basic',
      cacheDuration: 15,
      maxResultsPerSearch: 5
    };
    this.cache.clear();
    logger.info('[WebSearch] Reset to defaults');
  }

  /**
   * Whether web search is currently enabled.
   */
  get isEnabled(): boolean {
    return this.enabled;
  }

  dispose(): void {
    this._onSearching.dispose();
    this._onSearchComplete.dispose();
    this._onSearchCached.dispose();
    this._onSearchError.dispose();
    this._onToggled.dispose();
    this._onSettingsChanged.dispose();
  }
}
