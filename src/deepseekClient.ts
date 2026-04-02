import * as vscode from 'vscode';
import { HttpClient, HttpError, createStreamReader } from './utils/httpClient';
import { ConfigManager } from './utils/config';
import { logger } from './utils/logger';
import { TokenCounter, EstimationTokenCounter, countRequestTokens } from './services/tokenCounter';
import { ContextBuilder, ContextResult, SnapshotSummary } from './context/contextBuilder';

export type MessageContent = string | Array<{
  type: 'text';
  text: string;
} | {
  type: 'image_url';
  image_url: { url: string };
}>;

export interface Message {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: MessageContent;
  timestamp?: Date;
  tokens?: number;
  reasoning_content?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
  /** Event store ID — used by ContextBuilder for token count caching */
  eventId?: string;
}

export interface ToolFunction {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, { type: string; description: string; enum?: string[] }>;
    required?: string[];
  };
}

export interface Tool {
  type: 'function';
  function: ToolFunction;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatResponse {
  content: string;
  reasoning_content?: string;
  tool_calls?: ToolCall[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
  };
}

export interface ChatOptions {
  tools?: Tool[];
  jsonMode?: boolean;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export class DeepSeekClient {
  private httpClient: HttpClient;
  private config: ConfigManager;
  private context: vscode.ExtensionContext;
  private modelOverride: string | null = null;
  private tokenCounter: TokenCounter;
  private contextBuilder: ContextBuilder;

  constructor(context: vscode.ExtensionContext, tokenCounter?: TokenCounter) {
    this.context = context;
    this.config = ConfigManager.getInstance();
    this.tokenCounter = tokenCounter ?? new EstimationTokenCounter();
    this.contextBuilder = new ContextBuilder(this.tokenCounter);

    // Standard API endpoint
    this.httpClient = new HttpClient({
      baseURL: 'https://api.deepseek.com',
      timeout: 60000,
      headers: {
        'Content-Type': 'application/json',
      }
    });

  }

  async isApiKeyConfigured(): Promise<boolean> {
    const key = await this.context.secrets.get('moby.apiKey');
    return !!key;
  }

  private async getApiKey(): Promise<string> {
    const apiKey = await this.context.secrets.get('moby.apiKey');
    if (!apiKey) {
      throw new Error('DeepSeek API key is not configured. Use the "DeepSeek Moby: Set API Key" command.');
    }
    return apiKey;
  }

  getModel(): string {
    // Use override if set (for immediate model changes before config propagates)
    return this.modelOverride ?? this.config.get<string>('model') ?? 'deepseek-chat';
  }

  setModel(model: string): void {
    // Set override for immediate effect, VS Code config may have propagation delay
    this.modelOverride = model;
  }

  isReasonerModel(): boolean {
    return this.getModel() === 'deepseek-reasoner';
  }

  /**
   * Get the maximum allowed output tokens for the current model.
   * deepseek-chat: 8192
   * deepseek-reasoner: 65536
   */
  getModelMaxTokens(): number {
    return this.isReasonerModel() ? 65536 : 8192;
  }

  /** Read the per-model maxTokens from VS Code config. */
  private getConfigMaxTokens(): number {
    if (this.isReasonerModel()) {
      return this.config.get<number>('maxTokensReasonerModel') ?? 65536;
    }
    return this.config.get<number>('maxTokensChatModel') ?? 8192;
  }

  /**
   * Clamp max_tokens to the model's valid range [1, modelMax]
   */
  private clampMaxTokens(maxTokens: number): number {
    const modelMax = this.getModelMaxTokens();
    const clamped = Math.max(1, Math.min(maxTokens, modelMax));
    if (clamped !== maxTokens) {
      logger.info(`max_tokens clamped: ${maxTokens} → ${clamped} (model limit: ${modelMax})`);
    }
    return clamped;
  }

  // Standard chat completion
  async chat(messages: Message[], systemPrompt?: string, options?: ChatOptions): Promise<ChatResponse> {
    try {
      const apiKey = await this.getApiKey();
      const model = this.getModel();
      const temperature = options?.temperature ?? this.config.get<number>('temperature') ?? 0.7;
      const rawMaxTokens = options?.maxTokens ?? this.getConfigMaxTokens();
      const maxTokens = this.clampMaxTokens(rawMaxTokens);

      const requestMessages = [...messages].map(m => ({
        role: m.role,
        content: m.content,
        ...(m.tool_call_id && { tool_call_id: m.tool_call_id }),
        ...(m.tool_calls && { tool_calls: m.tool_calls })
      }));

      if (systemPrompt) {
        requestMessages.unshift({ role: 'system', content: systemPrompt });
      }

      const requestBody: any = {
        model,
        messages: requestMessages,
        max_tokens: maxTokens,
        stream: false
      };

      // Don't set temperature for reasoner model
      if (!this.isReasonerModel()) {
        requestBody.temperature = temperature;
      }

      // Add JSON mode if requested
      if (options?.jsonMode) {
        requestBody.response_format = { type: 'json_object' };
      }

      // Add tools if provided (not supported for reasoner)
      if (options?.tools && options.tools.length > 0 && !this.isReasonerModel()) {
        requestBody.tools = options.tools;
      }

      const response = await this.httpClient.post<{
        choices: Array<{ message: { content?: string; reasoning_content?: string; tool_calls?: ToolCall[] } }>;
        usage?: ChatResponse['usage'];
      }>('/chat/completions', requestBody, {
        headers: {
          'Authorization': `Bearer ${apiKey}`
        }
      });

      const message = response.data.choices[0].message;
      const content = message.content || '';
      const reasoning_content = message.reasoning_content;
      const tool_calls = message.tool_calls;
      const usage = response.data.usage;

      // Cross-validate our token count against the API's
      // Note: systemPrompt is already unshifted into requestMessages above
      this.crossValidateTokens(requestMessages, usage, requestBody.tools);

      return { content, reasoning_content, tool_calls, usage };
    } catch (error: unknown) {
      const httpError = error as HttpError;
      const errorData = httpError.response?.data as { error?: { message?: string } } | undefined;
      logger.apiError('DeepSeek API error', errorData?.error?.message || httpError.message);
      throw this.handleError(httpError);
    }
  }

  // Streaming chat completion with reasoning support
  async streamChat(
    messages: Message[],
    onToken: (token: string) => void,
    systemPrompt?: string,
    onReasoning?: (token: string) => void,
    options?: ChatOptions
  ): Promise<ChatResponse> {
    try {
      const apiKey = await this.getApiKey();
      const model = this.getModel();
      const temperature = options?.temperature ?? this.config.get<number>('temperature') ?? 0.7;
      const rawMaxTokens = options?.maxTokens ?? this.getConfigMaxTokens();
      const maxTokens = this.clampMaxTokens(rawMaxTokens);

      const requestMessages = [...messages].map(m => ({
        role: m.role,
        content: m.content,
        ...(m.tool_call_id && { tool_call_id: m.tool_call_id }),
        ...(m.tool_calls && { tool_calls: m.tool_calls })
      }));

      if (systemPrompt) {
        requestMessages.unshift({ role: 'system', content: systemPrompt });
      }

      const requestBody: any = {
        model,
        messages: requestMessages,
        max_tokens: maxTokens,
        stream: true
      };

      // Don't set temperature for reasoner model
      if (!this.isReasonerModel()) {
        requestBody.temperature = temperature;
      }

      // Add JSON mode if requested
      if (options?.jsonMode) {
        requestBody.response_format = { type: 'json_object' };
      }

      const response = await this.httpClient.post<ReadableStream<Uint8Array>>('/chat/completions', requestBody, {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Accept': 'text/event-stream'
        },
        responseType: 'stream',
        signal: options?.signal
      });

      const stream = createStreamReader(response.data);

      const result = await new Promise<ChatResponse>((resolve, reject) => {
        let fullResponse = '';
        let fullReasoning = '';
        let usage: ChatResponse['usage'];
        let resolved = false;  // Prevent double resolution

        // Inactivity timeout - resolve if no data for 30 seconds
        const INACTIVITY_TIMEOUT_MS = 30000;
        let inactivityTimer: NodeJS.Timeout | null = null;

        const clearInactivityTimer = () => {
          if (inactivityTimer) {
            clearTimeout(inactivityTimer);
            inactivityTimer = null;
          }
        };

        const resetInactivityTimer = () => {
          clearInactivityTimer();
          inactivityTimer = setTimeout(() => {
            if (!resolved && (fullResponse || fullReasoning)) {
              resolved = true;
              resolve({
                content: fullResponse,
                reasoning_content: fullReasoning || undefined,
                usage: usage || {
                  prompt_tokens: this.estimateTokens(JSON.stringify(requestMessages)),
                  completion_tokens: this.estimateTokens(fullResponse),
                  total_tokens: 0
                }
              });
            }
          }, INACTIVITY_TIMEOUT_MS);
        };

        // Start the inactivity timer
        resetInactivityTimer();

        stream.on('data', (chunk: Buffer) => {
          // Reset inactivity timer on each data chunk
          resetInactivityTimer();

          const lines = chunk.toString().split('\n').filter(line => line.trim() !== '');

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6);

              if (data === '[DONE]') {
                if (!resolved) {
                  resolved = true;
                  clearInactivityTimer();
                  resolve({
                    content: fullResponse,
                    reasoning_content: fullReasoning || undefined,
                    usage: usage || {
                      prompt_tokens: this.estimateTokens(JSON.stringify(requestMessages)),
                      completion_tokens: this.estimateTokens(fullResponse),
                      total_tokens: 0
                    }
                  });
                }
                return;
              }

              try {
                const parsed = JSON.parse(data);
                const delta = parsed.choices[0]?.delta;

                // Handle reasoning content (for deepseek-reasoner)
                if (delta?.reasoning_content && onReasoning) {
                  fullReasoning += delta.reasoning_content;
                  onReasoning(delta.reasoning_content);
                }

                // Handle regular content
                if (delta?.content) {
                  fullResponse += delta.content;
                  onToken(delta.content);
                }

                // Capture usage if present
                if (parsed.usage) {
                  usage = parsed.usage;
                }
              } catch (e) {
                // Ignore parsing errors for partial data
              }
            }
          }
        });

        stream.on('error', (error: Error) => {
          if (!resolved) {
            resolved = true;
            clearInactivityTimer();
            reject(this.handleError(error as HttpError));
          }
        });

        stream.on('end', () => {
          // Always resolve if we have data, even if [DONE] wasn't received
          if (!resolved) {
            resolved = true;
            clearInactivityTimer();
            if (fullResponse || fullReasoning) {
              resolve({
                content: fullResponse,
                reasoning_content: fullReasoning || undefined,
                usage: usage || {
                  prompt_tokens: this.estimateTokens(JSON.stringify(requestMessages)),
                  completion_tokens: this.estimateTokens(fullResponse),
                  total_tokens: 0
                }
              });
            } else {
              reject(new Error('No response received from DeepSeek'));
            }
          }
        });
      });

      // Cross-validate our token count against the API's
      // Note: systemPrompt is already unshifted into requestMessages above
      this.crossValidateTokens(requestMessages, result.usage);

      return result;
    } catch (error: unknown) {
      const httpError = error as HttpError;
      logger.apiError('DeepSeek stream error', httpError.message);
      throw this.handleError(httpError);
    }
  }

  // Chat with tools/function calling
  async chatWithTools(
    messages: Message[],
    tools: Tool[],
    systemPrompt?: string
  ): Promise<ChatResponse> {
    if (this.isReasonerModel()) {
      throw new Error('Function calling is not supported with deepseek-reasoner model');
    }
    return this.chat(messages, systemPrompt, { tools });
  }

  // Chat with JSON output mode
  async chatWithJsonOutput(
    messages: Message[],
    systemPrompt?: string
  ): Promise<ChatResponse> {
    // Ensure system prompt mentions JSON
    const jsonSystemPrompt = systemPrompt
      ? `${systemPrompt}\n\nRespond with valid JSON only.`
      : 'Respond with valid JSON only.';

    return this.chat(messages, jsonSystemPrompt, { jsonMode: true });
  }

  // Token estimation for chat history (uses calibrating estimation counter)
  estimateTokens(text: string): number {
    return this.tokenCounter.count(text);
  }

  /**
   * Build an optimized context window that fits within the model's token budget.
   * Drops oldest messages first, optionally injects a snapshot summary.
   */
  async buildContext(
    messages: Message[],
    systemPrompt?: string,
    snapshotSummary?: SnapshotSummary
  ): Promise<ContextResult> {
    return this.contextBuilder.build(messages, systemPrompt, this.getModel(), snapshotSummary);
  }

  /**
   * Calibrate the token estimator using actual API usage data.
   * Only applies when using EstimationTokenCounter (no-op for exact WASM counter).
   */
  calibrateTokenEstimation(inputCharCount: number, actualPromptTokens: number): void {
    if (this.tokenCounter instanceof EstimationTokenCounter) {
      this.tokenCounter.calibrate(inputCharCount, actualPromptTokens);
      logger.info(
        `[TokenCounter] Calibrated: ratio=${this.tokenCounter.ratio.toFixed(4)}, ` +
        `samples=${this.tokenCounter.sampleCount}`
      );
    }
  }

  /**
   * Cross-validate our token count against the API's usage.prompt_tokens.
   * Counts everything in the request: content, tool calls, tool definitions.
   * Logs the delta as a percentage. Also calibrates the estimation counter.
   */
  private crossValidateTokens(
    requestMessages: Array<{ role: string; content: MessageContent; tool_calls?: ToolCall[]; tool_call_id?: string }>,
    usage: ChatResponse['usage'],
    tools?: Tool[]
  ): void {
    if (!usage?.prompt_tokens) { return; }

    // systemPrompt is already in requestMessages (unshifted before the API call),
    // so we pass undefined — countRequestTokens will count it via the messages loop.
    const ourCount = countRequestTokens(this.tokenCounter, requestMessages, undefined, tools);
    const apiCount = usage.prompt_tokens;
    const delta = apiCount - ourCount;
    const deltaPercent = apiCount > 0 ? ((delta / apiCount) * 100).toFixed(1) : '0.0';

    logger.info(
      `[TokenCV] ours=${ourCount.toLocaleString()} api=${apiCount.toLocaleString()} ` +
      `delta=${delta > 0 ? '+' : ''}${delta} (${deltaPercent}%) ` +
      `[${this.tokenCounter.isExact ? 'WASM' : 'estimation'}]`
    );

    // Calibrate estimation counter with actual data
    if (this.tokenCounter instanceof EstimationTokenCounter) {
      const charCount = requestMessages.reduce((sum, msg) => {
        const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
        return sum + text.length;
      }, 0);
      this.calibrateTokenEstimation(charCount, apiCount);
    }
  }

  private handleError(error: HttpError): Error {
    if (error.response) {
      switch (error.response.status) {
        case 401:
          return new Error('Invalid API key. Please check your DeepSeek API key in settings.');
        case 429:
          return new Error('Rate limit exceeded. Please wait before making more requests.');
        case 500:
          return new Error('DeepSeek API server error. Please try again later.');
        default: {
          const errorData = error.response.data as { error?: { message?: string } } | undefined;
          return new Error(`API error: ${errorData?.error?.message || error.message}`);
        }
      }
    }
    if (error.code === 'ENOTFOUND') {
      return new Error('Cannot connect to DeepSeek API. Check your internet connection.');
    }
    return new Error(error.message || 'Unknown error occurred');
  }

  // Fetch account balance from DeepSeek API
  async getBalance(): Promise<{ available: boolean; balance: string; currency: string } | null> {
    try {
      const apiKey = await this.getApiKey();
      const response = await this.httpClient.get<{
        is_available: boolean;
        balance_infos: Array<{ currency: string; total_balance: string }>;
      }>('/user/balance', {
        headers: {
          'Authorization': `Bearer ${apiKey}`
        }
      });

      const data = response.data;
      if (data.balance_infos && data.balance_infos.length > 0) {
        // Prefer USD, fall back to first available
        const usdBalance = data.balance_infos.find((b) => b.currency === 'USD');
        const balanceInfo = usdBalance || data.balance_infos[0];
        return {
          available: data.is_available,
          balance: balanceInfo.total_balance,
          currency: balanceInfo.currency
        };
      }
      return null;
    } catch (error: unknown) {
      const httpError = error as HttpError;
      logger.apiError('Failed to fetch balance', httpError.message);
      return null;
    }
  }

  dispose() {
    // Cleanup if needed
  }
}
