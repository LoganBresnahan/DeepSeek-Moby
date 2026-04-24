/**
 * Web search provider abstraction.
 *
 * A `WebSearchProvider` implementation wraps a single backend (Tavily today;
 * SearXNG and others in future phases) and exposes a uniform search surface
 * to `webSearchManager`. The manager doesn't know which provider it's
 * talking to — dispatch goes through the `WebSearchProviderRegistry`.
 *
 * Phase 1 scope: define the interface + generic result shapes. Behavior is
 * unchanged; today's Tavily-specific types are re-exported from the Tavily
 * client as type aliases to avoid a sweeping rename.
 *
 * See [docs/plans/web-search-providers.md](../../docs/plans/web-search-providers.md).
 */

export interface WebSearchResult {
  title: string;
  url: string;
  content: string;
  /** Relevance score normalized to 0..1. Providers that don't expose a score
   *  should synthesize one (e.g. 1.0 for rank 0, decreasing) so dedup still
   *  has a consistent sort key. */
  score: number;
}

export interface WebSearchResponse {
  results: WebSearchResult[];
  /** Short summary if the provider supports one (Tavily's `answer`). Omit
   *  for providers that don't. */
  answer?: string;
  query: string;
  /** Wall-clock time the provider took, in milliseconds. Informational. */
  responseTime: number;
}

export interface WebSearchOptions {
  /** Tavily-style "basic" vs "advanced" depth. Providers that don't offer
   *  a depth axis (SearXNG) can ignore this. */
  searchDepth?: 'basic' | 'advanced';
  maxResults?: number;
}

/**
 * Uniform interface for any web-search backend.
 *
 * Keep this minimal — methods here must make sense for *every* future
 * provider we plan to add. Provider-specific methods (e.g. Tavily's
 * credit accounting, or SearXNG's `engines` selection) live on the
 * concrete class and are accessed via `WebSearchProviderRegistry.get(id)`.
 */
export interface WebSearchProvider {
  /** Identifier used in the registry lookup and in `moby.webSearch.provider`. */
  readonly id: string;

  /** Whether the provider is ready to accept search requests (API key present,
   *  endpoint reachable for providers where that check is cheap, etc.). */
  isConfigured(): Promise<boolean>;

  search(query: string, options?: WebSearchOptions): Promise<WebSearchResponse>;
}
