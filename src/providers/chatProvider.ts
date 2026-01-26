import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { DeepSeekClient, Message as ApiMessage, ToolCall } from '../deepseekClient';
import { StatusBar } from '../views/statusBar';
import { ChatHistoryManager } from '../chatHistory/ChatHistoryManager';
import { DiffEngine } from '../utils/diff';
import { logger } from '../utils/logger';
import { workspaceTools, executeToolCall } from '../tools/workspaceTools';
import { parseDSMLToolCalls, stripDSML } from '../utils/dsmlParser';
import { TavilyClient, TavilySearchResponse } from '../clients/tavilyClient';

export class ChatProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'deepseek-chat-view';
  private _view?: vscode.WebviewView;
  private deepSeekClient: DeepSeekClient;
  private statusBar: StatusBar;
  private chatHistoryManager: ChatHistoryManager;
  private currentSessionId: string | null = null;
  private lastActiveEditorUri: vscode.Uri | null = null;
  private abortController: AbortController | null = null;
  private diffEngine: DiffEngine;
  private activeDiffUri: vscode.Uri | null = null;
  private disposables: vscode.Disposable[] = [];
  private tavilyClient: TavilyClient;
  private webSearchEnabled: boolean = false;
  private webSearchSettings: { searchesPerPrompt: number; searchDepth: 'basic' | 'advanced' } = {
    searchesPerPrompt: 1,
    searchDepth: 'basic'
  };
  private searchCache: Map<string, { results: string; timestamp: number }> = new Map();

  constructor(
    private readonly _extensionUri: vscode.Uri,
    deepSeekClient: DeepSeekClient,
    statusBar: StatusBar,
    chatHistoryManager: ChatHistoryManager,
    tavilyClient: TavilyClient
  ) {
    this.deepSeekClient = deepSeekClient;
    this.statusBar = statusBar;
    this.chatHistoryManager = chatHistoryManager;
    this.diffEngine = new DiffEngine();
    this.tavilyClient = tavilyClient;

    // Load current session
    this.loadCurrentSession();

    // Track when diff editors are closed
    this.disposables.push(
      vscode.window.onDidChangeVisibleTextEditors((editors) => {
        if (this.activeDiffUri) {
          // Check if our diff editor is still visible
          const diffStillOpen = editors.some(e =>
            e.document.uri.scheme === 'deepseek-diff'
          );
          if (!diffStillOpen) {
            this.activeDiffUri = null;
            this.notifyDiffClosed();
          }
        }
      })
    );
  }

  public dispose() {
    this.disposables.forEach(d => d.dispose());
  }

  private notifyDiffClosed() {
    if (this._view) {
      this._view.webview.postMessage({ type: 'diffClosed' });
    }
  }

  private async loadCurrentSession() {
    const currentSession = await this.chatHistoryManager.getCurrentSession();
    if (currentSession) {
      this.currentSessionId = currentSession.id;
    }
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri]
    };

    webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (data) => {
      switch (data.type) {
        case 'sendMessage':
          await this.handleUserMessage(data.message, data.attachments);
          break;
        case 'clearChat':
          this.clearConversation();
          break;
        case 'applyCode':
          await this.applyCode(data.code, data.language);
          break;
        case 'showDiff':
          await this.showDiff(data.code, data.language);
          break;
        case 'closeDiff':
          await this.closeDiff();
          break;
        case 'loadHistory':
          await this.loadCurrentSessionHistory();
          break;
        case 'stopGeneration':
          this.stopGeneration();
          break;
        case 'updateSettings':
          await this.updateSettings(data.settings);
          break;
        case 'getSettings':
          this.sendCurrentSettings();
          break;
        case 'executeCommand':
          vscode.commands.executeCommand(data.command);
          break;
        case 'toggleWebSearch':
          this.toggleWebSearch(data.enabled);
          break;
        case 'updateWebSearchSettings':
          this.updateWebSearchSettings(data.settings);
          break;
        case 'getWebSearchSettings':
          this.sendWebSearchSettings();
          break;
        case 'clearSearchCache':
          this.clearSearchCache();
          break;
      }
    });

    // Load conversation history for current session
    this.loadCurrentSessionHistory();
  }

  public reveal() {
    if (this._view) {
      this._view.show?.(true);
    }
  }

  public async clearConversation() {
    // Clear current conversation but keep session
    if (this._view) {
      this._view.webview.postMessage({ type: 'clearChat' });
    }

    // Clear search cache on new session
    this.searchCache.clear();

    // Create a new session for fresh conversation
    const editor = vscode.window.activeTextEditor;
    const language = editor?.document.languageId;
    const session = await this.chatHistoryManager.startNewSession(
      undefined,
      this.deepSeekClient.getModel(),
      language
    );
    this.currentSessionId = session.id;
    logger.sessionStart(session.id, session.title);
  }

  private stopGeneration() {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
      logger.apiAborted();
    }
    if (this._view) {
      this._view.webview.postMessage({ type: 'generationStopped' });
    }
  }

  private async updateSettings(settings: { model?: string; temperature?: number; maxToolCalls?: number }) {
    const config = vscode.workspace.getConfiguration('deepseek');

    if (settings.model !== undefined) {
      await config.update('model', settings.model, vscode.ConfigurationTarget.Global);
      logger.modelChanged(settings.model);
    }

    if (settings.temperature !== undefined) {
      await config.update('temperature', settings.temperature, vscode.ConfigurationTarget.Global);
      logger.settingsChanged('temperature', settings.temperature);
    }

    if (settings.maxToolCalls !== undefined) {
      await config.update('maxToolCalls', settings.maxToolCalls, vscode.ConfigurationTarget.Global);
      logger.settingsChanged('maxToolCalls', settings.maxToolCalls);
    }
  }

  private sendCurrentSettings() {
    const config = vscode.workspace.getConfiguration('deepseek');
    const model = config.get<string>('model') || 'deepseek-chat';
    const temperature = config.get<number>('temperature') ?? 0.7;
    const maxToolCalls = config.get<number>('maxToolCalls') ?? 25;

    if (this._view) {
      this._view.webview.postMessage({
        type: 'settings',
        model,
        temperature,
        maxToolCalls
      });
    }
  }

  private toggleWebSearch(enabled: boolean) {
    this.webSearchEnabled = enabled;
    if (enabled && !this.tavilyClient.isConfigured()) {
      this._view?.webview.postMessage({
        type: 'warning',
        message: 'Tavily API key not configured. Please set it in VS Code settings (deepseek.tavilyApiKey).'
      });
      this.webSearchEnabled = false;
      this._view?.webview.postMessage({ type: 'webSearchToggled', enabled: false });
      return;
    }
    this._view?.webview.postMessage({ type: 'webSearchToggled', enabled });
  }

  private updateWebSearchSettings(settings: { searchesPerPrompt?: number; searchDepth?: 'basic' | 'advanced' }) {
    if (settings.searchesPerPrompt !== undefined) {
      this.webSearchSettings.searchesPerPrompt = settings.searchesPerPrompt;
    }
    if (settings.searchDepth !== undefined) {
      this.webSearchSettings.searchDepth = settings.searchDepth;
    }
  }

  private sendWebSearchSettings() {
    this._view?.webview.postMessage({
      type: 'webSearchSettings',
      enabled: this.webSearchEnabled,
      settings: this.webSearchSettings,
      configured: this.tavilyClient.isConfigured()
    });
  }

  private clearSearchCache() {
    this.searchCache.clear();
    logger.webSearchCacheCleared();
    this._view?.webview.postMessage({
      type: 'searchCacheCleared'
    });
  }

  private formatSearchResults(response: TavilySearchResponse): string {
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

  public getTavilyClient(): TavilyClient {
    return this.tavilyClient;
  }

  private async handleUserMessage(message: string, attachments?: Array<{base64: string, mimeType: string, name: string}>) {
    if (!this._view) {
      return;
    }

    // Get or create current session
    if (!this.currentSessionId) {
      const editor = vscode.window.activeTextEditor;
      const language = editor?.document.languageId;
      const session = await this.chatHistoryManager.startNewSession(
        message,
        this.deepSeekClient.getModel(),
        language
      );
      this.currentSessionId = session.id;
    }

    // Save user message to history (UI already shows it from frontend)
    if (this.currentSessionId) {
      await this.chatHistoryManager.addMessageToCurrentSession({
        role: 'user',
        content: message,
        tokens: this.deepSeekClient.estimateTokens(message)
      });
    }

    // Get active editor context
    const editorContext = await this.getEditorContext();
    const isReasonerModel = this.deepSeekClient.isReasonerModel();

    let systemPrompt = `You are DeepSeek Moby, an expert programming assistant integrated into VS Code.
`;

    // Only add tool instructions for non-reasoner models (reasoner can't use tools)
    if (!isReasonerModel) {
      systemPrompt += `
You have access to tools that let you explore the codebase:
- read_file: Read contents of any file in the workspace
- search_files: Find files by name pattern (glob)
- grep_content: Search for text/patterns in file contents
- list_directory: See directory structure
- get_file_info: Get file metadata and preview

USE THESE TOOLS to understand the codebase before making suggestions. When the user asks about code or wants changes:
1. First explore relevant files using the tools
2. Read the actual source code to understand the context
3. Then provide accurate, informed responses
`;
    }

    systemPrompt += `
IMPORTANT - When writing code changes:
1. Include 2-3 UNCHANGED context lines BEFORE and AFTER your changes (this helps locate where to insert)
2. Keep the same indentation style as the existing code
3. For NEW methods/functions, include the surrounding class/module definition line as context
4. Do NOT include "# File:" headers unless replacing the entire file
5. Preserve existing code structure - only show the parts that change plus context

Example of good code output (adding a new method):
\`\`\`ruby
  def existing_method
    # existing code here
  end

  def new_method_i_am_adding
    # new code
  end

  def another_existing_method
\`\`\`

The context lines (existing_method, another_existing_method) help locate where to insert the new code.

`;
    if (editorContext) {
      systemPrompt += `\n${editorContext}`;
    }

    // Auto web search if enabled (search BEFORE DeepSeek, not via tool calls)
    let webSearchContext = '';
    if (this.webSearchEnabled && this.tavilyClient.isConfigured()) {
      const cacheKey = message.toLowerCase().trim();
      const cached = this.searchCache.get(cacheKey);

      if (cached) {
        // Use cached results
        webSearchContext = cached.results;
        logger.webSearchCached(message);
        this._view?.webview.postMessage({ type: 'webSearchCached' });
      } else {
        try {
          // Show searching indicator
          this._view?.webview.postMessage({ type: 'webSearching' });
          logger.webSearchRequest(message, this.webSearchSettings.searchDepth);

          const searchStartTime = Date.now();
          const searchResults = await this.tavilyClient.search(message, {
            searchDepth: this.webSearchSettings.searchDepth
          });
          webSearchContext = this.formatSearchResults(searchResults);
          logger.webSearchResult(searchResults.results.length, Date.now() - searchStartTime);

          // Cache the results
          this.searchCache.set(cacheKey, {
            results: webSearchContext,
            timestamp: Date.now()
          });

          this._view?.webview.postMessage({ type: 'webSearchComplete' });
        } catch (error: any) {
          logger.webSearchError(error.message);
          this._view?.webview.postMessage({
            type: 'warning',
            message: `Web search failed: ${error.message}`
          });
        }
      }
    }

    // Add search results to system prompt with context for LLM
    if (webSearchContext) {
      const today = new Date().toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      });
      systemPrompt += `

--- CURRENT WEB SEARCH RESULTS (${today}) ---
The following are real-time web search results. Use this information to answer questions
about current events, dates, times, news, or anything requiring up-to-date information.
Do NOT say you lack access to current information - these results ARE current.

${webSearchContext}
--- END WEB SEARCH RESULTS ---
`;
    }

    // Start streaming response
    let fullResponse = '';
    let fullReasoning = '';

    // Create abort controller for this request
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    this._view.webview.postMessage({
      type: 'startResponse',
      isReasoner: isReasonerModel
    });

    // Log the API request
    const model = this.deepSeekClient.getModel();
    const hasImages = attachments && attachments.length > 0;
    const requestStartTime = Date.now();

    try {
      // Get current session messages for context (user message already saved above)
      const currentSession = await this.chatHistoryManager.getCurrentSession();
      const messageCount = currentSession ? currentSession.messages.length : 1;
      logger.apiRequest(model, messageCount, hasImages);

      // Build messages array - handle multimodal content if attachments present
      const historyMessages: ApiMessage[] = [];
      if (currentSession) {
        for (const msg of currentSession.messages) {
          historyMessages.push({
            role: msg.role,
            content: msg.content
          });
        }
      }

      // If this message has attachments, show warning (DeepSeek chat models don't support vision yet)
      if (attachments && attachments.length > 0) {
        // DeepSeek's standard models don't support vision
        // Show a warning but still send the text message
        this._view?.webview.postMessage({
          type: 'warning',
          message: 'Note: DeepSeek chat models do not currently support image analysis. Your text message will be sent without the images.'
        });
      }

      // Tool calling loop (only for non-reasoner models)
      let streamingSystemPrompt = systemPrompt;
      if (!isReasonerModel) {
        const { toolMessages, limitReached } = await this.runToolLoop(historyMessages, systemPrompt, signal);
        // Add tool interactions to history for context
        historyMessages.push(...toolMessages);

        // If tools were used, update system prompt to indicate exploration is complete
        // This prevents the model from trying to use tools during streaming
        if (toolMessages.length > 0) {
          const limitWarning = limitReached
            ? `\n\nNOTE: The tool calling limit was reached. Summarize what you were able to accomplish and explain what remains to be done.`
            : '';
          streamingSystemPrompt = systemPrompt + `

IMPORTANT: The tool exploration phase is now complete. You have already gathered the necessary information using tools.
Now provide your final response based on what you learned. Do NOT attempt to use any more tools or output any tool-calling markup - just provide your answer directly in plain text.${limitWarning}`;
        }
      }

      const _response = await this.deepSeekClient.streamChat(
        historyMessages,
        (token) => {
          fullResponse += token;
          this._view?.webview.postMessage({
            type: 'streamToken',
            token
          });
        },
        streamingSystemPrompt,
        // Reasoning callback for deepseek-reasoner
        isReasonerModel ? (reasoningToken) => {
          fullReasoning += reasoningToken;
          this._view?.webview.postMessage({
            type: 'streamReasoning',
            token: reasoningToken
          });
        } : undefined,
        { signal }
      );

      // Strip any DSML markup from the final response (DeepSeek sometimes
      // outputs DSML in streamed content even after tool calls are done)
      const cleanResponse = stripDSML(fullResponse);

      // Finalize response
      this._view.webview.postMessage({
        type: 'endResponse',
        message: {
          role: 'assistant',
          content: cleanResponse,
          reasoning_content: fullReasoning || undefined
        }
      });

      // Save assistant message to history (with clean response)
      const tokenCount = this.deepSeekClient.estimateTokens(cleanResponse + fullReasoning);
      if (this.currentSessionId && (cleanResponse || fullReasoning)) {
        await this.chatHistoryManager.addMessageToCurrentSession({
          role: 'assistant',
          content: cleanResponse,
          reasoning_content: fullReasoning || undefined,
          tokens: tokenCount
        });
      }

      // Log successful response
      logger.apiResponse(tokenCount, Date.now() - requestStartTime);

      // Update status bar
      this.statusBar.updateLastResponse();
    } catch (error: any) {
      // Check if this was an abort (user stopped generation)
      if (error.name === 'CanceledError' || error.name === 'AbortError' || signal.aborted) {
        // Don't show error for user-initiated stops - handled by stopGeneration
        return;
      }
      // Log the error
      logger.error(error.message, error.stack);
      this._view.webview.postMessage({
        type: 'error',
        error: error.message
      });
    } finally {
      this.abortController = null;
    }
  }

  /**
   * Run the tool calling loop - keeps calling the LLM until it stops requesting tools.
   * Returns the messages from tool interactions to add to context.
   */
  private async runToolLoop(
    messages: ApiMessage[],
    systemPrompt: string,
    signal: AbortSignal
  ): Promise<{ toolMessages: ApiMessage[]; limitReached: boolean }> {
    const toolMessages: ApiMessage[] = [];
    // Get max tool calls from config (100 = no limit)
    const config = vscode.workspace.getConfiguration('deepseek');
    const configuredLimit = config.get<number>('maxToolCalls') ?? 25;
    const maxIterations = configuredLimit >= 100 ? Infinity : configuredLimit;
    let iterations = 0;

    // Track ALL tool calls across all iterations for unified display
    const allToolDetails: Array<{ name: string; detail: string; status: string }> = [];
    let toolContainerStarted = false;
    let globalToolIndex = 0;

    while (iterations < maxIterations) {
      iterations++;

      // Check if aborted
      if (signal.aborted) {
        break;
      }

      // Build tools array (web search is now handled before this loop, not as a tool)
      const tools = workspaceTools;

      // Make a non-streaming call with tools
      const response = await this.deepSeekClient.chat(
        [...messages, ...toolMessages],
        systemPrompt,
        { tools }
      );

      // Check for DSML-formatted tool calls in content (DeepSeek Chat uses this format
      // instead of the standard OpenAI function calling format)
      if ((!response.tool_calls || response.tool_calls.length === 0) && response.content) {
        const dsmlCalls = parseDSMLToolCalls(response.content);
        if (dsmlCalls && dsmlCalls.length > 0) {
          // Convert DSML calls to standard ToolCall format
          response.tool_calls = dsmlCalls.map(dc => ({
            id: dc.id,
            type: 'function' as const,
            function: {
              name: dc.name,
              arguments: JSON.stringify(dc.arguments)
            }
          }));
          // Strip DSML from content to avoid displaying raw markup
          response.content = stripDSML(response.content);
        }
      }

      // If no tool calls, we're done with the tool loop
      if (!response.tool_calls || response.tool_calls.length === 0) {
        // Don't add the final content to history - let the streaming response be the complete reply
        // Adding partial content here causes the model to try continuing with tool calls during streaming
        break;
      }

      // Parse tool call details for better display
      const toolDetails = response.tool_calls.map(tc => {
        const name = tc.function.name;
        let args: Record<string, string> = {};
        try {
          args = JSON.parse(tc.function.arguments);
        } catch (e) { /* ignore */ }

        // Create a user-friendly description
        let detail = name;
        if (name === 'read_file' && args.path) {
          detail = `read: ${args.path}`;
        } else if (name === 'search_files' && args.pattern) {
          detail = `search: ${args.pattern}`;
        } else if (name === 'grep_content' && args.query) {
          detail = `grep: "${args.query}"`;
        } else if (name === 'list_directory') {
          detail = `list: ${args.path || '.'}`;
        } else if (name === 'get_file_info' && args.path) {
          detail = `info: ${args.path}`;
        }
        return { name, detail, args };
      });

      // Add to global tracking
      const newTools = toolDetails.map(t => ({ name: t.name, detail: t.detail, status: 'pending' }));
      allToolDetails.push(...newTools);

      // Create or update tool calls container - send ALL tools each time
      this._view?.webview.postMessage({
        type: toolContainerStarted ? 'toolCallsUpdate' : 'toolCallsStart',
        tools: allToolDetails
      });
      toolContainerStarted = true;

      // Add assistant message with tool calls (required for API contract)
      // Use empty content if no real content - the tool_calls field is what matters
      // Avoid placeholder text like "Calling tools:" as it can appear in the output
      toolMessages.push({
        role: 'assistant',
        content: response.content || '',
        tool_calls: response.tool_calls
      });

      // Execute each tool call
      for (let i = 0; i < response.tool_calls.length; i++) {
        const toolCall = response.tool_calls[i];
        const detail = toolDetails[i];
        const currentIndex = globalToolIndex + i;

        logger.toolCall(toolCall.function.name);

        // Update status to running
        allToolDetails[currentIndex].status = 'running';
        this._view?.webview.postMessage({
          type: 'toolCallUpdate',
          index: currentIndex,
          status: 'running',
          detail: detail.detail
        });

        // Execute tool
        const result = await executeToolCall(toolCall);
        const success = !result.startsWith('Error:');
        logger.toolResult(toolCall.function.name, success);

        // Add tool result to messages
        toolMessages.push({
          role: 'tool',
          content: result,
          tool_call_id: toolCall.id
        });

        // Update status to done
        allToolDetails[currentIndex].status = success ? 'done' : 'error';
        this._view?.webview.postMessage({
          type: 'toolCallUpdate',
          index: currentIndex,
          status: success ? 'done' : 'error',
          detail: detail.detail
        });
      }

      // Update global index for next iteration
      globalToolIndex += response.tool_calls.length;
    }

    // Mark tool calls section as complete (only if we had any tools)
    if (toolContainerStarted) {
      this._view?.webview.postMessage({
        type: 'toolCallsEnd'
      });
    }

    const limitReached = iterations >= maxIterations && maxIterations !== Infinity;
    if (limitReached) {
      this._view?.webview.postMessage({
        type: 'warning',
        message: `Tool calling limit (${configuredLimit}) reached. The task may require multiple requests to complete.`
      });
    }

    return { toolMessages, limitReached };
  }

  private async getEditorContext(): Promise<string> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return '';
    }

    const document = editor.document;
    const language = document.languageId;
    const fileName = document.fileName.split('/').pop() || 'unknown';
    const fullPath = document.fileName;
    const selection = editor.selection;

    // Include FULL file content so AI can make smart insertions
    const fullContent = document.getText();
    const lineCount = document.lineCount;

    let context = `Current File: ${fileName}\nFull Path: ${fullPath}\nLanguage: ${language}\nTotal Lines: ${lineCount}\n`;

    // Add selection info if any
    if (!selection.isEmpty) {
      const selectedText = document.getText(selection);
      context += `\nSelected code (lines ${selection.start.line + 1}-${selection.end.line + 1}):\n${selectedText}\n`;
    } else {
      context += `\nCursor at line ${selection.active.line + 1}\n`;
    }

    // Include full file content
    context += `\n--- FULL FILE CONTENT ---\n${fullContent}\n--- END FILE CONTENT ---\n`;

    // Search for related files in the workspace
    const relatedFiles = await this.findRelatedFiles(document);
    if (relatedFiles.length > 0) {
      context += `\n--- RELATED FILES IN WORKSPACE ---\n`;
      for (const file of relatedFiles) {
        context += `${file}\n`;
      }
      context += `--- END RELATED FILES ---\n`;
    }

    return context;
  }

  /**
   * Search the workspace for files related to the current document.
   * Uses ripgrep/grep/find to locate relevant files.
   */
  private async findRelatedFiles(document: vscode.TextDocument): Promise<string[]> {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!workspaceFolder) {
      return [];
    }

    const cwd = workspaceFolder.uri.fsPath;
    const fileName = path.basename(document.fileName, path.extname(document.fileName));
    const ext = path.extname(document.fileName);

    const relatedFiles: string[] = [];

    try {
      // Strategy 1: Find files with similar names
      const findResult = cp.spawnSync('find', [
        '.', '-type', 'f',
        '-name', `*${fileName}*`,
        '-o', '-name', `*${fileName.toLowerCase()}*`,
        '!', '-path', '*/node_modules/*',
        '!', '-path', '*/.git/*',
        '!', '-path', '*/vendor/*'
      ], {
        cwd,
        encoding: 'utf-8',
        timeout: 3000
      });

      if (findResult.stdout) {
        const files = findResult.stdout.split('\n').filter(f => f.trim() && f !== document.fileName);
        relatedFiles.push(...files.slice(0, 5).map(f => `Similar name: ${f}`));
      }

      // Strategy 2: Find files that reference this file (using grep/ripgrep)
      const searchTerm = fileName;
      let grepResult = cp.spawnSync('rg', [
        '-l', '--max-count', '1',
        searchTerm,
        '--type-not', 'binary',
        '--ignore-file', '.gitignore',
        '-g', '!node_modules',
        '-g', '!.git'
      ], {
        cwd,
        encoding: 'utf-8',
        timeout: 3000
      });

      // Fallback to grep if ripgrep not available
      if (grepResult.error || grepResult.status !== 0) {
        grepResult = cp.spawnSync('grep', [
          '-rl', '--include', `*${ext}`,
          searchTerm, '.'
        ], {
          cwd,
          encoding: 'utf-8',
          timeout: 3000
        });
      }

      if (grepResult.stdout) {
        const files = grepResult.stdout.split('\n').filter(f => f.trim() && !f.includes(document.fileName));
        relatedFiles.push(...files.slice(0, 5).map(f => `References this: ${f}`));
      }

      // Strategy 3: Find test files
      const testPatterns = [`*${fileName}*test*${ext}`, `*${fileName}*spec*${ext}`, `test_${fileName}${ext}`];
      for (const pattern of testPatterns) {
        const testResult = cp.spawnSync('find', ['.', '-type', 'f', '-name', pattern, '!', '-path', '*/node_modules/*'], {
          cwd,
          encoding: 'utf-8',
          timeout: 2000
        });

        if (testResult.stdout) {
          const files = testResult.stdout.split('\n').filter(f => f.trim());
          relatedFiles.push(...files.slice(0, 2).map(f => `Test file: ${f}`));
        }
      }

    } catch (error) {
      // Silently fail - this is optional context
    }

    // Remove duplicates and limit
    return [...new Set(relatedFiles)].slice(0, 10);
  }

  /**
   * Search the workspace for content matching a query.
   * Can be called to provide additional context to the AI.
   */
  private async searchWorkspace(query: string, maxResults: number = 10): Promise<string> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return '';
    }

    const cwd = workspaceFolder.uri.fsPath;
    let results = '';

    try {
      // Try ripgrep first (faster)
      let searchResult = cp.spawnSync('rg', [
        '-n', '--max-count', '3',
        '-C', '2', // 2 lines of context
        query,
        '--type-not', 'binary',
        '-g', '!node_modules',
        '-g', '!.git',
        '-g', '!*.min.js',
        '-g', '!*.min.css'
      ], {
        cwd,
        encoding: 'utf-8',
        timeout: 5000
      });

      // Fallback to grep
      if (searchResult.error || !searchResult.stdout) {
        searchResult = cp.spawnSync('grep', [
          '-rn', '--include', '*.{js,ts,py,rb,go,rs,java,c,cpp,h}',
          '-C', '2',
          query, '.'
        ], {
          cwd,
          encoding: 'utf-8',
          timeout: 5000
        });
      }

      if (searchResult.stdout) {
        const lines = searchResult.stdout.split('\n').slice(0, maxResults * 5);
        results = lines.join('\n');
      }

    } catch (error) {
      // Silently fail
    }

    return results;
  }

  /**
   * Get the content of a file in the workspace by path.
   */
  private async getFileContent(relativePath: string): Promise<string | null> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return null;
    }

    const fullPath = path.join(workspaceFolder.uri.fsPath, relativePath);

    try {
      if (fs.existsSync(fullPath)) {
        const content = fs.readFileSync(fullPath, 'utf-8');
        // Limit to first 500 lines to avoid huge context
        const lines = content.split('\n').slice(0, 500);
        return lines.join('\n');
      }
    } catch (error) {
      // File not readable
    }

    return null;
  }

  private async applyCode(code: string, language: string) {
    // Strip "# File:" header if present (AI convention)
    const cleanCode = code.replace(/^#\s*File:.*\n/i, '');

    // Find the target editor - prefer last tracked real file over diff view
    let editor = vscode.window.activeTextEditor;

    // If current editor is a diff view or virtual doc, find the real file
    if (editor && (editor.document.uri.scheme === 'deepseek-diff' || editor.document.uri.scheme === 'git')) {
      // Try to find an editor with a real file
      const realEditor = vscode.window.visibleTextEditors.find(e =>
        e.document.uri.scheme === 'file' && !e.document.uri.path.includes('deepseek-diff')
      );
      if (realEditor) {
        editor = realEditor;
      } else if (this.lastActiveEditorUri) {
        // Open the last known real file
        const doc = await vscode.workspace.openTextDocument(this.lastActiveEditorUri);
        editor = await vscode.window.showTextDocument(doc);
      }
    }

    try {
      if (!editor || editor.document.uri.scheme !== 'file') {
        // No active editor - create a new file with the code
        const doc = await vscode.workspace.openTextDocument({
          content: cleanCode,
          language: this.mapLanguage(language)
        });
        await vscode.window.showTextDocument(doc);
        this.sendCodeAppliedStatus(true);
        return;
      }

      const document = editor.document;
      const currentContent = document.getText();
      const selection = editor.selection;

      // If there's a selection, replace it directly
      if (!selection.isEmpty) {
        await editor.edit((editBuilder) => {
          editBuilder.replace(selection, cleanCode);
        });
        this.sendCodeAppliedStatus(true);
        return;
      }

      // Use DiffEngine to intelligently apply changes
      const result = this.diffEngine.applyChanges(currentContent, cleanCode);

      const fullRange = new vscode.Range(
        document.positionAt(0),
        document.positionAt(currentContent.length)
      );

      await editor.edit((editBuilder) => {
        editBuilder.replace(fullRange, result.content);
      });

      this.sendCodeAppliedStatus(result.success, result.success ? undefined : 'Patch applied with fallback');

      // Close the diff editor and notify webview
      await this.closeDiffEditor();

    } catch (error: any) {
      logger.error('Failed to apply code', error.message);
      this.sendCodeAppliedStatus(false, error.message);
    }
  }

  private async closeDiffEditor() {
    // Close any diff editors with our scheme
    if (this.activeDiffUri) {
      // Find and close tabs with deepseek-diff scheme
      const tabsToClose: vscode.Tab[] = [];

      for (const tabGroup of vscode.window.tabGroups.all) {
        for (const tab of tabGroup.tabs) {
          // Check if this is a diff tab (TabInputTextDiff has original and modified)
          const input = tab.input as any;
          if (input?.original?.scheme === 'deepseek-diff' ||
              input?.modified?.scheme === 'deepseek-diff') {
            tabsToClose.push(tab);
          }
        }
      }

      // Close all found diff tabs
      for (const tab of tabsToClose) {
        await vscode.window.tabGroups.close(tab);
      }

      this.activeDiffUri = null;
      this.notifyDiffClosed();
    }
  }

  private async showDiff(code: string, language: string) {
    let editor = vscode.window.activeTextEditor;

    // If current editor isn't a file (e.g., diff view is active), try to use the last tracked editor
    if (!editor || editor.document.uri.scheme !== 'file') {
      if (this.lastActiveEditorUri) {
        // Try to find the editor with our tracked URI
        const existingDoc = vscode.workspace.textDocuments.find(
          doc => doc.uri.toString() === this.lastActiveEditorUri?.toString()
        );
        if (existingDoc) {
          // Use the existing document
          editor = { document: existingDoc } as vscode.TextEditor;
        } else {
          vscode.window.showWarningMessage('No active editor to compare with');
          return;
        }
      } else {
        vscode.window.showWarningMessage('No active editor to compare with');
        return;
      }
    } else {
      // Track this editor so Apply can find it later
      this.lastActiveEditorUri = editor.document.uri;
    }

    try {
      const document = editor.document;
      const originalContent = document.getText();
      const selection = editor.selection;

      // Strip "# File:" header if present
      const cleanCode = code.replace(/^#\s*File:.*\n/i, '');

      // Create the proposed content by applying the code to the current file
      let proposedContent: string;

      if (selection && !selection.isEmpty) {
        // If there's a selection, replace it
        const before = originalContent.substring(0, document.offsetAt(selection.start));
        const after = originalContent.substring(document.offsetAt(selection.end));
        proposedContent = before + cleanCode + after;
      } else {
        // Use DiffEngine to compute the proposed content
        const result = this.diffEngine.applyChanges(originalContent, cleanCode);
        proposedContent = result.content;
      }

      // Create virtual documents for both original and proposed
      // Include file extension for syntax highlighting
      const timestamp = Date.now();
      const fileExt = document.fileName.split('.').pop() || 'txt';
      const originalUri = vscode.Uri.parse(`deepseek-diff:original-${timestamp}.${fileExt}`);
      const proposedUri = vscode.Uri.parse(`deepseek-diff:proposed-${timestamp}.${fileExt}`);

      // Register content provider
      const provider = new (class implements vscode.TextDocumentContentProvider {
        private contents: Map<string, string> = new Map();

        constructor() {
          this.contents.set(originalUri.toString(), originalContent);
          this.contents.set(proposedUri.toString(), proposedContent);
        }

        provideTextDocumentContent(uri: vscode.Uri): string {
          return this.contents.get(uri.toString()) || '';
        }
      })();

      const disposable = vscode.workspace.registerTextDocumentContentProvider('deepseek-diff', provider);

      // Show diff editor
      const fileName = document.fileName.split('/').pop() || 'file';
      await vscode.commands.executeCommand('vscode.diff',
        originalUri,
        proposedUri,
        `${fileName} ↔ With Changes (Review & close to cancel)`
      );

      // Track that we have an active diff
      this.activeDiffUri = proposedUri;
      logger.diffShown(fileName);

      // Clean up provider after a delay
      setTimeout(() => disposable.dispose(), 300000); // 5 minutes

    } catch (error: any) {
      logger.error('Failed to show diff', error.message);
      vscode.window.showErrorMessage(`Failed to show diff: ${error.message}`);
    }
  }

  private async closeDiff() {
    // Close any diff editor that's currently open
    if (this.activeDiffUri) {
      // Find and close the diff editor tab
      for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
          if (tab.input instanceof vscode.TabInputTextDiff) {
            const diffInput = tab.input as vscode.TabInputTextDiff;
            if (diffInput.modified.scheme === 'deepseek-diff' || diffInput.original.scheme === 'deepseek-diff') {
              await vscode.window.tabGroups.close(tab);
              break;
            }
          }
        }
      }
      this.activeDiffUri = null;
    }
  }

  private mapLanguage(language: string): string {
    const languageMap: Record<string, string> = {
      'js': 'javascript',
      'ts': 'typescript',
      'py': 'python',
      'rb': 'ruby',
      'rs': 'rust',
      'go': 'go',
      'java': 'java',
      'cpp': 'cpp',
      'c': 'c',
      'cs': 'csharp',
      'php': 'php',
      'swift': 'swift',
      'kt': 'kotlin',
      'scala': 'scala',
      'sh': 'shellscript',
      'bash': 'shellscript',
      'zsh': 'shellscript',
      'sql': 'sql',
      'html': 'html',
      'css': 'css',
      'scss': 'scss',
      'json': 'json',
      'yaml': 'yaml',
      'yml': 'yaml',
      'xml': 'xml',
      'md': 'markdown',
      'markdown': 'markdown',
      'text': 'plaintext'
    };
    return languageMap[language.toLowerCase()] || language;
  }

  private sendCodeAppliedStatus(success: boolean, error?: string) {
    logger.codeApplied(success);
    if (this._view) {
      this._view.webview.postMessage({
        type: 'codeApplied',
        success,
        error
      });
    }
  }

  private async loadCurrentSessionHistory() {
    const currentSession = await this.chatHistoryManager.getCurrentSession();
    if (this._view && currentSession && currentSession.messages.length > 0) {
      this._view.webview.postMessage({
        type: 'loadHistory',
        history: currentSession.messages.map(msg => ({
          role: msg.role,
          content: msg.content,
          reasoning_content: msg.reasoning_content
        }))
      });
    }
  }

  public async loadSession(sessionId: string) {
    const session = await this.chatHistoryManager.getSession(sessionId);
    if (session && this._view) {
      this.currentSessionId = session.id;
      await this.chatHistoryManager.switchToSession(sessionId);
      logger.sessionSwitch(sessionId);

      // Switch to the session's model
      if (session.model) {
        const config = vscode.workspace.getConfiguration('deepseek');
        await config.update('model', session.model, vscode.ConfigurationTarget.Global);

        // Send updated settings to webview
        this._view.webview.postMessage({
          type: 'settings',
          model: session.model,
          temperature: config.get<number>('temperature') ?? 0.7
        });
      }

      // Load session messages via loadHistory (clears and loads)
      this._view.webview.postMessage({
        type: 'loadHistory',
        history: session.messages.map(msg => ({
          role: msg.role,
          content: msg.content,
          reasoning_content: msg.reasoning_content
        }))
      });
    }
  }

  private getHtmlForWebview(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'media', 'chat.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'media', 'chat.css')
    );
    const iconUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'media', 'moby.png')
    );

    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>DeepSeek Moby</title>
        <link href="${styleUri}" rel="stylesheet">
      </head>
      <body>
        <div class="chat-container">
          <div class="header">
            <img src="${iconUri}" alt="DeepSeek Moby" class="header-icon">
            <div id="toastContainer" class="toast-container"></div>
            <div class="header-actions">
              <div class="model-selector">
                <button id="modelBtn" class="model-btn" title="Click to change model">
                  <span id="currentModelName">Chat (V3)</span>
                  <span class="model-dropdown-arrow">▼</span>
                </button>
                <div id="modelDropdown" class="model-dropdown" style="display: none;">
                  <div class="model-option" data-model="deepseek-chat">
                    <span class="model-option-name">DeepSeek Chat (V3)</span>
                    <span class="model-option-desc">Fast, general-purpose</span>
                  </div>
                  <div class="model-option" data-model="deepseek-reasoner">
                    <span class="model-option-name">DeepSeek Reasoner (R1)</span>
                    <span class="model-option-desc">Chain-of-thought reasoning</span>
                  </div>
                  <div class="model-dropdown-divider"></div>
                  <div class="temperature-control">
                    <label>Temperature: <span id="tempValue">0.7</span></label>
                    <input type="range" id="tempSlider" min="0" max="2" step="0.1" value="0.7">
                  </div>
                  <div id="toolLimitControl" class="temperature-control" style="display: block;">
                    <label>Tool Limit: <span id="toolLimitValue">25</span></label>
                    <input type="range" id="toolLimitSlider" min="5" max="100" step="5" value="25">
                    <span class="tool-limit-hint">100 = No limit</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div id="chatMessages" class="chat-messages"></div>

          <div class="input-area">
            <div class="input-row">
              <div class="input-buttons-grid">
                <button id="helpBtn" class="grid-btn help-btn" title="Commands">
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 13A6 6 0 1 1 8 2a6 6 0 0 1 0 12zm-.5-3h1v1h-1v-1zm.5-7a2.5 2.5 0 0 0-2.5 2.5h1A1.5 1.5 0 1 1 8 8c-.55 0-1 .45-1 1v1h1v-.8c0-.11.09-.2.2-.2h.3a2.5 2.5 0 0 0 0-5z"/>
                  </svg>
                </button>
                <button id="attachBtn" class="grid-btn attach-btn" title="Attach image">
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M4.5 3a2.5 2.5 0 0 1 5 0v9a1.5 1.5 0 0 1-3 0V5a.5.5 0 0 1 1 0v7a.5.5 0 0 0 1 0V3a1.5 1.5 0 1 0-3 0v9a2.5 2.5 0 0 0 5 0V5a.5.5 0 0 1 1 0v7a3.5 3.5 0 1 1-7 0V3z"/>
                  </svg>
                </button>
                <button id="searchBtn" class="grid-btn search-btn" title="Web search (coming soon)">
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                    <!-- Globe circle -->
                    <circle cx="6" cy="6" r="5.5" fill="none" stroke="currentColor" stroke-width="1"/>
                    <!-- Horizontal line (equator) -->
                    <path d="M0.5 6h11" stroke="currentColor" stroke-width="0.8" fill="none"/>
                    <!-- Vertical ellipse (meridian) -->
                    <ellipse cx="6" cy="6" rx="2.5" ry="5.5" fill="none" stroke="currentColor" stroke-width="0.8"/>
                    <!-- Magnifying glass handle -->
                    <path d="M10 10l4.5 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                  </svg>
                </button>
                <button id="sendBtn" class="grid-btn send-btn" title="Send message">
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M1.724 1.053a.5.5 0 0 1 .545-.108l13 5.5a.5.5 0 0 1 0 .91l-13 5.5a.5.5 0 0 1-.69-.575l1.557-5.28-1.557-5.28a.5.5 0 0 1 .145-.467zM3.882 7.5l-1.06 3.593L12.14 8 2.822 4.907 3.882 8.5H8a.5.5 0 0 1 0 1H3.882z"/>
                  </svg>
                </button>
                <button id="stopBtn" class="grid-btn stop-btn" title="Stop generation" style="display: none;">
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                    <rect x="3" y="3" width="10" height="10" rx="1"/>
                  </svg>
                </button>
              </div>
              <textarea
                id="messageInput"
                placeholder="Seek deep..."
                rows="1"
              ></textarea>
            </div>
            <input type="file" id="fileInput" accept="image/*" style="display: none" multiple>
            <div id="attachments" class="attachments"></div>
          </div>
        </div>

        <script src="${scriptUri}"></script>
      </body>
      </html>
    `;
  }
}