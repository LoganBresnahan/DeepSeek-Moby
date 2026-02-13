import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { DeepSeekClient, Message as ApiMessage, ToolCall } from '../deepseekClient';
import { StatusBar } from '../views/statusBar';
import { ConversationManager } from '../events';
import { DiffEngine } from '../utils/diff';
import { logger } from '../utils/logger';
import { tracer, type TraceCategory } from '../tracing';
import { webviewLogStore } from '../logging/WebviewLogStore';
import { workspaceTools, applyCodeEditTool, executeToolCall } from '../tools/workspaceTools';
import { parseDSMLToolCalls, stripDSML } from '../utils/dsmlParser';
import { TavilyClient } from '../clients/tavilyClient';
import { WebSearchManager } from './webSearchManager';
import { FileContextManager } from './fileContextManager';
import { DiffManager } from './diffManager';
import {
  parseShellCommands,
  containsShellCommands,
  containsCodeEdits,
  executeShellCommands,
  formatShellResultsForContext,
  getReasonerShellPrompt,
  stripShellTags,
  ShellResult
} from '../tools/reasonerShellExecutor';
import { ContentTransformBuffer, BufferedSegment, ShellCommand } from '../utils/ContentTransformBuffer';

export class ChatProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'deepseek-chat-view';
  private _view?: vscode.WebviewView;
  private deepSeekClient: DeepSeekClient;
  private statusBar: StatusBar;
  private conversationManager: ConversationManager;
  private currentSessionId: string | null = null;
  private abortController: AbortController | null = null;
  private disposables: vscode.Disposable[] = [];
  private tavilyClient: TavilyClient;
  private webSearchManager: WebSearchManager;
  private fileContextManager: FileContextManager;
  private diffManager: DiffManager;

  // Content transform buffer for debounced streaming
  private contentBuffer: ContentTransformBuffer | null = null;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    deepSeekClient: DeepSeekClient,
    statusBar: StatusBar,
    conversationManager: ConversationManager,
    tavilyClient: TavilyClient
  ) {
    this.deepSeekClient = deepSeekClient;
    this.statusBar = statusBar;
    this.conversationManager = conversationManager;
    this.tavilyClient = tavilyClient;

    // Create web search manager and wire events → webview
    this.webSearchManager = new WebSearchManager(this.tavilyClient);
    this.webSearchManager.onSearching((progress) => {
      this._view?.webview.postMessage({ type: 'webSearching', current: progress.current, total: progress.total });
    });
    this.webSearchManager.onSearchComplete(() => {
      this._view?.webview.postMessage({ type: 'webSearchComplete' });
    });
    this.webSearchManager.onSearchCached(() => {
      this._view?.webview.postMessage({ type: 'webSearchCached' });
    });
    this.webSearchManager.onSearchError(e => {
      this._view?.webview.postMessage({ type: 'warning', message: `Web search failed: ${e.message}` });
    });
    this.webSearchManager.onToggled(d => {
      this._view?.webview.postMessage({ type: 'webSearchToggled', enabled: d.enabled });
    });

    // Create file context manager and wire events → webview
    this.fileContextManager = new FileContextManager();
    this.fileContextManager.onOpenFiles(data => {
      this._view?.webview.postMessage({ type: 'openFiles', files: data.files });
    });
    this.fileContextManager.onSearchResults(data => {
      this._view?.webview.postMessage({ type: 'searchResults', results: data.results });
    });
    this.fileContextManager.onFileContent(data => {
      this._view?.webview.postMessage({ type: 'fileContent', filePath: data.filePath, content: data.content });
    });

    // Create diff manager and wire events → webview
    const config = vscode.workspace.getConfiguration('deepseek');
    const editMode = (config.get<string>('editMode') || 'manual') as 'manual' | 'ask' | 'auto';
    this.diffManager = new DiffManager(new DiffEngine(), this.fileContextManager, editMode);
    this.diffManager.setFlushCallback(() => {
      if (this.contentBuffer) {
        this.contentBuffer.flush();
      }
    });
    this.diffManager.onDiffListChanged(data => {
      this._view?.webview.postMessage({ type: 'diffListChanged', diffs: data.diffs, editMode: data.editMode });
    });
    this.diffManager.onAutoAppliedFilesChanged(data => {
      this._view?.webview.postMessage({ type: 'diffListChanged', diffs: data.diffs, editMode: data.editMode });
    });
    this.diffManager.onCodeApplied(data => {
      this._view?.webview.postMessage({ type: 'codeApplied', success: data.success, error: data.error, filePath: data.filePath });
    });
    this.diffManager.onActiveDiffChanged(data => {
      this._view?.webview.postMessage({ type: 'activeDiffChanged', filePath: data.filePath });
    });
    this.diffManager.onDiffClosed(() => {
      this._view?.webview.postMessage({ type: 'diffClosed' });
    });
    this.diffManager.onWarning(data => {
      this._view?.webview.postMessage({ type: 'warning', message: data.message });
    });
    this.diffManager.onEditConfirm(data => {
      this._view?.webview.postMessage({ type: 'showEditConfirm', filePath: data.filePath, code: data.code, language: data.language });
    });
    this.diffManager.onEditRejected(data => {
      this._view?.webview.postMessage({ type: 'editRejected', filePath: data.filePath });
    });

    // Load current session
    this.loadCurrentSession();

    // Track when new files are opened (for live modal updates)
    this.disposables.push(
      vscode.workspace.onDidOpenTextDocument((document) => {
        if (this.fileContextManager.isModalOpen) {
          const validSchemes = ['file', 'vscode-remote'];
          if (validSchemes.includes(document.uri.scheme) && !document.isClosed) {
            const relativePath = vscode.workspace.asRelativePath(document.uri);

            if (!relativePath.startsWith('extension-output-') &&
                !relativePath.includes('[') &&
                !document.isUntitled) {
              logger.info(`[ChatProvider] File opened while modal open: ${relativePath} - refreshing list`);
              this.fileContextManager.sendOpenFiles();
            }
          }
        }
      })
    );
  }

  public dispose() {
    this.webSearchManager.dispose();
    this.fileContextManager.dispose();
    this.diffManager.dispose();
    this.disposables.forEach(d => d.dispose());
  }

  private async loadCurrentSession() {
    const currentSession = await this.conversationManager.getCurrentSession();
    if (currentSession) {
      this.currentSessionId = currentSession.id;
    }
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    // Trace webview lifecycle - critical for debugging timing issues
    const resolveInfo = {
      previousViewExists: this._view !== undefined,
      hasState: context.state !== undefined
    };
    tracer.trace('webview.resolve' as TraceCategory, 'chatPanel', { data: resolveInfo });
    logger.info('[ChatProvider] Webview resolving', JSON.stringify(resolveInfo));

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
          await this.diffManager.applyCode(data.code, data.language);
          break;
        case 'showDiff':
          await this.diffManager.showDiff(data.code, data.language);
          break;
        case 'closeDiff':
          await this.diffManager.closeDiff();
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
        case 'selectModel':
          // Handle model selection from dropdown
          await this.updateSettings({ model: data.model });
          break;
        case 'setTemperature':
          // Handle temperature slider
          await this.updateSettings({ temperature: data.temperature });
          break;
        case 'setToolLimit':
          // Handle tool limit slider
          await this.updateSettings({ maxToolCalls: data.toolLimit });
          break;
        case 'setMaxTokens':
          // Handle token limit slider
          await this.updateSettings({ maxTokens: data.maxTokens });
          break;
        case 'setLogLevel':
          // Handle log level change
          await this.updateLogSettings({ logLevel: data.logLevel });
          break;
        case 'setLogColors':
          // Handle log colors toggle
          await this.updateLogSettings({ logColors: data.enabled });
          break;
        case 'setWebviewLogLevel':
          // Handle webview log level change - save to config, then send settings back for live update
          await this.updateWebviewLogSettings({ webviewLogLevel: data.logLevel });
          break;
        case 'setTracingEnabled':
          // Handle tracing toggle
          await this.updateTracingSettings({ enabled: data.enabled });
          break;
        case 'openLogs':
          // Show the DeepSeek output channel
          logger.show();
          break;
        case 'setAllowAllCommands':
          // Handle "Walk on the Wild Side" toggle
          await this.updateReasonerSettings({ allowAllCommands: data.enabled });
          break;
        case 'setSystemPrompt':
          // Handle system prompt change
          await this.updateSystemPrompt(data.systemPrompt);
          break;
        case 'getDefaultSystemPrompt':
          this.sendDefaultSystemPrompt();
          break;
        case 'getSettings':
          this.sendCurrentSettings();
          break;
        case 'executeCommand':
          vscode.commands.executeCommand(data.command);
          break;
        case 'toggleWebSearch':
          this.webSearchManager.toggle(data.enabled);
          break;
        case 'updateWebSearchSettings':
          this.webSearchManager.updateSettings(data.settings);
          break;
        case 'getWebSearchSettings':
          this.sendWebSearchSettings();
          break;
        case 'clearSearchCache':
          this.webSearchManager.clearCache();
          break;
        case 'setEditMode':
          this.diffManager.setEditMode(data.mode);
          break;
        case 'showLogs':
          // Show the DeepSeek output channel (logs)
          logger.show();
          break;
        case 'rejectEdit':
          await this.diffManager.rejectEdit(data.filePath);
          break;
        case 'acceptSpecificDiff':
          await this.diffManager.acceptSpecificDiff(data.diffId);
          break;
        case 'rejectSpecificDiff':
          await this.diffManager.rejectSpecificDiff(data.diffId);
          break;
        case 'focusDiff':
          await this.diffManager.focusSpecificDiff(data.diffId);
          break;
        case 'openFile':
          await this.diffManager.openFile(data.filePath);
          break;
        case 'focusFile':
          await this.diffManager.focusFileOrDiff(data.diffId, data.filePath);
          break;
        case 'getOpenFiles':
          this.fileContextManager.sendOpenFiles();
          break;
        case 'fileModalOpened':
          this.fileContextManager.setModalOpen(true);
          break;
        case 'fileModalClosed':
          this.fileContextManager.setModalOpen(false);
          break;
        case 'searchFiles':
          await this.fileContextManager.handleFileSearch(data.query);
          break;
        case 'getFileContent':
          await this.fileContextManager.sendFileContent(data.filePath);
          break;
        case 'setSelectedFiles':
          this.fileContextManager.setSelectedFiles(data.files);
          break;
        case 'setSearchDepth':
          this.webSearchManager.updateSettings({ searchDepth: data.searchDepth });
          break;
        case 'setCreditsPerPrompt':
          this.webSearchManager.updateSettings({ creditsPerPrompt: data.value });
          break;
        case 'setMaxResultsPerSearch':
          this.webSearchManager.updateSettings({ maxResultsPerSearch: data.value });
          break;
        case 'setCacheDuration':
          this.webSearchManager.updateSettings({ cacheDuration: data.cacheDuration });
          break;
        case 'setAutoSaveHistory':
          await this.updateSettings({ autoSaveHistory: data.enabled });
          break;
        case 'setMaxSessions':
          await this.updateSettings({ maxSessions: data.maxSessions });
          break;
        case 'clearAllHistory':
          await this.clearAllHistory();
          break;
        case 'resetToDefaults':
          await this.resetToDefaults();
          break;
        // History modal messages
        case 'getHistorySessions':
          await this.sendHistorySessions();
          break;
        case 'switchToSession':
          await this.loadSession(data.sessionId);
          break;
        case 'renameSession':
          await this.renameSession(data.sessionId, data.title);
          break;
        case 'exportSession':
          await this.exportSessionToFile(data.sessionId, data.format);
          break;
        case 'deleteSession':
          await this.deleteSession(data.sessionId);
          break;
        case 'exportAllHistory':
          await this.exportAllHistoryToFile(data.format);
          break;
        // Webview trace events - merge into extension trace collector
        case 'traceEvents':
          // Log time alignment diagnostic if webview sent sync time
          if (data.webviewSyncTime) {
            const extensionNow = new Date().toISOString();
            const webviewTime = data.webviewSyncTime as string;
            const diffMs = new Date(extensionNow).getTime() - new Date(webviewTime).getTime();
            if (Math.abs(diffMs) > 1000) {
              logger.warn(`[Trace] Time drift detected: extension=${extensionNow} webview=${webviewTime} diff=${diffMs}ms`);
            }
          }
          this.handleWebviewTraceEvents(data.events);
          // Send acknowledgment so webview knows it's safe to clear buffer
          this._view?.webview.postMessage({ type: 'traceSyncAck', count: data.events?.length || 0 });
          break;
        // Webview log entries - store in extension-side buffer
        case 'webviewLogs':
          if (data.entries?.length) {
            webviewLogStore.import(data.entries);
          }
          break;
        // Webview ready - send calibration data and request immediate trace sync
        case 'webviewReady':
          this.sendTraceCalibration();
          break;
      }
    });

    // Handle visibility changes - request trace sync when webview becomes visible/hidden
    webviewView.onDidChangeVisibility(() => {
      tracer.trace('webview.visible' as TraceCategory, webviewView.visible ? 'shown' : 'hidden');
      if (webviewView.visible) {
        // Webview became visible - send calibration in case it was recreated
        this.sendTraceCalibration();
      }
      // Always request trace sync on visibility change (capture events before potential destruction)
      this._view?.webview.postMessage({ type: 'requestTraceSync' });
    });

    // Load conversation history for current session
    this.loadCurrentSessionHistory();
  }

  /**
   * Send trace calibration data to webview for timeline alignment.
   * Includes the extension's base timestamp so relativeTime can be synchronized.
   */
  private sendTraceCalibration(): void {
    if (!this._view) return;

    // Get the current correlation ID from the logger (if an API request is in progress)
    const correlationId = logger.getCurrentCorrelationId();

    // Send the extension's start time and current correlation ID (if any)
    this._view.webview.postMessage({
      type: 'traceCalibration',
      extensionStartTime: new Date().toISOString(),
      correlationId: correlationId || undefined
    });
  }

  public reveal() {
    if (this._view) {
      this._view.show?.(true);
    }
  }

  /**
   * Open the history modal in the chat view.
   * Reveals the chat panel and triggers the history modal to open.
   */
  public async openHistoryModal() {
    this.reveal();
    // Small delay to ensure webview is ready
    await new Promise(resolve => setTimeout(resolve, 100));
    if (this._view) {
      // Send history sessions first, then trigger modal open
      await this.sendHistorySessions();
      this._view.webview.postMessage({ type: 'openHistoryModal' });
    }
  }

  /**
   * Show stats in the chat view.
   * Reveals the chat panel and displays usage statistics.
   */
  public async showStats() {
    this.reveal();
    // Small delay to ensure webview is ready
    await new Promise(resolve => setTimeout(resolve, 100));
    if (this._view) {
      // Get stats
      const stats = await this.conversationManager.getSessionStats();

      // Fetch balance from DeepSeek API
      let balance = null;
      try {
        balance = await this.deepSeekClient.getBalance();
      } catch (e) {
        // Silently fail if balance fetch fails
      }

      // Get Tavily search stats (local tracking)
      const tavilyStats = this.tavilyClient.getUsageStats();

      // Get real Tavily API usage (from /usage endpoint)
      let tavilyApiUsage = null;
      if (this.tavilyClient.isConfigured()) {
        try {
          tavilyApiUsage = await this.tavilyClient.getApiUsage();
        } catch (e) {
          // Silently fail if API usage fetch fails
        }
      }

      this._view.webview.postMessage({
        type: 'statsLoaded',
        stats,
        balance,
        tavilyStats,
        tavilyApiUsage
      });
    }
  }

  public async clearConversation() {
    // Clear current conversation but keep session
    if (this._view) {
      this._view.webview.postMessage({ type: 'clearChat' });
    }

    // Clear search cache on new session
    this.webSearchManager.clearCache();

    // Clear diff state for new conversation
    this.diffManager.clearSession();

    // Create a new session for fresh conversation
    const editor = vscode.window.activeTextEditor;
    const language = editor?.document.languageId;
    const session = await this.conversationManager.startNewSession(
      undefined,
      this.deepSeekClient.getModel(),
      language
    );
    this.currentSessionId = session.id;
    logger.sessionStart(session.id, session.title);

    // Notify webview of new session (for SessionActor)
    if (this._view) {
      this._view.webview.postMessage({
        type: 'sessionCreated',
        sessionId: session.id,
        model: this.deepSeekClient.getModel()
      });
    }
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

  private async updateSettings(settings: {
    model?: string;
    temperature?: number;
    maxToolCalls?: number;
    maxTokens?: number;
    autoSaveHistory?: boolean;
    maxSessions?: number;
  }) {
    const config = vscode.workspace.getConfiguration('deepseek');

    if (settings.model !== undefined) {
      // Set model immediately on client (VS Code config has propagation delay)
      this.deepSeekClient.setModel(settings.model);
      await config.update('model', settings.model, vscode.ConfigurationTarget.Global);
      logger.modelChanged(settings.model);
      // Notify webview to update UI
      if (this._view) {
        this._view.webview.postMessage({ type: 'modelChanged', model: settings.model });
      }
      // Sync full settings back to webview so token limits, temperature etc. stay in sync
      this.sendCurrentSettings();
    }

    if (settings.temperature !== undefined) {
      await config.update('temperature', settings.temperature, vscode.ConfigurationTarget.Global);
      logger.settingsChanged('temperature', settings.temperature);
    }

    if (settings.maxToolCalls !== undefined) {
      await config.update('maxToolCalls', settings.maxToolCalls, vscode.ConfigurationTarget.Global);
      logger.settingsChanged('maxToolCalls', settings.maxToolCalls);
    }

    if (settings.maxTokens !== undefined) {
      await config.update('maxTokens', settings.maxTokens, vscode.ConfigurationTarget.Global);
      logger.settingsChanged('maxTokens', settings.maxTokens);
    }

    if (settings.autoSaveHistory !== undefined) {
      await config.update('autoSaveHistory', settings.autoSaveHistory, vscode.ConfigurationTarget.Global);
      logger.settingsChanged('autoSaveHistory', settings.autoSaveHistory);
    }

    if (settings.maxSessions !== undefined) {
      await config.update('maxSessions', settings.maxSessions, vscode.ConfigurationTarget.Global);
      logger.settingsChanged('maxSessions', settings.maxSessions);
    }
  }

  private async updateLogSettings(settings: { logLevel?: string; logColors?: boolean }) {
    const config = vscode.workspace.getConfiguration('deepseek');

    if (settings.logLevel !== undefined) {
      await config.update('logLevel', settings.logLevel, vscode.ConfigurationTarget.Global);
      logger.settingsChanged('logLevel', settings.logLevel);
    }

    if (settings.logColors !== undefined) {
      await config.update('logColors', settings.logColors, vscode.ConfigurationTarget.Global);
      logger.settingsChanged('logColors', settings.logColors);
    }
  }

  private async updateWebviewLogSettings(settings: { webviewLogLevel?: string }) {
    const config = vscode.workspace.getConfiguration('deepseek');

    if (settings.webviewLogLevel !== undefined) {
      await config.update('webviewLogLevel', settings.webviewLogLevel, vscode.ConfigurationTarget.Global);
      logger.settingsChanged('webviewLogLevel', settings.webviewLogLevel);
      // Send settings back to webview so it applies the new log level immediately
      this.sendCurrentSettings();
    }
  }

  private async updateTracingSettings(settings: { enabled?: boolean }) {
    const config = vscode.workspace.getConfiguration('deepseek');

    if (settings.enabled !== undefined) {
      await config.update('tracing.enabled', settings.enabled, vscode.ConfigurationTarget.Global);
      logger.settingsChanged('tracing.enabled', settings.enabled);
      // Also update the tracer directly
      tracer.enabled = settings.enabled;
    }
  }

  private async updateReasonerSettings(settings: { allowAllCommands?: boolean }) {
    const config = vscode.workspace.getConfiguration('deepseek');

    if (settings.allowAllCommands !== undefined) {
      await config.update('allowAllShellCommands', settings.allowAllCommands, vscode.ConfigurationTarget.Global);
      logger.settingsChanged('allowAllShellCommands', settings.allowAllCommands ? 'enabled (Wild Side)' : 'disabled');
    }
  }

  private async updateSystemPrompt(prompt: string) {
    const config = vscode.workspace.getConfiguration('deepseek');
    await config.update('systemPrompt', prompt, vscode.ConfigurationTarget.Global);
    logger.settingsChanged('systemPrompt', prompt ? `${prompt.substring(0, 50)}...` : '(default)');
  }

  private sendDefaultSystemPrompt() {
    const config = vscode.workspace.getConfiguration('deepseek');
    const model = config.get<string>('model') || 'deepseek-chat';
    const isReasoner = model.includes('reasoner');

    // Get the appropriate default prompt based on model type
    const prompt = isReasoner
      ? this.getReasonerDefaultPrompt()
      : this.getChatDefaultPrompt();

    this._view?.webview.postMessage({
      type: 'defaultSystemPrompt',
      model: isReasoner ? 'DeepSeek Reasoner (R1)' : 'DeepSeek Chat',
      prompt
    });
  }

  private getChatDefaultPrompt(): string {
    return `You are a highly capable AI programming assistant integrated into VS Code. Your role is to help developers write, understand, and improve code.

Key capabilities:
- Analyze code and explain its functionality
- Help debug issues and suggest fixes
- Write new code following best practices
- Refactor and optimize existing code
- Answer programming questions

When providing code changes, use the SEARCH/REPLACE format for precise edits.

Always be concise, accurate, and helpful.`;
  }

  private getReasonerDefaultPrompt(): string {
    return `You are a highly capable AI programming assistant with shell access for exploring codebases.

You can run shell commands using <shell> tags to explore and understand code:
<shell>cat src/file.ts</shell>
<shell>grep -rn "function" src/</shell>

For code changes, use the SEARCH/REPLACE format:
\`\`\`typescript
# File: path/to/file.ts
<<<<<<< SEARCH
exact code to find
======= AND
replacement code
>>>>>>> REPLACE
\`\`\`

Always:
1. Explore the codebase first using shell commands
2. Understand the existing code structure
3. Make precise, targeted changes
4. Complete tasks in a single response`;
  }

  private sendCurrentSettings() {
    const config = vscode.workspace.getConfiguration('deepseek');
    const model = config.get<string>('model') || 'deepseek-chat';
    const temperature = config.get<number>('temperature') ?? 0.7;
    const maxToolCalls = config.get<number>('maxToolCalls') ?? 25;
    const maxTokens = config.get<number>('maxTokens') ?? 8192;
    const editMode = config.get<string>('editMode') || 'manual';
    const logLevel = config.get<string>('logLevel') || 'WARN';
    const webviewLogLevel = config.get<string>('webviewLogLevel') || 'WARN';
    const tracingEnabled = config.get<boolean>('tracing.enabled') ?? true;
    const logColors = config.get<boolean>('logColors') ?? true;
    const systemPrompt = config.get<string>('systemPrompt') || '';
    const autoSaveHistory = config.get<boolean>('autoSaveHistory') ?? true;
    const maxSessions = config.get<number>('maxSessions') ?? 50;
    const allowAllCommands = config.get<boolean>('allowAllShellCommands') ?? false;

    // Sync edit mode with config
    this.diffManager.setEditMode(editMode as 'manual' | 'ask' | 'auto');

    // Sync tracer enabled state
    tracer.enabled = tracingEnabled;

    if (this._view) {
      this._view.webview.postMessage({
        type: 'settings',
        model,
        temperature,
        maxToolCalls,
        maxTokens,
        logLevel,
        webviewLogLevel,
        tracingEnabled,
        logColors,
        systemPrompt,
        autoSaveHistory,
        maxSessions,
        allowAllCommands,
        // Web search settings
        webSearch: {
          searchDepth: this.webSearchManager.getSettings().settings.searchDepth,
          creditsPerPrompt: this.webSearchManager.getSettings().settings.creditsPerPrompt,
          maxResultsPerSearch: this.webSearchManager.getSettings().settings.maxResultsPerSearch,
          cacheDuration: this.webSearchManager.getSettings().settings.cacheDuration
        }
      });
      // Send edit mode separately
      this._view.webview.postMessage({
        type: 'editModeSettings',
        mode: editMode
      });
    }
  }


  private sendWebSearchSettings() {
    const { enabled, settings, configured } = this.webSearchManager.getSettings();
    this._view?.webview.postMessage({
      type: 'webSearchSettings',
      enabled,
      settings,
      configured
    });
  }


  private async clearAllHistory() {
    try {
      // Clear history using the manager
      await this.conversationManager.clearAllHistory();

      // Reset current session
      this.currentSessionId = null;

      logger.info('[ChatProvider] All chat history cleared');

      // Notify webview
      this._view?.webview.postMessage({ type: 'historyCleared' });
      this._view?.webview.postMessage({ type: 'clearChat' });

      // Refresh history modal sessions
      await this.sendHistorySessions();
    } catch (error) {
      logger.error(`[ChatProvider] Failed to clear history: ${error}`);
    }
  }

  private async sendHistorySessions() {
    try {
      const sessions = await this.conversationManager.getAllSessions();
      this._view?.webview.postMessage({
        type: 'historySessions',
        sessions: sessions
      });

      // Also send current session ID
      const currentSession = await this.conversationManager.getCurrentSession();
      if (currentSession) {
        this._view?.webview.postMessage({
          type: 'currentSessionId',
          sessionId: currentSession.id
        });
      }
    } catch (error) {
      logger.error(`[ChatProvider] Failed to send history sessions: ${error}`);
    }
  }

  private async renameSession(sessionId: string, title: string) {
    try {
      await this.conversationManager.renameSession(sessionId, title);
      logger.info(`[ChatProvider] Renamed session ${sessionId} to "${title}"`);

      // Refresh sessions
      await this.sendHistorySessions();
    } catch (error) {
      logger.error(`[ChatProvider] Failed to rename session: ${error}`);
    }
  }

  private async exportSessionToFile(sessionId: string, format: 'json' | 'markdown' | 'txt') {
    try {
      const content = await this.conversationManager.exportSession(sessionId, format);
      if (!content) {
        vscode.window.showErrorMessage('Session not found');
        return;
      }

      const session = await this.conversationManager.getSession(sessionId);
      const title = session?.title || 'chat';
      const ext = format === 'markdown' ? 'md' : format;
      const defaultName = `${title.replace(/[^a-z0-9]/gi, '_')}.${ext}`;

      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(defaultName),
        filters: {
          [format.toUpperCase()]: [ext]
        }
      });

      if (uri) {
        await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
        vscode.window.showInformationMessage(`Exported to ${uri.fsPath}`);
        logger.info(`[ChatProvider] Exported session ${sessionId} to ${uri.fsPath}`);
      }
    } catch (error) {
      logger.error(`[ChatProvider] Failed to export session: ${error}`);
      vscode.window.showErrorMessage('Failed to export session');
    }
  }

  private async deleteSession(sessionId: string) {
    try {
      await this.conversationManager.deleteSession(sessionId);
      logger.info(`[ChatProvider] Deleted session ${sessionId}`);

      // If we deleted the current session, clear it
      if (this.currentSessionId === sessionId) {
        this.currentSessionId = null;
        this._view?.webview.postMessage({ type: 'clearChat' });
      }

      // Refresh sessions
      await this.sendHistorySessions();
    } catch (error) {
      logger.error(`[ChatProvider] Failed to delete session: ${error}`);
    }
  }

  private async exportAllHistoryToFile(format: 'json' | 'markdown' | 'txt') {
    try {
      const content = await this.conversationManager.exportAllSessions(format);
      if (!content) {
        vscode.window.showWarningMessage('No chat history to export');
        return;
      }

      const ext = format === 'markdown' ? 'md' : format;
      const defaultName = `deepseek-history-${new Date().toISOString().split('T')[0]}.${ext}`;

      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(defaultName),
        filters: {
          [format.toUpperCase()]: [ext]
        }
      });

      if (uri) {
        await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
        vscode.window.showInformationMessage(`Exported all history to ${uri.fsPath}`);
        logger.info(`[ChatProvider] Exported all history to ${uri.fsPath}`);
      }
    } catch (error) {
      logger.error(`[ChatProvider] Failed to export history: ${error}`);
      vscode.window.showErrorMessage('Failed to export history');
    }
  }

  /**
   * Handle trace events received from the webview.
   * Merges webview traces into the extension trace collector for unified timeline.
   */
  private handleWebviewTraceEvents(events: unknown[]): void {
    if (!Array.isArray(events)) return;

    for (const event of events) {
      // Validate event structure
      if (!event || typeof event !== 'object') continue;

      const e = event as Record<string, unknown>;
      if (!e.category || !e.operation || !e.timestamp) continue;

      // Import webview trace into extension tracer
      // Use importEvent() to preserve the original webview timestamp
      // This ensures chronological ordering in the unified timeline
      tracer.importEvent(e.category as TraceCategory, e.operation as string, {
        originalId: e.id as string,
        timestamp: e.timestamp as string, // Preserve original timestamp!
        originalRelativeTime: e.relativeTime as number | undefined,
        correlationId: e.correlationId as string | undefined,
        executionMode: (e.executionMode as 'sync' | 'async' | 'callback') || 'sync',
        level: (e.level as 'debug' | 'info' | 'warn' | 'error') || 'info',
        status: (e.status as 'started' | 'completed' | 'failed') || 'completed',
        data: e.data as Record<string, unknown> || {}
      });
    }
  }

  private async resetToDefaults() {
    try {
      const config = vscode.workspace.getConfiguration('deepseek');

      // Reset all settings to defaults
      await config.update('logLevel', undefined, vscode.ConfigurationTarget.Global);
      await config.update('webviewLogLevel', undefined, vscode.ConfigurationTarget.Global);
      await config.update('tracing.enabled', undefined, vscode.ConfigurationTarget.Global);
      await config.update('logColors', undefined, vscode.ConfigurationTarget.Global);
      await config.update('systemPrompt', undefined, vscode.ConfigurationTarget.Global);
      await config.update('maxTokens', undefined, vscode.ConfigurationTarget.Global);
      await config.update('maxToolCalls', undefined, vscode.ConfigurationTarget.Global);
      await config.update('editMode', undefined, vscode.ConfigurationTarget.Global);
      await config.update('autoSaveHistory', undefined, vscode.ConfigurationTarget.Global);
      await config.update('maxSessions', undefined, vscode.ConfigurationTarget.Global);

      // Reset tracer to enabled
      tracer.enabled = true;

      // Reset web search settings
      this.webSearchManager.resetToDefaults();

      // Reset logger
      logger.minLevel = 'INFO';

      logger.info('[ChatProvider] Settings reset to defaults');

      // Send fresh settings to webview
      this.sendCurrentSettings();

      // Notify webview
      this._view?.webview.postMessage({ type: 'settingsReset' });
    } catch (error) {
      logger.error(`[ChatProvider] Failed to reset settings: ${error}`);
    }
  }

  public getTavilyClient(): TavilyClient {
    return this.tavilyClient;
  }

  private async handleUserMessage(message: string, attachments?: Array<{content: string, name: string, size: number}>) {
    if (!this._view) {
      return;
    }

    // Clear processed code blocks and pending diffs for new conversation turn
    this.diffManager.clearProcessedBlocks();
    this.diffManager.clearPendingDiffs();
    // Clear read files tracking and extract user intent
    this.fileContextManager.clearTurnTracking();
    this.fileContextManager.extractFileIntent(message);

    // Get or create current session
    if (!this.currentSessionId) {
      const editor = vscode.window.activeTextEditor;
      const language = editor?.document.languageId;
      const session = await this.conversationManager.startNewSession(
        message,
        this.deepSeekClient.getModel(),
        language
      );
      this.currentSessionId = session.id;

      // Notify webview of new session (for SessionActor)
      if (this._view) {
        this._view.webview.postMessage({
          type: 'sessionCreated',
          sessionId: session.id,
          model: this.deepSeekClient.getModel()
        });
      }
    }

    // Save user message to history (UI already shows it from frontend)
    if (this.currentSessionId) {
      await this.conversationManager.addMessageToCurrentSession({
        role: 'user',
        content: message
      });
    }

    // Get active editor context
    const editorContext = await this.getEditorContext();
    const isReasonerModel = this.deepSeekClient.isReasonerModel();

    // Get custom system prompt from settings (if set)
    const config = vscode.workspace.getConfiguration('deepseek');
    const customSystemPrompt = config.get<string>('systemPrompt') || '';

    let systemPrompt = `You are DeepSeek Moby, an expert programming assistant integrated into VS Code.
`;

    // Prepend custom system prompt if set
    if (customSystemPrompt.trim()) {
      systemPrompt = `${customSystemPrompt.trim()}\n\n---\n\n${systemPrompt}`;
    }

    // Add exploration capabilities based on model type
    if (isReasonerModel) {
      // Reasoner uses shell commands instead of native tool calling
      systemPrompt += getReasonerShellPrompt();
    } else {
      // Chat model uses native tool calling
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

    // Add edit mode context to system prompt
    const editModeDescriptions = {
      manual: 'Code blocks will be displayed for reference. The user will manually copy and apply changes.',
      ask: 'Code blocks will trigger a diff view where the user can review and accept/reject changes.',
      auto: 'Code blocks will be automatically applied to files without user confirmation.'
    };

    systemPrompt += `
IMPORTANT - Code Edit Format Requirements

**Current Edit Mode: ${this.diffManager.currentEditMode.toUpperCase()}**
${editModeDescriptions[this.diffManager.currentEditMode]}

**CRITICAL FORMAT: Every code edit MUST use this exact structure:**

\`\`\`<language>
# File: path/to/file.ext
<<<<<<< SEARCH
exact code to find (copy from file verbatim)
======= AND
replacement code
>>>>>>> REPLACE
\`\`\`

**EXAMPLE - Editing a TypeScript function:**
\`\`\`typescript
# File: src/utils/helper.ts
<<<<<<< SEARCH
export function calculate(x: number): number {
  return x + 1;
}
======= AND
export function calculate(x: number): number {
  return x * 2;  // Changed from addition to multiplication
}
>>>>>>> REPLACE
\`\`\`

**REQUIREMENTS (MANDATORY - edits will fail without these):**
1. ✓ Code block must start with triple backticks and optional language
2. ✓ First line INSIDE the code block must be "# File: <path>"
3. ✓ SEARCH section contains EXACT code from the file (including whitespace)
4. ✓ All markers (<<<<<<< SEARCH, ======= AND, >>>>>>> REPLACE) must be INSIDE the code block
5. ✓ ONE code block per file edit - do NOT split into separate "before" and "after" blocks

**For ADDING new code** (inserting new functions/methods):
\`\`\`typescript
# File: src/services/api.ts
<<<<<<< SEARCH
  async fetchUser(id: string): Promise<User> {
    // existing method
  }
======= AND
  async fetchUser(id: string): Promise<User> {
    // existing method
  }

  async createUser(data: UserData): Promise<User> {
    // new method I'm adding
    return this.post('/users', data);
  }
>>>>>>> REPLACE
\`\`\`

**For CREATING new files** (empty SEARCH section):
\`\`\`typescript
# File: src/utils/newFile.ts
<<<<<<< SEARCH
======= AND
// This is a brand new file
export function newHelper(): string {
  return "hello";
}
>>>>>>> REPLACE
\`\`\`

**COMMON MISTAKES TO AVOID:**
✗ Forgetting the "# File:" header (edit won't be detected)
✗ Putting SEARCH/REPLACE outside code fences (won't be parsed)
✗ Using separate code blocks for "before" and "after" (use ONE block)
✗ Showing code without the edit format (won't be applied)

`;
    if (editorContext) {
      systemPrompt += `\n${editorContext}`;
    }

    // Add modified files context to prevent redundant edits
    const modifiedFilesContext = this.diffManager.getModifiedFilesContext();
    if (modifiedFilesContext) {
      systemPrompt += modifiedFilesContext;
    }

    // Auto web search if enabled (search BEFORE DeepSeek, not via tool calls)
    const webSearchContext = await this.webSearchManager.searchForMessage(message);

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
    let accumulatedResponse = '';  // For reasoner: accumulates responses across shell iterations

    // Per-iteration tracking for R1 continuation (reasoning AND content)
    let reasoningIterations: string[] = [];
    let currentIterationReasoning = '';
    let contentIterations: string[] = [];
    let currentIterationContent = '';

    // Clear file changes tracking for this response
    this.diffManager.clearResponseFileChanges();

    // Create abort controller for this request
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    // Get the current correlation ID for cross-boundary tracing
    const correlationId = logger.getCurrentCorrelationId();

    this._view.webview.postMessage({
      type: 'startResponse',
      isReasoner: isReasonerModel,
      correlationId: correlationId || undefined
    });

    // Initialize content transform buffer for debounced streaming
    // This prevents jarring UI transitions when <shell> tags are detected
    this.contentBuffer = new ContentTransformBuffer({
      debounceMs: 150,
      debug: false,
      log: (msg) => logger.debug(msg), // Route buffer logs through our logger
      onFlush: (segments) => {
        for (const segment of segments) {
          switch (segment.type) {
            case 'text':
              // Send regular text to frontend
              const textContent = segment.content as string;
              this._view?.webview.postMessage({
                type: 'streamToken',
                token: textContent
              });
              break;

            case 'shell':
              // Don't send shell tags as text - they'll be handled by shellExecuting message
              // Just log for debugging
              logger.debug(`[ContentBuffer] Detected shell commands, will be handled after iteration`);
              break;

            case 'thinking':
              // Thinking tags are for R1 reasoner, handled separately via streamReasoning
              // Just skip them here
              logger.debug(`[ContentBuffer] Detected thinking tags, handled separately`);
              break;

            // NOTE: Code blocks are no longer detected by the buffer - they flow through
            // as normal text and are rendered by the frontend's markdown processing.
          }
        }
      }
    });

    // Log the API request
    const model = this.deepSeekClient.getModel();
    const hasAttachments = attachments && attachments.length > 0;
    const requestStartTime = Date.now();

    // Declare outside try so it's accessible in catch for partial save
    let toolCallsForHistory: Array<{ name: string; detail: string; status: string }> = [];

    try {
      // Get current session messages for context (user message already saved above)
      const currentSession = await this.conversationManager.getCurrentSession();
      const sessionMessages = currentSession
        ? await this.conversationManager.getSessionMessagesCompat(currentSession.id)
        : [];
      const messageCount = sessionMessages.length || 1;
      logger.apiRequest(model, messageCount, hasAttachments);

      // Build messages array - handle multimodal content if attachments present
      const historyMessages: ApiMessage[] = [];
      for (const msg of sessionMessages) {
        historyMessages.push({
          role: msg.role,
          content: msg.content
        });
      }

      // If this message has file attachments, include their contents in the context
      if (attachments && attachments.length > 0) {
        // Build file context to prepend to the last user message
        let fileContext = '\n\n--- Attached Files ---\n';
        for (const attachment of attachments) {
          const content = attachment.content || '';
          fileContext += `\n### File: ${attachment.name}\n\`\`\`\n${content}\n\`\`\`\n`;
        }
        fileContext += '--- End Attached Files ---\n';

        // Append file context to the last user message
        if (historyMessages.length > 0) {
          const lastMsg = historyMessages[historyMessages.length - 1];
          if (lastMsg.role === 'user') {
            lastMsg.content = lastMsg.content + fileContext;
          }
        }
      }

      // If user has selected files for context, include them
      const selectedFilesContext = this.fileContextManager.getSelectedFilesContext();
      if (selectedFilesContext) {
        if (historyMessages.length > 0) {
          const lastMsg = historyMessages[historyMessages.length - 1];
          if (lastMsg.role === 'user') {
            lastMsg.content = lastMsg.content + selectedFilesContext;
            logger.info(`[ChatProvider] ✓ Selected files context injected into user message`);
          }
        }
      }

      // --- Context Window Management ---
      // Truncate old messages to fit within the model's token budget.
      // ContextBuilder fills from newest messages backward and injects a
      // snapshot summary when older messages are dropped.
      const snapshotSummary = currentSession
        ? this.conversationManager.getLatestSnapshotSummary(currentSession.id)
        : undefined;

      const contextResult = await this.deepSeekClient.buildContext(
        historyMessages,
        systemPrompt,
        snapshotSummary
      );

      const contextMessages: ApiMessage[] = contextResult.messages as ApiMessage[];

      // Tool calling loop (only for non-reasoner models)
      let streamingSystemPrompt = systemPrompt;
      if (!isReasonerModel) {
        const { toolMessages, limitReached, budgetExceeded, allToolDetails: toolDetails } = await this.runToolLoop(
          contextMessages, systemPrompt, signal,
          contextResult.tokenCount, contextResult.budget
        );
        toolCallsForHistory = toolDetails;
        // Add tool interactions to history for context
        contextMessages.push(...toolMessages);

        // If tools were used, update system prompt to indicate exploration is complete
        // This prevents the model from trying to use tools during streaming
        if (toolMessages.length > 0) {
          const limitWarning = (limitReached || budgetExceeded)
            ? `\n\nNOTE: The tool calling limit was reached. Summarize what you were able to accomplish and explain what remains to be done.`
            : '';
          streamingSystemPrompt = systemPrompt + `

IMPORTANT: The tool exploration phase is now complete. You have already gathered the necessary information using tools.
Now provide your final response based on what you learned. Do NOT attempt to use any more tools or output any tool-calling markup - just provide your answer directly in plain text.${limitWarning}`;
        }
      }

      // Shell execution tracking for history
      let shellResultsForHistory: ShellResult[] = [];

      // Reasoner shell loop - run shell commands if R1 outputs them
      const maxShellIterations = 5;  // Prevent infinite loops
      let shellIteration = 0;
      let currentSystemPrompt = streamingSystemPrompt;
      let currentHistoryMessages = [...contextMessages];

      // Store original user message for re-injection in continuation prompts
      // This ensures R1 doesn't "forget" the task after shell exploration
      const originalUserMessage = message;

      // Auto-continuation tracking for R1
      // When R1 explores with shell commands but doesn't produce code edits,
      // we auto-continue to prompt it to complete the task
      const maxAutoContinuations = 2;  // Limit to prevent infinite loops
      let autoContinuationCount = 0;
      let lastIterationHadShellCommands = false;

      // Total iteration safeguard (shell iterations + auto-continuations)
      const maxTotalIterations = 10;
      let totalIterations = 0;

      do {
        totalIterations++;
        if (totalIterations > maxTotalIterations) {
          logger.warn(`[R1-Shell] Total iteration limit reached (${maxTotalIterations}), breaking loop`);
          break;
        }

        // Track iteration-specific response (accumulated response is declared outside try block)
        let iterationResponse = '';

        // Timing metrics for debugging
        const iterationStartTime = Date.now();
        let firstReasoningTokenTime: number | null = null;
        let firstContentTokenTime: number | null = null;

        // Log iteration start for debugging R1 continuation
        if (isReasonerModel) {
          logger.info(`[R1-Shell] Starting iteration ${shellIteration + 1}, messages in context: ${currentHistoryMessages.length}`);
          logger.info(`[Timing] Iteration ${shellIteration + 1} started at ${new Date().toISOString()}`);
          // Set iteration for trace context (1-indexed)
          logger.setIteration(shellIteration + 1);
          // Notify frontend of new iteration for per-iteration thinking dropdowns
          this._view?.webview.postMessage({
            type: 'iterationStart',
            iteration: shellIteration + 1  // 1-indexed for display
          });
        } else {
          // Non-reasoner models: single iteration
          logger.setIteration(1);
        }

        const _response = await this.deepSeekClient.streamChat(
          currentHistoryMessages,
          async (token) => {
            // Track timing for first content token
            if (!firstContentTokenTime) {
              firstContentTokenTime = Date.now();
              const waitTime = firstContentTokenTime - iterationStartTime;
              const afterReasoning = firstReasoningTokenTime
                ? firstContentTokenTime - firstReasoningTokenTime
                : 0;
              logger.info(`[Timing] First content token after ${waitTime}ms (${afterReasoning}ms after reasoning started)`);
              // For non-reasoner models, this is the first token
              if (!isReasonerModel) {
                logger.apiStreamProgress('first-token');
              } else if (firstReasoningTokenTime) {
                // For reasoner models: emit thinking-end before content-start
                logger.apiStreamProgress('thinking-end');
              }
              logger.apiStreamProgress('content-start');
            }

            // Log streaming chunk for trace
            logger.apiStreamChunk(token.length, 'text');

            iterationResponse += token;
            accumulatedResponse += token;
            currentIterationContent += token;  // Track content per iteration

            // Use content buffer for debounced streaming (filters shell tags)
            if (this.contentBuffer) {
              this.contentBuffer.append(token);
            } else {
              // Fallback if buffer not initialized
              this._view?.webview.postMessage({
                type: 'streamToken',
                token
              });
            }

            // Detect complete code blocks and auto-handle in "ask" or "auto" mode
            this.diffManager.handleCodeBlockDetection(accumulatedResponse);
          },
          currentSystemPrompt,
          // Reasoning callback for deepseek-reasoner
          isReasonerModel ? (reasoningToken) => {
            // Track timing for first reasoning token
            if (!firstReasoningTokenTime) {
              firstReasoningTokenTime = Date.now();
              const waitTime = firstReasoningTokenTime - iterationStartTime;
              logger.info(`[Timing] First reasoning token after ${waitTime}ms`);
              logger.apiStreamProgress('first-token');
              logger.apiStreamProgress('thinking-start');
            }

            // Log streaming chunk for trace
            logger.apiStreamChunk(reasoningToken.length, 'thinking');

            fullReasoning += reasoningToken;
            currentIterationReasoning += reasoningToken;  // Track per-iteration
            this._view?.webview.postMessage({
              type: 'streamReasoning',
              token: reasoningToken
            });
          } : undefined,
          { signal }
        );

        // Log iteration completion for debugging R1 continuation
        if (isReasonerModel) {
          const iterationDuration = Date.now() - iterationStartTime;
          logger.info(`[Timing] Iteration ${shellIteration + 1} complete in ${iterationDuration}ms`);
          logger.info(`[R1-Shell] Iteration ${shellIteration + 1} complete, response length: ${iterationResponse.length} chars`);
          logger.info(`[R1-Shell] Response preview: ${iterationResponse.substring(0, 300).replace(/\n/g, '\\n')}...`);

          // Save iteration reasoning AND content, reset for next iteration
          if (currentIterationReasoning) {
            reasoningIterations.push(currentIterationReasoning);
            currentIterationReasoning = '';
          }
          if (currentIterationContent) {
            contentIterations.push(currentIterationContent);
            currentIterationContent = '';
          }
        }

        // Check for shell commands in THIS iteration's response AND reasoning
        // R1 can output <shell> tags in either the content or reasoning stream
        const combinedForShellCheck = iterationResponse + (currentIterationReasoning || '');
        if (isReasonerModel && containsShellCommands(combinedForShellCheck)) {
          shellIteration++;
          lastIterationHadShellCommands = true;  // Track for auto-continuation
          const inReasoning = containsShellCommands(currentIterationReasoning || '');
          const inContent = containsShellCommands(iterationResponse);
          logger.info(`[R1-Shell] Iteration ${shellIteration}: found shell commands (inContent=${inContent}, inReasoning=${inReasoning})`);

          // Parse and execute shell commands from both streams
          const commands = parseShellCommands(combinedForShellCheck);
          const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

          if (commands.length > 0 && workspacePath) {
            // IMPORTANT: Flush buffer before sending shellExecuting to prevent race condition
            // The frontend will finalize the current segment when it receives this message,
            // so we need to ensure all pending buffered content is sent first
            if (this.contentBuffer) {
              logger.info(`[Buffer] FLUSH before shellExecuting (${commands.length} commands)`);
              this.contentBuffer.flush();
            }

            // Notify frontend about shell execution
            const shellCommandsPayload = commands.map(c => ({
              command: c.command,
              description: c.command.length > 50 ? c.command.substring(0, 50) + '...' : c.command
            }));
            logger.info(`[Frontend] Sending shellExecuting message: ${shellCommandsPayload.length} commands`);
            this._view?.webview.postMessage({
              type: 'shellExecuting',
              commands: shellCommandsPayload
            });

            // Check "Walk on the Wild Side" setting
            const config = vscode.workspace.getConfiguration('deepseek');
            const allowAllCommands = config.get<boolean>('allowAllShellCommands') ?? false;

            // Execute commands
            const shellStartTime = Date.now();
            logger.info(`[Timing] Shell execution started at ${new Date().toISOString()}`);
            const results = await executeShellCommands(commands, workspacePath, {
              allowAllCommands
            });
            const shellDuration = Date.now() - shellStartTime;
            logger.info(`[Timing] Shell execution completed in ${shellDuration}ms`);
            shellResultsForHistory.push(...results);

            // Notify frontend of results
            this._view?.webview.postMessage({
              type: 'shellResults',
              results: results.map(r => ({
                command: r.command,
                output: r.output.substring(0, 500) + (r.output.length > 500 ? '...' : ''),
                success: r.success
              }))
            });

            // Add to context and continue
            const resultsContext = formatShellResultsForContext(results);

            // Add assistant response with shell commands to API context (for continuation)
            currentHistoryMessages.push({
              role: 'assistant',
              content: iterationResponse
            });

            // Add shell results as user message (like tool results in chat model)
            // Include original user request so R1 doesn't "forget" the task
            currentHistoryMessages.push({
              role: 'user',
              content: `Shell command results:\n${resultsContext}

---
REMINDER - Your original task was:
"${originalUserMessage}"

You have explored the codebase. Now you MUST either:
1. Run additional shell commands if you need more information, OR
2. Produce the code edits using properly formatted code blocks with # File: headers

Do NOT just describe what you found. Complete the original task with actual code changes.`
            });

            // Update system prompt for continuation - reinforce the code edit requirement
            // Include original task to prevent R1 from losing context
            currentSystemPrompt = streamingSystemPrompt + `

The shell commands have been executed and results are provided.
ORIGINAL TASK: "${originalUserMessage}"

You MUST now complete this task:
- If you need more information, run additional shell commands
- Otherwise, produce the code edits in properly formatted code blocks with # File: headers
- Your response is NOT complete until you provide the actual code changes
- Do NOT end with just analysis or description - include the code edits`;

            logger.info(`[R1-Shell] Injected ${results.length} shell results for task: "${originalUserMessage.substring(0, 50)}...", continuing...`);
          }
        } else {
          // No shell commands in this iteration
          if (isReasonerModel) {
            logger.info(`[R1-Shell] No shell commands in iteration, checking for auto-continuation...`);
            logger.info(`[R1-Shell] shellIteration=${shellIteration}, autoContinuationCount=${autoContinuationCount}, lastIterationHadShellCommands=${lastIterationHadShellCommands}`);

            // Check if we should auto-continue:
            // 1. Shell commands were executed in previous iterations (model was exploring)
            // 2. Response doesn't contain code edits (task not complete)
            // 3. Under max auto-continuation limit
            const hasCodeEdits = containsCodeEdits(accumulatedResponse);
            logger.info(`[R1-Shell] Response has code edits: ${hasCodeEdits}`);

            if (shellIteration > 0 && !hasCodeEdits && autoContinuationCount < maxAutoContinuations) {
              autoContinuationCount++;
              logger.info(`[R1-Shell] Auto-continuing (${autoContinuationCount}/${maxAutoContinuations}): shell commands were executed but no code edits produced`);

              // Notify frontend
              this._view?.webview.postMessage({
                type: 'autoContinuation',
                count: autoContinuationCount,
                max: maxAutoContinuations,
                reason: 'No code edits after shell exploration'
              });

              // Add current response to context
              currentHistoryMessages.push({
                role: 'assistant',
                content: iterationResponse
              });

              // Add continuation prompt as user message
              currentHistoryMessages.push({
                role: 'user',
                content: `You explored the codebase but didn't complete the task.

ORIGINAL TASK: "${originalUserMessage}"

You MUST now produce the code edits. Use the SEARCH/REPLACE format with "# File:" headers:

\`\`\`<language>
# File: path/to/file.ext
<<<<<<< SEARCH
exact code to find
======= AND
replacement code
>>>>>>> REPLACE
\`\`\`

Do NOT describe what to do - actually produce the code changes now.`
              });

              // Update system prompt to be more insistent
              currentSystemPrompt = streamingSystemPrompt + `

CRITICAL: The user's original task was: "${originalUserMessage}"
You have already explored the codebase. NOW YOU MUST produce the actual code edits.
Use the SEARCH/REPLACE format with # File: headers. Your response MUST contain code changes.`;

              lastIterationHadShellCommands = false;  // Reset for next iteration
              continue;  // Continue the loop instead of breaking
            }

            // Log exit reason
            logger.info(`[R1-Shell] Loop exiting: iteration=${shellIteration}, hasCodeEdits=${hasCodeEdits}, autoContinuations=${autoContinuationCount}/${maxAutoContinuations}`);
            const lastChars = combinedForShellCheck.slice(-200);
            logger.info(`[R1-Shell] Last 200 chars: ${lastChars.replace(/\n/g, '\\n')}`);
          }
          break;
        }
      } while (shellIteration < maxShellIterations && isReasonerModel);

      if (shellIteration >= maxShellIterations) {
        logger.warn(`[ChatProvider] Reasoner shell loop limit reached (${maxShellIterations} iterations)`);
      }

      // Push final iteration's content (if the loop exited without shell commands)
      if (currentIterationContent) {
        contentIterations.push(currentIterationContent);
        currentIterationContent = '';
      }

      // Flush and reset the content buffer before finalizing
      if (this.contentBuffer) {
        logger.info(`[Buffer] FLUSH before endResponse (final)`);
        this.contentBuffer.flush();
        logger.info(`[Buffer] RESET after final flush`);
        this.contentBuffer.reset();
      }

      // Strip any DSML markup and shell tags from the final response
      // (DeepSeek chat outputs DSML, Reasoner outputs <shell> tags)
      // Use accumulatedResponse to include all content from all shell iterations
      let cleanResponse = stripDSML(accumulatedResponse);
      cleanResponse = stripShellTags(cleanResponse);

      // ============================================
      // Unfenced SEARCH/REPLACE Detection (Fallback)
      // ============================================
      // Check for SEARCH/REPLACE markers that might be OUTSIDE code fences.
      // This handles cases where the LLM outputs the format without proper markdown.
      if (this.diffManager.currentEditMode !== 'manual') {
        await this.diffManager.detectAndProcessUnfencedEdits(cleanResponse);
      }

      // Finalize response
      this._view.webview.postMessage({
        type: 'endResponse',
        message: {
          role: 'assistant',
          content: cleanResponse,
          reasoning_content: fullReasoning || undefined,
          reasoning_iterations: reasoningIterations.length > 0 ? reasoningIterations : undefined,
          content_iterations: contentIterations.length > 0 ? contentIterations : undefined,
          editMode: this.diffManager.currentEditMode
        }
      });

      // Convert shell results to tool call format for history
      // Use 'done' not 'success' to match frontend expectation for status icons
      const shellToolCalls = shellResultsForHistory.map(r => ({
        name: 'shell',
        detail: r.command,
        status: r.success ? 'done' : 'error'
      }));
      const allToolCalls = [...toolCallsForHistory, ...shellToolCalls];

      // ── History Save Pipeline ──
      // Records all aspects of the assistant response as granular events for full-fidelity restore.
      // Order matters: reasoning → tool calls → shell results → file modifications → assistant message.
      // The final recordAssistantMessage() call seals the turn — getSessionRichHistory() uses
      // event sequence order to group everything between the last user_message and this event.
      //
      // For Reasoner model, contentIterations captures per-iteration text (cleaned of shell tags)
      // so that restore can interleave thinking[i] → content[i] → shell[i] matching live streaming.
      //
      // File modifications are tracked synchronously at code block detection time (line ~1848)
      // because applyCodeDirectlyForAutoMode() is fire-and-forget async — the file wouldn't be
      // in currentResponseFileChanges at save time otherwise.
      const tokenCount = this.deepSeekClient.estimateTokens(cleanResponse + fullReasoning);
      if (this.currentSessionId && (cleanResponse || fullReasoning)) {
        logger.info(`[HistorySave] Saving to session=${this.currentSessionId}: reasoning=${reasoningIterations.length}, toolCalls=${toolCallsForHistory.length}, shells=${shellResultsForHistory.length}, content=${cleanResponse.length} chars, model=${model}`);

        try {
          // 1. Record reasoning iterations
          for (let i = 0; i < reasoningIterations.length; i++) {
            this.conversationManager.recordAssistantReasoning(reasoningIterations[i], i);
            logger.info(`[HistorySave] Recorded reasoning iteration ${i} (${reasoningIterations[i].length} chars)`);
          }

          // 2. Record non-shell tool calls
          for (const tc of toolCallsForHistory) {
            const toolCallId = `tc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            this.conversationManager.recordToolCall(toolCallId, tc.name, { detail: tc.detail });
            this.conversationManager.recordToolResult(toolCallId, tc.detail, tc.status === 'done');
            logger.info(`[HistorySave] Recorded tool call: ${tc.name}`);
          }

          // 3. Record shell results with richer data
          for (const sr of shellResultsForHistory) {
            const shellCallId = `sh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            this.conversationManager.recordToolCall(shellCallId, 'shell', { command: sr.command });
            this.conversationManager.recordToolResult(shellCallId, sr.output, sr.success, sr.executionTimeMs);
            logger.info(`[HistorySave] Recorded shell: ${sr.command.substring(0, 50)}`);
          }

          // 4. Record file modifications (for restore of "Modified Files" dropdown)
          const modifiedFiles = [...new Set(
            this.diffManager.getFileChanges()
              .filter(f => f.status === 'applied')
              .map(f => f.filePath)
          )];
          for (const filePath of modifiedFiles) {
            const fileCallId = `fm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            this.conversationManager.recordToolCall(fileCallId, '_file_modified', { filePath });
            this.conversationManager.recordToolResult(fileCallId, filePath, true);
            logger.info(`[HistorySave] Recorded file modification: ${filePath}`);
          }

          // 5. Record the assistant message with real model + finishReason
          // Include per-iteration content text (cleaned) for correct restore ordering
          const cleanedContentIterations = contentIterations.length > 0
            ? contentIterations.map(c => stripShellTags(stripDSML(c)).trim()).filter(c => c.length > 0)
            : undefined;
          await this.conversationManager.recordAssistantMessage(cleanResponse, model, 'stop', undefined, cleanedContentIterations);
          logger.info(`[HistorySave] Recorded assistant message (${cleanResponse.length} chars, model=${model}, contentIts=${cleanedContentIterations?.length || 0})`);
        } catch (saveError: any) {
          logger.error(`[HistorySave] FAILED to save history: ${saveError.message}`, saveError.stack);
        }
      } else {
        logger.warn(`[HistorySave] Skipped save: sessionId=${this.currentSessionId}, cleanResponse=${!!cleanResponse}, fullReasoning=${!!fullReasoning}`);
      }

      // Log successful response
      logger.apiResponse(tokenCount, Date.now() - requestStartTime);

      // Update status bar
      this.statusBar.updateLastResponse();
    } catch (error: any) {
      // Check if this was an abort (user stopped generation)
      if (error.name === 'CanceledError' || error.name === 'AbortError' || signal.aborted) {
        // Save partial response to history if there's content
        // Use accumulatedResponse for reasoner (accumulates across shell iterations), fallback to fullResponse
        const partialContent = accumulatedResponse || fullResponse;
        if (this.currentSessionId && (partialContent || fullReasoning)) {
          const cleanPartialResponse = stripShellTags(stripDSML(partialContent));

          // Record reasoning iterations that completed
          for (let i = 0; i < reasoningIterations.length; i++) {
            this.conversationManager.recordAssistantReasoning(reasoningIterations[i], i);
          }

          // Record the partial assistant message
          const partialText = cleanPartialResponse
            ? `${cleanPartialResponse}\n\n*[Generation stopped]*`
            : '*[Generation stopped]*';
          await this.conversationManager.recordAssistantMessage(partialText, model, 'length');
          logger.info(`[ChatProvider] Saved partial response to history`);
        }
        // Don't show error for user-initiated stops - handled by stopGeneration
        return;
      }
      // Log the error
      logger.error(error.message, error.stack);

      // Check if error is related to context length and provide helpful message about attachments
      let errorMessage = error.message;
      const lowerMessage = errorMessage.toLowerCase();
      if (lowerMessage.includes('context') || lowerMessage.includes('token') || lowerMessage.includes('length') || lowerMessage.includes('too long')) {
        const totalAttachmentSize = attachments ? attachments.reduce((sum, a) => sum + (a.content?.length || 0), 0) : 0;
        if (totalAttachmentSize > 0) {
          const sizeKB = (totalAttachmentSize / 1024).toFixed(1);
          errorMessage = `Context limit exceeded. Your attached files total ${sizeKB}KB - try attaching smaller or fewer files.`;
        }
      }

      this._view.webview.postMessage({
        type: 'error',
        error: errorMessage
      });
    } finally {
      this.abortController = null;
      // Clean up content buffer
      if (this.contentBuffer) {
        logger.info(`[Buffer] FLUSH in finally block (cleanup)`);
        this.contentBuffer.flush();
        logger.info(`[Buffer] RESET in finally block (cleanup)`);
        this.contentBuffer.reset();
      }
    }
  }

  /**
   * Run the tool calling loop - keeps calling the LLM until it stops requesting tools.
   * Returns the messages from tool interactions to add to context.
   */
  private async runToolLoop(
    messages: ApiMessage[],
    systemPrompt: string,
    signal: AbortSignal,
    contextTokenCount?: number,
    contextBudget?: number
  ): Promise<{ toolMessages: ApiMessage[]; limitReached: boolean; budgetExceeded: boolean; allToolDetails: Array<{ name: string; detail: string; status: string }> }> {
    const toolMessages: ApiMessage[] = [];
    // Get max tool calls from config (100 = no limit)
    const config = vscode.workspace.getConfiguration('deepseek');
    const configuredLimit = config.get<number>('maxToolCalls') ?? 25;
    const maxIterations = configuredLimit >= 100 ? Infinity : configuredLimit;
    let iterations = 0;

    // Token budget tracking for tool loop messages
    let accumulatedToolTokens = 0;
    const budgetLimit = contextBudget ?? 0;
    const baseTokenCount = contextTokenCount ?? 0;
    let budgetExceeded = false;

    // Track ALL tool calls across all iterations for return value
    const allToolDetails: Array<{ name: string; detail: string; status: string }> = [];
    // Track tools for the CURRENT BATCH (may span multiple iterations)
    let batchToolDetails: Array<{ name: string; detail: string; status: string }> = [];
    let toolContainerStarted = false;
    let globalToolIndex = 0;
    // Track if a file was modified in the current batch (triggers batch close)
    let fileModifiedInBatch = false;

    while (iterations < maxIterations) {
      iterations++;

      // Check if aborted
      if (signal.aborted) {
        break;
      }

      // Check if accumulated tool messages are approaching the budget
      if (budgetLimit > 0 && baseTokenCount + accumulatedToolTokens > budgetLimit * 0.95) {
        logger.warn(
          `[Context] Tool loop stopped: approaching budget ` +
          `(${(baseTokenCount + accumulatedToolTokens).toLocaleString()}/${budgetLimit.toLocaleString()} tokens, ` +
          `${iterations - 1} iterations completed)`
        );
        budgetExceeded = true;
        break;
      }

      // Build tools array (web search is now handled before this loop, not as a tool)
      // Add apply_code_edit tool for chat model (reasoner can't use tools)
      const tools = [...workspaceTools, applyCodeEditTool];

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

      // Add tools from this iteration to the current batch
      const newTools = toolDetails.map(t => ({ name: t.name, detail: t.detail, status: 'pending' }));
      batchToolDetails.push(...newTools);

      // Add to global tracking (for return value)
      allToolDetails.push(...newTools);

      // Start a NEW tool container OR update existing batch
      if (!toolContainerStarted) {
        // Start new batch
        logger.info(`[Frontend] Sending toolCallsStart message: ${batchToolDetails.length} tools`);
        this._view?.webview.postMessage({
          type: 'toolCallsStart',
          tools: batchToolDetails
        });
        toolContainerStarted = true;
      } else {
        // Update existing batch with all tools (including new ones)
        logger.info(`[Frontend] Sending toolCallsUpdate message: batch now has ${batchToolDetails.length} tools`);
        this._view?.webview.postMessage({
          type: 'toolCallsUpdate',
          tools: batchToolDetails
        });
      }

      // Add assistant message with tool calls (required for API contract)
      // Use empty content if no real content - the tool_calls field is what matters
      // Avoid placeholder text like "Calling tools:" as it can appear in the output
      toolMessages.push({
        role: 'assistant',
        content: response.content || '',
        tool_calls: response.tool_calls
      });

      // Count assistant message tokens (content + tool_calls JSON)
      if (budgetLimit > 0) {
        const assistantText = (response.content || '') + JSON.stringify(response.tool_calls);
        accumulatedToolTokens += this.deepSeekClient.estimateTokens(assistantText);
      }

      // Calculate batch-relative index for this iteration's tools
      const batchStartIndex = batchToolDetails.length - newTools.length;

      // Execute each tool call
      for (let i = 0; i < response.tool_calls.length; i++) {
        const toolCall = response.tool_calls[i];
        const detail = toolDetails[i];
        const globalIndex = globalToolIndex + i;
        const batchIndex = batchStartIndex + i;

        logger.toolCall(toolCall.function.name);

        // Update status to running (use batch index for the current batch)
        batchToolDetails[batchIndex].status = 'running';
        allToolDetails[globalIndex].status = 'running';
        this._view?.webview.postMessage({
          type: 'toolCallUpdate',
          index: batchIndex, // Index within the current batch
          status: 'running',
          detail: detail.detail
        });

        // Execute tool
        const result = await executeToolCall(toolCall);
        const success = !result.startsWith('Error:');
        logger.toolResult(toolCall.function.name, success);

        // Track ALL read files for auto-diff and inference
        if (toolCall.function.name === 'read' && success) {
          try {
            logger.info(`[ChatProvider] Tool arguments raw: ${toolCall.function.arguments}`);
            const args = JSON.parse(toolCall.function.arguments);
            logger.info(`[ChatProvider] Parsed args: ${JSON.stringify(args)}`);
            if (args.file_path) {
              this.fileContextManager.trackReadFile(args.file_path);
            } else {
              logger.warn(`[ChatProvider] ✗ read tool called but no file_path in args`);
            }
          } catch (e) {
            logger.error(`[ChatProvider] ✗ Failed to parse tool arguments: ${e}`);
          }
        }

        // Track apply_code_edit tool calls for file path extraction
        if (toolCall.function.name === 'apply_code_edit' && success) {
          try {
            logger.info(`[ChatProvider] apply_code_edit tool called - args: ${toolCall.function.arguments}`);
            const args = JSON.parse(toolCall.function.arguments);
            logger.info(`[ChatProvider] Parsed apply_code_edit args: ${JSON.stringify(args)}`);
            if (args.file) {
              this.fileContextManager.trackReadFile(args.file);

              // Handle based on edit mode
              if (args.code) {
                if (this.diffManager.currentEditMode === 'ask') {
                  logger.info(`[ChatProvider] Triggering auto-diff for apply_code_edit in ask mode`);
                  // Add # File: header to the code
                  const codeWithHeader = `# File: ${args.file}\n${args.code}`;
                  const language = args.language || 'plaintext';

                  // Trigger auto-diff (this will open diff and show accept/reject overlay)
                  await this.diffManager.handleAutoShowDiff(codeWithHeader, language);
                } else if (this.diffManager.currentEditMode === 'auto') {
                  logger.info(`[ChatProvider] Auto-applying code edit for: ${args.file}`);
                  // In auto mode, apply code directly (skip notification, we'll batch it)
                  const applied = await this.diffManager.applyCodeDirectlyForAutoMode(args.file, args.code, args.description, true);
                  if (applied) {
                    fileModifiedInBatch = true;
                  }
                }
              }
            } else {
              logger.warn(`[ChatProvider] ✗ apply_code_edit called but no file in args`);
            }
          } catch (e) {
            logger.error(`[ChatProvider] ✗ Failed to parse apply_code_edit arguments: ${e}`);
          }
        }

        // Add tool result to messages
        toolMessages.push({
          role: 'tool',
          content: result,
          tool_call_id: toolCall.id
        });

        // Count tool result tokens
        if (budgetLimit > 0) {
          accumulatedToolTokens += this.deepSeekClient.estimateTokens(result);
        }

        // Update status to done (use batch index for the current batch)
        const finalStatus = success ? 'done' : 'error';
        batchToolDetails[batchIndex].status = finalStatus;
        allToolDetails[globalIndex].status = finalStatus;
        this._view?.webview.postMessage({
          type: 'toolCallUpdate',
          index: batchIndex, // Index within the current batch
          status: finalStatus,
          detail: detail.detail
        });
      }

      // Update global index for next iteration
      globalToolIndex += response.tool_calls.length;

      // If a file was modified in this iteration, close the batch and show modified files
      // This creates the interleaving: [Tools batch] [Modified Files] [Next Tools batch]
      if (fileModifiedInBatch) {
        this._view?.webview.postMessage({
          type: 'toolCallsEnd'
        });
        toolContainerStarted = false;
        logger.info(`[Frontend] Sent toolCallsEnd (file modified, closing batch after iteration ${iterations})`);

        // Send the modified files notification
        this.diffManager.emitAutoAppliedChanges();

        // Reset for next batch
        batchToolDetails = [];
        fileModifiedInBatch = false;
      }
    }

    // Close any remaining open batch at the end of the loop
    if (toolContainerStarted) {
      this._view?.webview.postMessage({
        type: 'toolCallsEnd'
      });
      logger.info(`[Frontend] Sent toolCallsEnd (end of tool loop)`);
    }

    const limitReached = iterations >= maxIterations && maxIterations !== Infinity;
    if (limitReached || budgetExceeded) {
      const totalToolCalls = globalToolIndex;
      const reason = budgetExceeded ? 'Context budget exceeded' : 'Tool iteration limit reached';
      this._view?.webview.postMessage({
        type: 'warning',
        message: `${reason} (${iterations} iterations, ${totalToolCalls} total tool calls). The task may require multiple requests to complete.`
      });
    }

    return { toolMessages, limitReached, budgetExceeded, allToolDetails };
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

  /**
   * Shows quick pick menu for managing diffs (public wrapper for extension.ts command)
   */
  public async showDiffQuickPick(): Promise<void> {
    return this.diffManager.showDiffQuickPick();
  }

  private async loadCurrentSessionHistory() {
    const currentSession = await this.conversationManager.getCurrentSession();
    if (!currentSession || !this._view) return;

    const history = await this.conversationManager.getSessionRichHistory(currentSession.id);
    if (history.length > 0) {
      // Notify webview of loaded session (for SessionActor)
      this._view.webview.postMessage({
        type: 'sessionLoaded',
        sessionId: currentSession.id,
        title: currentSession.title,
        model: this.deepSeekClient.getModel()
      });

      this._view.webview.postMessage({
        type: 'loadHistory',
        history
      });
    }
  }

  public async loadSession(sessionId: string) {
    const session = await this.conversationManager.getSession(sessionId);
    logger.info(`[loadSession] session=${sessionId}, found=${!!session}, view=${!!this._view}`);
    if (session && this._view) {
      this.currentSessionId = session.id;
      await this.conversationManager.switchToSession(sessionId);
      logger.sessionSwitch(sessionId);

      // Don't switch to session's model - keep user's current model selection
      // The model dropdown reflects user preference, not per-session setting

      // Notify webview of loaded session (for SessionActor)
      this._view.webview.postMessage({
        type: 'sessionLoaded',
        sessionId: session.id,
        title: session.title,
        model: this.deepSeekClient.getModel() // Use current model, not session's
      });

      // Load session messages via loadHistory (clears and loads)
      const history = await this.conversationManager.getSessionRichHistory(sessionId);
      logger.info(`[loadSession] Sending loadHistory: ${history.length} turns, contentIts=${history.filter(t => t.contentIterations).length}`);
      this._view.webview.postMessage({
        type: 'loadHistory',
        history
      });
    }
  }

  private getHtmlForWebview(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'dist', 'media', 'chat.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'dist', 'media', 'chat.css')
    );
    const iconUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'dist', 'media', 'moby.png')
    );

    // Check if dev mode is enabled (via config or extension development host)
    const config = vscode.workspace.getConfiguration('deepseek');
    const isDevMode = config.get<boolean>('devMode', false);

    // Dev script is a SEPARATE bundle - only loaded when devMode is true
    // This keeps dev tools completely out of the production chat.js
    const devScriptUri = isDevMode ? webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'dist', 'media', 'dev.js')
    ) : null;

    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>DeepSeek Moby</title>
        <link href="${styleUri}" rel="stylesheet">
      </head>
      <body data-moby-icon="${iconUri}" data-dev-mode="${isDevMode}">
        <div class="chat-container">
          <div class="header">
            <img src="${iconUri}" alt="DeepSeek Moby" class="header-icon">
            <div id="toastContainer" class="toast-container"></div>
            <div class="header-actions">
              <!-- Model selector - button acts as click target, parent is Shadow DOM host -->
              <div class="model-selector">
                <button id="modelBtn" class="model-btn" title="Click to change model">
                  <span id="currentModelName">Chat (V3)</span>
                  <span class="model-dropdown-arrow">▼</span>
                </button>
                <!-- Shadow DOM popup renders here via ModelSelectorShadowActor -->
              </div>
              <button id="historyBtn" class="history-btn" title="Chat History">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M8 1a7 7 0 1 1 0 14A7 7 0 0 1 8 1zm0 1a6 6 0 1 0 0 12A6 6 0 0 0 8 2zm-.5 2h1v4.25l2.85 1.65-.5.85L7.5 8.75V4z"/>
                </svg>
              </button>
              <button id="inspectorBtn" class="inspector-btn" title="UI Inspector">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M14.4 3.6L12.5 5.5a2.5 2.5 0 0 1-3.5 3.5l-5 5a1.4 1.4 0 0 1-2-2l5-5a2.5 2.5 0 0 1 3.5-3.5l1.9-1.9c.2-.2.5-.2.7 0l.3.3c.2.2.2.5 0 .7z"/>
                </svg>
              </button>
              <!-- Commands dropdown - button acts as click target, parent is Shadow DOM host -->
              <div class="commands-selector">
                <button id="commandsBtn" class="commands-btn" title="Commands">
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 13A6 6 0 1 1 8 2a6 6 0 0 1 0 12zm-.5-3h1v1h-1v-1zm.5-7a2.5 2.5 0 0 0-2.5 2.5h1A1.5 1.5 0 1 1 8 8c-.55 0-1 .45-1 1v1h1v-.8c0-.11.09-.2.2-.2h.3a2.5 2.5 0 0 0 0-5z"/>
                  </svg>
                </button>
                <!-- Shadow DOM popup renders here via CommandsShadowActor -->
              </div>
              <!-- Settings dropdown - button acts as click target, parent is Shadow DOM host -->
              <div class="settings-selector">
                <button id="settingsBtn" class="settings-btn" title="Settings">
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M9.1 4.4L8.6 2H7.4l-.5 2.4-.7.3-2-1.3-.9.8 1.3 2-.2.7-2.4.5v1.2l2.4.5.3.8-1.3 2 .8.8 2-1.3.8.3.4 2.3h1.2l.5-2.4.8-.3 2 1.3.8-.8-1.3-2 .3-.8 2.3-.4V7.4l-2.4-.5-.3-.8 1.3-2-.8-.8-2 1.3-.7-.2zM9.4 1l.5 2.4L12 2.1l2 2-1.4 2.1 2.4.4v2.8l-2.4.5L14 12l-2 2-2.1-1.4-.5 2.4H6.6l-.5-2.4L4 13.9l-2-2 1.4-2.1L1 9.4V6.6l2.4-.5L2.1 4l2-2 2.1 1.4.4-2.4h2.8zm.6 7a2 2 0 1 1-4 0 2 2 0 0 1 4 0z"/>
                  </svg>
                </button>
                <!-- Shadow DOM popup renders here via SettingsShadowActor -->
              </div>
            </div>
          </div>

          <div id="chatMessages" class="chat-messages"></div>

          <!-- Shadow Actor containers - actors render their own DOM into these -->
          <div class="shadow-actors-container">
            <div class="shadow-actors-row">
              <div id="toolbarContainer" class="toolbar-container"></div>
              <div class="input-wrapper">
                <div id="inputAreaContainer" class="input-area-container"></div>
                <div id="statusPanelContainer" class="status-panel-container"></div>
              </div>
            </div>
          </div>
        </div>

        <script src="${scriptUri}"></script>
        ${devScriptUri ? `<script src="${devScriptUri}"></script>` : ''}
      </body>
      </html>
    `;
  }
}