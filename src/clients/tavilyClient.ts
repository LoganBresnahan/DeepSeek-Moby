import * as vscode from 'vscode';
import { HttpClient, HttpError } from '../utils/httpClient';
import { ConfigManager } from '../utils/config';
import { WebSearchProvider, WebSearchResponse, WebSearchResult, WebSearchOptions } from './webSearchProvider';

export interface TavilyUsageStats {
  totalSearches: number;
  basicSearches: number;
  advancedSearches: number;
  totalCreditsUsed: number;
}

export interface TavilyApiUsage {
  remaining: number | null;
  limit: number | null;
  plan: string;
  used: number;
}

export class TavilyClient implements WebSearchProvider {
  readonly id = 'tavily' as const;

  private httpClient: HttpClient;
  private config: ConfigManager;
  private context: vscode.ExtensionContext;
  private usageStats: TavilyUsageStats;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.config = ConfigManager.getInstance();

    this.httpClient = new HttpClient({
      baseURL: 'https://api.tavily.com',
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json'
      }
    });

    this.usageStats = {
      totalSearches: 0,
      basicSearches: 0,
      advancedSearches: 0,
      totalCreditsUsed: 0
    };
  }

  private async getApiKey(): Promise<string> {
    const apiKey = await this.context.secrets.get('moby.tavilyApiKey');
    if (apiKey) return apiKey;

    // Fall back to environment variable (useful for CI, containers, testing)
    const envKey = process.env.TAVILY_API_KEY;
    if (envKey) return envKey;

    throw new Error('Tavily API key is not configured. Use the "DeepSeek Moby: Set Tavily API Key" command.');
  }

  async search(query: string, options?: WebSearchOptions): Promise<WebSearchResponse> {
    const apiKey = await this.getApiKey();
    const searchDepth = options?.searchDepth || this.config.get<string>('tavilySearchDepth') || 'basic';

    try {
      const response = await this.httpClient.post<{
        results?: WebSearchResult[];
        answer?: string;
        query?: string;
        response_time?: number;
      }>('/search', {
        api_key: apiKey,
        query,
        search_depth: searchDepth,
        include_answer: true,
        max_results: options?.maxResults ?? 5
      });

      this.trackUsage(searchDepth);

      return {
        results: response.data.results || [],
        answer: response.data.answer,
        query: response.data.query || query,
        responseTime: response.data.response_time || 0
      };
    } catch (error: unknown) {
      const httpError = error as HttpError;
      if (httpError.response?.status === 401) {
        throw new Error('Invalid Tavily API key. Please check your settings.');
      }
      if (httpError.response?.status === 429) {
        throw new Error('Tavily rate limit exceeded. Please try again later.');
      }
      throw new Error(`Tavily search failed: ${httpError.message}`);
    }
  }

  private trackUsage(searchDepth: string) {
    this.usageStats.totalSearches++;
    if (searchDepth === 'basic') {
      this.usageStats.basicSearches++;
      this.usageStats.totalCreditsUsed += 1;
    } else {
      this.usageStats.advancedSearches++;
      this.usageStats.totalCreditsUsed += 2;
    }
  }

  getUsageStats(): TavilyUsageStats {
    return { ...this.usageStats };
  }

  resetUsageStats() {
    this.usageStats = {
      totalSearches: 0,
      basicSearches: 0,
      advancedSearches: 0,
      totalCreditsUsed: 0
    };
  }

  async isConfigured(): Promise<boolean> {
    const key = await this.context.secrets.get('moby.tavilyApiKey');
    return (!!key && key.trim().length > 0) || !!process.env.TAVILY_API_KEY;
  }

  async getApiUsage(): Promise<TavilyApiUsage> {
    const apiKey = await this.getApiKey();

    try {
      const response = await this.httpClient.get<{
        key?: { limit?: number | null; usage?: number };
        account?: {
          current_plan?: string;
          plan_usage?: number;
          plan_limit?: number;
        };
      }>('/usage', {
        headers: {
          Authorization: `Bearer ${apiKey}`
        }
      });

      const keyData = response.data.key || {};
      const accountData = response.data.account || {};

      // Prefer account-level plan data (always has limit), fall back to key-level
      const used = accountData.plan_usage ?? keyData.usage ?? 0;
      const limit = accountData.plan_limit ?? keyData.limit ?? null;

      return {
        remaining: limit != null ? limit - used : null,
        limit,
        plan: accountData.current_plan || 'Unknown',
        used
      };
    } catch (error: unknown) {
      const httpError = error as HttpError;
      if (httpError.response?.status === 401) {
        throw new Error('Invalid Tavily API key');
      }
      throw new Error(`Failed to fetch Tavily usage: ${httpError.message}`);
    }
  }
}
