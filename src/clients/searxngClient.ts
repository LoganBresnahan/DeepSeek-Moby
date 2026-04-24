/**
 * SearXNG web search client.
 *
 * SearXNG is a self-hosted metasearch engine. No API key — authentication,
 * if any, is baked into the endpoint URL (reverse-proxy basic auth or similar).
 * JSON API format must be enabled in the SearXNG instance's `settings.yml`
 * (`search.formats: [html, json]`).
 *
 * Response schema (abridged):
 *   {
 *     "query": string,
 *     "number_of_results": number,
 *     "results": [
 *       { "title": string, "url": string, "content": string,
 *         "engine": string, "score"?: number, ... }
 *     ],
 *     "answers": string[],
 *     "infoboxes": [...]
 *   }
 *
 * SearXNG doesn't expose a single "answer" string the way Tavily does; the
 * `answers` array is usually populated from infobox/calculator results. We
 * pick the first non-empty answer if any for parity with `WebSearchResponse.answer`.
 */

import * as vscode from 'vscode';
import { HttpClient, HttpError } from '../utils/httpClient';
import { WebSearchProvider, WebSearchResponse, WebSearchOptions } from './webSearchProvider';

interface SearxngRawResult {
  title?: string;
  url?: string;
  content?: string;
  engine?: string;
  score?: number;
}

interface SearxngRawResponse {
  query?: string;
  results?: SearxngRawResult[];
  answers?: string[];
  number_of_results?: number;
}

export class SearxngClient implements WebSearchProvider {
  readonly id = 'searxng' as const;

  constructor(private readonly context: vscode.ExtensionContext) {}

  async isConfigured(): Promise<boolean> {
    const endpoint = this.getEndpoint();
    return !!endpoint && endpoint.trim().length > 0;
  }

  async search(query: string, options?: WebSearchOptions): Promise<WebSearchResponse> {
    const endpoint = this.getEndpoint();
    if (!endpoint) {
      throw new Error('SearXNG endpoint is not configured. Set `moby.webSearch.searxng.endpoint` to your instance URL (e.g. http://localhost:8080).');
    }

    const engines = this.getEngines();
    const maxResults = options?.maxResults ?? 10;

    // Build query string manually — SearXNG's /search takes GET params.
    const params = new URLSearchParams();
    params.set('q', query);
    params.set('format', 'json');
    if (engines.length > 0) {
      params.set('engines', engines.join(','));
    }

    const started = Date.now();
    const httpClient = new HttpClient({
      baseURL: endpoint.replace(/\/$/, ''),
      timeout: 30000,
      headers: { 'Accept': 'application/json' }
    });

    try {
      const response = await httpClient.get<SearxngRawResponse>(`/search?${params.toString()}`);
      const raw = response.data;

      // SearXNG returns scores that vary wildly by engine — synthesize a
      // normalized 0..1 by rank so downstream dedup+sort has a stable key.
      const sliced = (raw.results ?? []).slice(0, maxResults);
      const count = Math.max(sliced.length, 1);
      const results = sliced.map((r, i) => ({
        title: r.title ?? '(no title)',
        url: r.url ?? '',
        content: r.content ?? '',
        // If SearXNG provided a score, keep its relative ordering by
        // clamping into 0..1. Else derive from rank.
        score: typeof r.score === 'number'
          ? Math.max(0, Math.min(1, r.score))
          : (count - i) / count
      }));

      const answer = (raw.answers ?? []).find(a => a && a.trim().length > 0);

      return {
        results,
        answer: answer || undefined,
        query: raw.query ?? query,
        responseTime: Date.now() - started
      };
    } catch (error: unknown) {
      const httpError = error as HttpError;
      const status = httpError.response?.status;
      if (status === 401 || status === 403) {
        throw new Error(`SearXNG rejected the request (${status}). Check the endpoint URL and any auth headers.`);
      }
      if (status === 404) {
        throw new Error(`SearXNG endpoint responded 404 at ${endpoint}/search. Is JSON format enabled in settings.yml (search.formats)?`);
      }
      // Connection-level errors won't have an HTTP response.
      if (!httpError.response) {
        throw new Error(`SearXNG unreachable at ${endpoint}: ${httpError.message}`);
      }
      throw new Error(`SearXNG search failed (${status}): ${httpError.message}`);
    }
  }

  /** Current endpoint from settings, empty string if unset. */
  private getEndpoint(): string {
    const config = vscode.workspace.getConfiguration('moby');
    return (config.get<string>('webSearch.searxng.endpoint') || '').trim();
  }

  /** Selected engines from settings. Empty array means "whatever SearXNG defaults to". */
  private getEngines(): string[] {
    const config = vscode.workspace.getConfiguration('moby');
    const raw = config.get<string[]>('webSearch.searxng.engines');
    if (!Array.isArray(raw)) return [];
    return raw.filter(e => typeof e === 'string' && e.trim().length > 0);
  }
}
