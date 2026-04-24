/**
 * WebSearchManager — Owns web search state, caching, and dispatch.
 *
 * Resolves the active provider (Tavily today; SearXNG and others in future
 * phases) via `WebSearchProviderRegistry.active()` — no direct reference
 * to any specific provider. Provider swaps become a settings change rather
 * than a code change.
 *
 * Communicates via vscode.EventEmitter — ChatProvider subscribes to events
 * and forwards them to the webview via postMessage.
 */

import * as vscode from 'vscode';
import { WebSearchProviderRegistry } from '../clients/webSearchProviderRegistry';
import { WebSearchResponse, WebSearchResult } from '../clients/webSearchProvider';
import { logger } from '../utils/logger';
import { tracer } from '../tracing';
import { WebSearchSettings, WebSearchResultEvent, WebSearchMode } from './types';

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
  private readonly _onModeChanged = new vscode.EventEmitter<{ mode: WebSearchMode }>();

  readonly onSearching = this._onSearching.event;
  readonly onSearchComplete = this._onSearchComplete.event;
  readonly onSearchCached = this._onSearchCached.event;
  readonly onSearchError = this._onSearchError.event;
  readonly onToggled = this._onToggled.event;
  readonly onSettingsChanged = this._onSettingsChanged.event;
  readonly onModeChanged = this._onModeChanged.event;

  // ── State ──

  private mode: WebSearchMode = 'auto';
  private enabled = false;
  private settings: WebSearchSettings = {
    creditsPerPrompt: 1,
    searchDepth: 'basic',
    cacheDuration: 15,
    maxResultsPerSearch: 5
  };
  private cache = new Map<string, { results: string; timestamp: number }>();

  constructor(private readonly registry: WebSearchProviderRegistry) {}

  /** The currently-active web search provider, resolved at call time so a
   *  settings-level provider switch takes effect on the next search without
   *  needing a manager rebuild. */
  private get provider() {
    return this.registry.active();
  }

  // ── Public Methods ──

  /**
   * Set web search mode (off/manual/auto). Persisted via VS Code settings externally.
   */
  setMode(newMode: WebSearchMode): void {
    if (this.mode === newMode) return;
    const oldMode = this.mode;
    this.mode = newMode;

    // If switching to 'off', disable manual toggle too
    if (newMode === 'off' && this.enabled) {
      this.enabled = false;
      this._onToggled.fire({ enabled: false });
    }

    logger.info(`[WebSearch] Mode changed: ${oldMode} → ${newMode}`);
    tracer.trace('state.publish', 'webSearch.modeChanged', {
      data: { oldMode, newMode }
    });
    this._onModeChanged.fire({ mode: newMode });
  }

  /**
   * Get current web search mode.
   */
  getMode(): WebSearchMode {
    return this.mode;
  }

  /**
   * Toggle web search on/off. Validates API key is configured before enabling.
   * Rejected when mode is 'off'.
   */
  async toggle(enabled: boolean): Promise<void> {
    if (this.mode === 'off') {
      logger.info('[WebSearch] Toggle rejected: mode is off');
      this._onToggled.fire({ enabled: false });
      return;
    }

    this.enabled = enabled;

    if (enabled && !(await this.provider.isConfigured())) {
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
   *
   * `configured` reflects the *active* provider's status — used by the toolbar
   * toggle and the auto-mode `web_search` tool gate. `providerStatus` is the
   * per-provider map — used by the settings popup to render a status dot
   * next to each provider's config row independently.
   */
  async getSettings(): Promise<{
    enabled: boolean;
    settings: WebSearchSettings;
    configured: boolean;
    mode: WebSearchMode;
    provider: string;
    providerStatus: Record<string, boolean>;
  }> {
    return {
      enabled: this.enabled,
      settings: { ...this.settings },
      configured: await this.provider.isConfigured(),
      mode: this.mode,
      provider: this.registry.activeId(),
      providerStatus: await this.registry.getConfiguredStatus()
    };
  }

  /**
   * Fire a minimal search against a specific provider and report whether it
   * succeeded. Used by the web-search popup's "Test connection" button so
   * users can validate SearXNG endpoints (and sanity-check Tavily keys)
   * during setup, without waiting for the first real turn to fail.
   *
   * Bypasses cache; always hits the live endpoint. Returns a structured
   * result rather than throwing so the webview can render success/error
   * inline.
   */
  async testProvider(providerId: string): Promise<{ success: boolean; message: string; resultCount?: number }> {
    // Look the provider up explicitly — testProvider is the one place
    // we don't want to dispatch through active().
    const provider = providerId === 'tavily'
      ? this.registry.getTavilyClient()
      : providerId === 'searxng'
        ? this.registry.getSearxngClient()
        : null;
    if (!provider) {
      return { success: false, message: `Unknown provider: ${providerId}` };
    }
    if (!(await provider.isConfigured())) {
      return { success: false, message: 'Provider is not configured (missing API key or endpoint).' };
    }
    try {
      const response = await provider.search('test', { maxResults: 1 });
      return {
        success: true,
        message: `OK — ${response.results.length} result(s) returned in ${response.responseTime}ms.`,
        resultCount: response.results.length
      };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, message: msg };
    }
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
    if (this.mode === 'off' || !this.enabled || !(await this.provider.isConfigured())) {
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
        this.provider.search(message, {
          searchDepth: this.settings.searchDepth,
          maxResults: this.settings.maxResultsPerSearch
        }).then(result => {
          this._onSearching.fire({ current: i + 1, total: callCount });
          return result;
        })
      );

      const settled = await Promise.allSettled(searchPromises);
      const fulfilled = settled
        .filter((r): r is PromiseFulfilledResult<WebSearchResponse> => r.status === 'fulfilled')
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
  formatSearchResults(response: WebSearchResponse): string {
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
  formatMultiSearchResults(responses: WebSearchResponse[]): string {
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
    const seen = new Map<string, WebSearchResult>();
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
   * Execute a single web search for an LLM-provided query.
   * Unlike searchForMessage(), this:
   * - Bypasses the enabled toggle (only requires API key configured)
   * - Makes a single API call per invocation
   * - Returns error strings on failure (so the LLM can adapt)
   * - Uses shared cache with 'tool|' prefix
   *
   * Used by: tool calling loop (Chat model) and <web_search> tag handling (Reasoner).
   */
  async searchByQuery(query: string): Promise<string> {
    if (this.mode !== 'auto') {
      // Phrased as instruction, not error. The previous string started
      // with "Error:" and said "not enabled" — weak tool-calling models
      // read that as a transient failure worth retrying and looped. The
      // text below tells the model explicitly that search has already
      // been done for this turn (manual mode injects results upstream)
      // and that the tool should not be called again.
      return 'Web search has already been performed for this turn. The results are in the system prompt above. Use those results instead of calling web_search — do not retry this tool.';
    }

    if (!(await this.provider.isConfigured())) {
      tracer.trace('state.publish', 'webSearch.toolSearch.notConfigured', {
        data: { query: query.substring(0, 80) }
      });
      return 'Error: Tavily API key not configured. Web search is unavailable.';
    }

    // Cache key with 'tool|' prefix to distinguish from manual searches
    const cacheKey = `tool|${query.toLowerCase().trim()}|depth=${this.settings.searchDepth}|maxResults=${this.settings.maxResultsPerSearch}`;
    const cached = this.cache.get(cacheKey);

    if (cached) {
      const ttlMs = this.settings.cacheDuration * 60 * 1000;
      if (Date.now() - cached.timestamp < ttlMs) {
        logger.info(`[WebSearch] Tool-triggered cache hit for: "${query.substring(0, 50)}"`);
        tracer.trace('state.publish', 'webSearch.toolSearch.cacheHit', {
          data: { query: query.substring(0, 80) }
        });
        return cached.results;
      }
      this.cache.delete(cacheKey);
    }

    try {
      logger.info(`[WebSearch] Tool-triggered search: "${query.substring(0, 80)}"`);
      const response = await this.provider.search(query, {
        searchDepth: this.settings.searchDepth,
        maxResults: this.settings.maxResultsPerSearch
      });

      const formatted = this.formatSearchResults(response);

      this.cache.set(cacheKey, {
        results: formatted,
        timestamp: Date.now()
      });

      logger.info(`[WebSearch] Tool-triggered search complete: ${response.results.length} results`);
      tracer.trace('state.publish', 'webSearch.toolSearch.complete', {
        data: { query: query.substring(0, 80), resultCount: response.results.length }
      });
      return formatted;
    } catch (error: any) {
      logger.webSearchError(error.message);
      tracer.trace('state.publish', 'webSearch.toolSearch.error', {
        data: { query: query.substring(0, 80), error: error.message }
      });
      return `Error: Web search failed — ${error.message}`;
    }
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
    this._onModeChanged.dispose();
  }
}
