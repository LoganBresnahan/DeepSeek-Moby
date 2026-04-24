/**
 * Web search provider registry.
 *
 * Holds one instance per registered provider and resolves the active one at
 * call time. `webSearchManager` dispatches through `active()` — no file
 * outside this one should know which specific provider is in use.
 *
 * Phase 1 scope: Tavily is the only registered provider. The active provider
 * is always `'tavily'`. Phase 2 adds SearXNG and starts reading
 * `moby.webSearch.provider` to pick.
 *
 * See [docs/plans/web-search-providers.md](../../docs/plans/web-search-providers.md).
 */

import * as vscode from 'vscode';
import { WebSearchProvider } from './webSearchProvider';
import { TavilyClient } from './tavilyClient';

export type WebSearchProviderId = 'tavily';

export class WebSearchProviderRegistry {
  private readonly providers = new Map<WebSearchProviderId, WebSearchProvider>();
  private readonly tavily: TavilyClient;

  constructor(context: vscode.ExtensionContext) {
    this.tavily = new TavilyClient(context);
    this.providers.set('tavily', this.tavily);
  }

  /** Return the currently-active provider, per the user's `moby.webSearch.provider`
   *  setting. Falls back to Tavily if the configured id is unknown. */
  active(): WebSearchProvider {
    const id = this.getActiveProviderId();
    return this.providers.get(id) ?? this.providers.get('tavily')!;
  }

  /** Type-narrowed accessor for a specific provider by id. Used by callers
   *  that need provider-specific methods (e.g. `chatProvider`'s Tavily
   *  credit/usage stats display). */
  getTavilyClient(): TavilyClient {
    return this.tavily;
  }

  private getActiveProviderId(): WebSearchProviderId {
    // Phase 1: hardcoded. Phase 2 reads `moby.webSearch.provider` from config.
    return 'tavily';
  }
}
