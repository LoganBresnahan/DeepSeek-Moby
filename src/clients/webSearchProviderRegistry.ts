/**
 * Web search provider registry.
 *
 * Holds one instance per registered provider and resolves the active one at
 * call time. `webSearchManager` dispatches through `active()` — no file
 * outside this one should know which specific provider is in use.
 *
 * See [docs/plans/web-search-providers.md](../../docs/plans/web-search-providers.md).
 */

import * as vscode from 'vscode';
import { WebSearchProvider } from './webSearchProvider';
import { TavilyClient } from './tavilyClient';
import { SearxngClient } from './searxngClient';

export type WebSearchProviderId = 'tavily' | 'searxng';

export const DEFAULT_WEB_SEARCH_PROVIDER: WebSearchProviderId = 'tavily';

export class WebSearchProviderRegistry {
  private readonly providers = new Map<WebSearchProviderId, WebSearchProvider>();
  private readonly tavily: TavilyClient;
  private readonly searxng: SearxngClient;

  constructor(context: vscode.ExtensionContext) {
    this.tavily = new TavilyClient(context);
    this.searxng = new SearxngClient(context);
    this.providers.set('tavily', this.tavily);
    this.providers.set('searxng', this.searxng);
  }

  /** Return the currently-active provider, per the user's `moby.webSearch.provider`
   *  setting. Falls back to the default if the configured id is unknown. */
  active(): WebSearchProvider {
    const id = this.getActiveProviderId();
    return this.providers.get(id) ?? this.providers.get(DEFAULT_WEB_SEARCH_PROVIDER)!;
  }

  /** Id of the currently-active provider. Exposed for UI code that needs to
   *  render provider-specific sections or gate provider-specific stats. */
  activeId(): WebSearchProviderId {
    const id = this.getActiveProviderId();
    return this.providers.has(id) ? id : DEFAULT_WEB_SEARCH_PROVIDER;
  }

  /** Type-narrowed accessor for a specific provider by id. Used by callers
   *  that need provider-specific methods (e.g. `chatProvider`'s Tavily
   *  credit/usage stats display). */
  getTavilyClient(): TavilyClient {
    return this.tavily;
  }

  getSearxngClient(): SearxngClient {
    return this.searxng;
  }

  /** Configuration-ready status of every provider, keyed by id. The settings
   *  popup uses this to render status dots next to each provider's config row. */
  async getConfiguredStatus(): Promise<Record<WebSearchProviderId, boolean>> {
    const entries = await Promise.all(
      (Array.from(this.providers.entries()) as Array<[WebSearchProviderId, WebSearchProvider]>).map(
        async ([id, p]) => [id, await p.isConfigured()] as const
      )
    );
    return Object.fromEntries(entries) as Record<WebSearchProviderId, boolean>;
  }

  private getActiveProviderId(): WebSearchProviderId {
    const config = vscode.workspace.getConfiguration('moby');
    const raw = config.get<string>('webSearch.provider');
    if (raw === 'tavily' || raw === 'searxng') return raw;
    return DEFAULT_WEB_SEARCH_PROVIDER;
  }
}
