import * as vscode from 'vscode';
import axios, { AxiosInstance } from 'axios';
import { ConfigManager } from '../utils/config';

export interface TavilySearchResult {
  title: string;
  url: string;
  content: string;
  score: number;
}

export interface TavilySearchResponse {
  results: TavilySearchResult[];
  answer?: string;
  query: string;
  responseTime: number;
}

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

export class TavilyClient {
  private axiosInstance: AxiosInstance;
  private config: ConfigManager;
  private context: vscode.ExtensionContext;
  private usageStats: TavilyUsageStats;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.config = ConfigManager.getInstance();

    this.axiosInstance = axios.create({
      baseURL: 'https://api.tavily.com',
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json'
      }
    });

    this.usageStats = this.loadUsageStats();
  }

  private getApiKey(): string {
    const apiKey = this.config.get<string>('tavilyApiKey');
    if (!apiKey) {
      throw new Error('Tavily API key is not configured. Please set it in settings.');
    }
    return apiKey;
  }

  async search(query: string, options?: { searchDepth?: 'basic' | 'advanced' }): Promise<TavilySearchResponse> {
    const apiKey = this.getApiKey();
    const searchDepth = options?.searchDepth || this.config.get<string>('tavilySearchDepth') || 'basic';

    try {
      const response = await this.axiosInstance.post('/search', {
        api_key: apiKey,
        query,
        search_depth: searchDepth,
        include_answer: true,
        max_results: 5
      });

      this.trackUsage(searchDepth);

      return {
        results: response.data.results || [],
        answer: response.data.answer,
        query: response.data.query || query,
        responseTime: response.data.response_time || 0
      };
    } catch (error: any) {
      if (error.response?.status === 401) {
        throw new Error('Invalid Tavily API key. Please check your settings.');
      }
      if (error.response?.status === 429) {
        throw new Error('Tavily rate limit exceeded. Please try again later.');
      }
      throw new Error(`Tavily search failed: ${error.message}`);
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
    this.saveUsageStats();
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
    this.saveUsageStats();
  }

  private loadUsageStats(): TavilyUsageStats {
    const saved = this.context.globalState.get<TavilyUsageStats>('tavilyUsageStats');
    return saved || {
      totalSearches: 0,
      basicSearches: 0,
      advancedSearches: 0,
      totalCreditsUsed: 0
    };
  }

  private saveUsageStats() {
    this.context.globalState.update('tavilyUsageStats', this.usageStats);
  }

  isConfigured(): boolean {
    const key = this.config.get<string>('tavilyApiKey');
    return !!key && key.trim().length > 0;
  }

  async getApiUsage(): Promise<TavilyApiUsage> {
    const apiKey = this.getApiKey();

    try {
      const response = await this.axiosInstance.get('/usage', {
        headers: {
          Authorization: `Bearer ${apiKey}`
        }
      });

      const keyData = response.data.key || {};
      const accountData = response.data.account || {};

      return {
        remaining: keyData.limit ? keyData.limit - keyData.usage : null,
        limit: keyData.limit || null,
        plan: accountData.current_plan || 'Unknown',
        used: keyData.usage || 0
      };
    } catch (error: any) {
      if (error.response?.status === 401) {
        throw new Error('Invalid Tavily API key');
      }
      throw new Error(`Failed to fetch Tavily usage: ${error.message}`);
    }
  }
}
