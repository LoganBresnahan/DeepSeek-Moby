import * as vscode from 'vscode';
import axios, { AxiosInstance } from 'axios';
import { FormattingEngine } from './utils/formatting';
import { ConfigManager } from './utils/config';

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

export interface FIMResponse {
  completion: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
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
  private axiosInstance: AxiosInstance;
  private betaAxiosInstance: AxiosInstance;
  private formattingEngine: FormattingEngine;
  private config: ConfigManager;
  private context: vscode.ExtensionContext;
  private conversationHistory: Message[] = [];
  private modelOverride: string | null = null;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.config = ConfigManager.getInstance();
    this.formattingEngine = new FormattingEngine();

    // Standard API endpoint
    this.axiosInstance = axios.create({
      baseURL: 'https://api.deepseek.com',
      timeout: 60000,
      headers: {
        'Content-Type': 'application/json',
      }
    });

    // Beta API endpoint (for FIM)
    this.betaAxiosInstance = axios.create({
      baseURL: 'https://api.deepseek.com/beta',
      timeout: 60000,
      headers: {
        'Content-Type': 'application/json',
      }
    });

    this.loadConversationHistory();
  }

  private getApiKey(): string {
    const apiKey = this.config.get<string>('apiKey');
    if (!apiKey) {
      throw new Error('DeepSeek API key is not configured. Please set it in settings.');
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

  // Standard chat completion
  async chat(messages: Message[], systemPrompt?: string, options?: ChatOptions): Promise<ChatResponse> {
    try {
      const apiKey = this.getApiKey();
      const model = this.getModel();
      const temperature = options?.temperature ?? this.config.get<number>('temperature') ?? 0.7;
      const maxTokens = options?.maxTokens ?? this.config.get<number>('maxTokens') ?? 2048;

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

      const response = await this.axiosInstance.post('/chat/completions', requestBody, {
        headers: {
          'Authorization': `Bearer ${apiKey}`
        }
      });

      const message = response.data.choices[0].message;
      const content = message.content || '';
      const reasoning_content = message.reasoning_content;
      const tool_calls = message.tool_calls;
      const usage = response.data.usage;

      return { content, reasoning_content, tool_calls, usage };
    } catch (error: any) {
      console.error('DeepSeek API error:', error.response?.data || error.message);
      throw this.handleError(error);
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
      const apiKey = this.getApiKey();
      const model = this.getModel();
      const temperature = options?.temperature ?? this.config.get<number>('temperature') ?? 0.7;
      const maxTokens = options?.maxTokens ?? this.config.get<number>('maxTokens') ?? 2048;

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

      const response = await this.axiosInstance.post('/chat/completions', requestBody, {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Accept': 'text/event-stream'
        },
        responseType: 'stream',
        signal: options?.signal
      });

      return new Promise((resolve, reject) => {
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

        response.data.on('data', (chunk: Buffer) => {
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

        response.data.on('error', (error: any) => {
          if (!resolved) {
            resolved = true;
            clearInactivityTimer();
            reject(this.handleError(error));
          }
        });

        response.data.on('end', () => {
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
    } catch (error: any) {
      console.error('DeepSeek stream error:', error);
      throw this.handleError(error);
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

  // FIM (Fill-in-Middle) completion - uses beta endpoint
  async fimCompletion(
    prefix: string,
    suffix: string,
    maxTokens: number = 128
  ): Promise<FIMResponse> {
    try {
      const apiKey = this.getApiKey();

      const response = await this.betaAxiosInstance.post('/completions', {
        model: 'deepseek-chat',
        prompt: prefix,
        suffix: suffix,
        max_tokens: maxTokens,
        temperature: 0.2,
        stop: ['\n\n', '```']
      }, {
        headers: {
          'Authorization': `Bearer ${apiKey}`
        }
      });

      const completion = response.data.choices[0]?.text || '';
      const usage = response.data.usage;

      return { completion, usage };
    } catch (error: any) {
      console.error('DeepSeek FIM error:', error.response?.data || error.message);
      throw this.handleError(error);
    }
  }

  // Get code completions using FIM
  async getCodeCompletions(prompt: string, language: string, maxTokens: number = 100): Promise<string[]> {
    try {
      const apiKey = this.getApiKey();

      // Use the beta endpoint for FIM
      const response = await this.betaAxiosInstance.post('/completions', {
        model: 'deepseek-chat',
        prompt,
        max_tokens: maxTokens,
        temperature: 0.2,
        stop: ['\n\n', '```', '\n#', '\n//', '\n/*']
      }, {
        headers: {
          'Authorization': `Bearer ${apiKey}`
        }
      });

      const completions = response.data.choices.map((choice: any) => {
        let completion = choice.text;

        // Apply formatting if enabled
        if (this.config.get<boolean>('autoFormat')) {
          completion = this.formattingEngine.formatCode(completion, language);
        }

        return completion;
      });

      return completions;
    } catch (error: any) {
      console.error('DeepSeek completions error:', error);
      throw this.handleError(error);
    }
  }

  // Context-aware FIM completion for editor
  async getContextualFIMCompletion(
    editor: vscode.TextEditor,
    position: vscode.Position
  ): Promise<string> {
    const document = editor.document;
    const text = document.getText();
    const offset = document.offsetAt(position);

    const prefix = text.substring(0, offset);
    const suffix = text.substring(offset);

    // Limit context size
    const maxPrefixChars = 4000;
    const maxSuffixChars = 2000;

    const limitedPrefix = prefix.length > maxPrefixChars
      ? prefix.substring(prefix.length - maxPrefixChars)
      : prefix;
    const limitedSuffix = suffix.length > maxSuffixChars
      ? suffix.substring(0, maxSuffixChars)
      : suffix;

    const result = await this.fimCompletion(limitedPrefix, limitedSuffix, 128);
    return result.completion;
  }

  // Formatting methods
  async formatCodeResponse(code: string, language: string, context?: string): Promise<string> {
    const autoFormat = this.config.get<boolean>('autoFormat');
    const useLanguageFormatter = this.config.get<boolean>('useLanguageFormatter');

    let formattedCode = code;

    // Step 1: Clean up markdown code blocks
    formattedCode = this.formattingEngine.extractCodeFromMarkdown(formattedCode);

    // Step 2: Apply DeepSeek's smart formatting
    if (autoFormat) {
      formattedCode = this.formattingEngine.formatCode(formattedCode, language, context);
    }

    // Step 3: Use VS Code's formatter for final polish
    if (useLanguageFormatter) {
      formattedCode = await this.formattingEngine.applyVSCodeFormatter(formattedCode, language);
    }

    return formattedCode;
  }

  async getContextualCompletion(editor: vscode.TextEditor, position: vscode.Position): Promise<string> {
    const document = editor.document;
    const language = document.languageId;

    // Get context around cursor
    const line = position.line;
    const startLine = Math.max(0, line - 10);
    const endLine = Math.min(document.lineCount, line + 10);

    let context = '';
    for (let i = startLine; i < endLine; i++) {
      context += document.lineAt(i).text + '\n';
    }

    // Get current line prefix
    const lineText = document.lineAt(line).text;
    const prefix = lineText.substring(0, position.character);

    const prompt = `${context}\n// Complete the following:\n${prefix}`;

    const completions = await this.getCodeCompletions(prompt, language, 50);
    return completions[0] || '';
  }

  // Token estimation for chat history
  estimateTokens(text: string): number {
    // Rough estimate: 1 token ≈ 4 characters for English
    return Math.ceil(text.length / 4);
  }

  // Conversation management (for backward compatibility)
  getConversationHistory(): Message[] {
    return [...this.conversationHistory];
  }

  clearConversationHistory() {
    this.conversationHistory = [];
    this.saveConversationHistory();
  }

  private saveConversationHistory() {
    this.context.globalState.update('conversationHistory', this.conversationHistory);
  }

  private loadConversationHistory() {
    const saved = this.context.globalState.get<Message[]>('conversationHistory');
    if (saved) {
      this.conversationHistory = saved;
    }
  }

  private handleError(error: any): Error {
    if (error.response) {
      switch (error.response.status) {
        case 401:
          return new Error('Invalid API key. Please check your DeepSeek API key in settings.');
        case 429:
          return new Error('Rate limit exceeded. Please wait before making more requests.');
        case 500:
          return new Error('DeepSeek API server error. Please try again later.');
        default:
          return new Error(`API error: ${error.response.data?.error?.message || error.message}`);
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
      const apiKey = this.getApiKey();
      const response = await this.axiosInstance.get('/user/balance', {
        headers: {
          'Authorization': `Bearer ${apiKey}`
        }
      });

      const data = response.data;
      if (data.balance_infos && data.balance_infos.length > 0) {
        // Prefer USD, fall back to first available
        const usdBalance = data.balance_infos.find((b: any) => b.currency === 'USD');
        const balanceInfo = usdBalance || data.balance_infos[0];
        return {
          available: data.is_available,
          balance: balanceInfo.total_balance,
          currency: balanceInfo.currency
        };
      }
      return null;
    } catch (error: any) {
      console.error('Failed to fetch balance:', error.message);
      return null;
    }
  }

  dispose() {
    // Cleanup if needed
  }
}
