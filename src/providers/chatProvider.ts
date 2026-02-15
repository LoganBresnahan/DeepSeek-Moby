import * as vscode from 'vscode';
import { DeepSeekClient } from '../deepseekClient';
import { StatusBar } from '../views/statusBar';
import { ConversationManager } from '../events';
import { DiffEngine } from '../utils/diff';
import { logger } from '../utils/logger';
import { tracer, type TraceCategory } from '../tracing';
import { webviewLogStore } from '../logging/WebviewLogStore';
import { TavilyClient } from '../clients/tavilyClient';
import { WebSearchManager } from './webSearchManager';
import { FileContextManager } from './fileContextManager';
import { DiffManager } from './diffManager';
import { SettingsManager } from './settingsManager';
import { RequestOrchestrator } from './requestOrchestrator';

export class ChatProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'deepseek-chat-view';
  private _view?: vscode.WebviewView;
  private deepSeekClient: DeepSeekClient;
  private statusBar: StatusBar;
  private conversationManager: ConversationManager;
  private currentSessionId: string | null = null;
  private disposables: vscode.Disposable[] = [];
  private tavilyClient: TavilyClient;

  // Message queuing during post-response summarization
  private _summarizing = false;
  private _pendingMessages: Array<{ message: string; attachments?: Array<{ content: string; name: string; size: number }> }> = [];
  private webSearchManager: WebSearchManager;
  private fileContextManager: FileContextManager;
  private diffManager: DiffManager;
  private settingsManager: SettingsManager;
  private requestOrchestrator: RequestOrchestrator;

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

    // Create managers
    this.webSearchManager = new WebSearchManager(this.tavilyClient);
    this.fileContextManager = new FileContextManager();
    const config = vscode.workspace.getConfiguration('deepseek');
    const editMode = (config.get<string>('editMode') || 'manual') as 'manual' | 'ask' | 'auto';
    this.diffManager = new DiffManager(new DiffEngine(), this.fileContextManager, editMode);
    this.settingsManager = new SettingsManager(this.deepSeekClient);
    this.requestOrchestrator = new RequestOrchestrator(
      this.deepSeekClient, this.conversationManager, this.statusBar,
      this.diffManager, this.webSearchManager, this.fileContextManager
    );

    // Wire manager events → webview
    this.wireEvents();

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

  // ── Manager Event Wiring ──

  private wireEvents(): void {
    // WebSearchManager → webview
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

    // FileContextManager → webview
    this.fileContextManager.onOpenFiles(data => {
      this._view?.webview.postMessage({ type: 'openFiles', files: data.files });
    });
    this.fileContextManager.onSearchResults(data => {
      this._view?.webview.postMessage({ type: 'searchResults', results: data.results });
    });
    this.fileContextManager.onFileContent(data => {
      this._view?.webview.postMessage({ type: 'fileContent', filePath: data.filePath, content: data.content });
    });

    // DiffManager → webview
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

    // SettingsManager → webview
    this.settingsManager.onSettingsChanged(snapshot => {
      if (this._view) {
        const wsSettings = this.webSearchManager.getSettings().settings;
        this._view.webview.postMessage({
          type: 'settings',
          ...snapshot,
          webSearch: {
            searchDepth: wsSettings.searchDepth,
            creditsPerPrompt: wsSettings.creditsPerPrompt,
            maxResultsPerSearch: wsSettings.maxResultsPerSearch,
            cacheDuration: wsSettings.cacheDuration
          }
        });
        const config = vscode.workspace.getConfiguration('deepseek');
        const editMode = config.get<string>('editMode') || 'manual';
        this.diffManager.setEditMode(editMode as 'manual' | 'ask' | 'auto');
        this._view.webview.postMessage({ type: 'editModeSettings', mode: editMode });
      }
    });
    this.settingsManager.onModelChanged(data => {
      this._view?.webview.postMessage({ type: 'modelChanged', model: data.model });
    });
    this.settingsManager.onDefaultPromptRequested(data => {
      this._view?.webview.postMessage({ type: 'defaultSystemPrompt', model: data.model, prompt: data.prompt });
    });
    this.settingsManager.onSettingsReset(() => {
      this.webSearchManager.resetToDefaults();
      this._view?.webview.postMessage({ type: 'settingsReset' });
    });

    // RequestOrchestrator → webview
    this.requestOrchestrator.onStartResponse(d => {
      this._view?.webview.postMessage({ type: 'startResponse', ...d });
    });
    this.requestOrchestrator.onStreamToken(d => {
      this._view?.webview.postMessage({ type: 'streamToken', token: d.token });
    });
    this.requestOrchestrator.onStreamReasoning(d => {
      this._view?.webview.postMessage({ type: 'streamReasoning', token: d.token });
    });
    this.requestOrchestrator.onEndResponse(d => {
      this._view?.webview.postMessage({ type: 'endResponse', message: d });
    });
    this.requestOrchestrator.onGenerationStopped(() => {
      this._view?.webview.postMessage({ type: 'generationStopped' });
    });
    this.requestOrchestrator.onIterationStart(d => {
      this._view?.webview.postMessage({ type: 'iterationStart', iteration: d.iteration });
    });
    this.requestOrchestrator.onAutoContinuation(d => {
      this._view?.webview.postMessage({ type: 'autoContinuation', ...d });
    });
    this.requestOrchestrator.onToolCallsStart(d => {
      this._view?.webview.postMessage({ type: 'toolCallsStart', tools: d.tools });
    });
    this.requestOrchestrator.onToolCallsUpdate(d => {
      this._view?.webview.postMessage({ type: 'toolCallsUpdate', tools: d.tools });
    });
    this.requestOrchestrator.onToolCallUpdate(d => {
      this._view?.webview.postMessage({ type: 'toolCallUpdate', ...d });
    });
    this.requestOrchestrator.onToolCallsEnd(() => {
      this._view?.webview.postMessage({ type: 'toolCallsEnd' });
    });
    this.requestOrchestrator.onShellExecuting(d => {
      this._view?.webview.postMessage({ type: 'shellExecuting', commands: d.commands });
    });
    this.requestOrchestrator.onShellResults(d => {
      this._view?.webview.postMessage({ type: 'shellResults', results: d.results });
    });
    this.requestOrchestrator.onSessionCreated(d => {
      this._view?.webview.postMessage({ type: 'sessionCreated', ...d });
    });
    this.requestOrchestrator.onError(d => {
      this._view?.webview.postMessage({ type: 'error', error: d.error });
    });
    this.requestOrchestrator.onWarning(d => {
      this._view?.webview.postMessage({ type: 'warning', message: d.message });
    });

    // Summarization → message queuing flag
    this.requestOrchestrator.onSummarizationStarted(() => {
      this._summarizing = true;
      logger.info('[ChatProvider] Summarization started — queuing enabled');
    });
    this.requestOrchestrator.onSummarizationCompleted(() => {
      this._summarizing = false;
      logger.info('[ChatProvider] Summarization completed — queuing disabled');
    });
  }

  // ── Lifecycle ──

  public dispose() {
    this.webSearchManager.dispose();
    this.fileContextManager.dispose();
    this.diffManager.dispose();
    this.settingsManager.dispose();
    this.requestOrchestrator.dispose();
    this.disposables.forEach(d => d.dispose());
  }

  private async loadCurrentSession() {
    const currentSession = await this.conversationManager.getCurrentSession();
    if (currentSession) {
      this.currentSessionId = currentSession.id;
    }
  }

  // ── WebviewViewProvider & Message Router ──

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
        case 'sendMessage': {
          // Queue messages that arrive during post-response summarization
          if (this._summarizing) {
            this._pendingMessages.push({ message: data.message, attachments: data.attachments });
            logger.info(`[ChatProvider] Message queued during summarization (queue=${this._pendingMessages.length})`);
            this._view?.webview.postMessage({ type: 'statusMessage', message: 'Queued — optimizing context...' });
            break;
          }
          const result = await this.requestOrchestrator.handleMessage(
            data.message, this.currentSessionId,
            () => this.fileContextManager.getEditorContext(),
            data.attachments
          );
          this.currentSessionId = result.sessionId;
          // Drain any messages that were queued during summarization
          await this.drainQueue();
          break;
        }
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
          this.requestOrchestrator.stopGeneration();
          break;
        case 'updateSettings':
          await this.settingsManager.updateSettings(data.settings);
          break;
        case 'selectModel':
          await this.settingsManager.updateSettings({ model: data.model });
          break;
        case 'setTemperature':
          await this.settingsManager.updateSettings({ temperature: data.temperature });
          break;
        case 'setToolLimit':
          await this.settingsManager.updateSettings({ maxToolCalls: data.toolLimit });
          break;
        case 'setShellIterations':
          await this.settingsManager.updateSettings({ maxShellIterations: data.shellIterations });
          break;
        case 'setMaxTokens':
          await this.settingsManager.updateSettings({ maxTokens: data.maxTokens });
          break;
        case 'setLogLevel':
          await this.settingsManager.updateLogSettings({ logLevel: data.logLevel });
          break;
        case 'setLogColors':
          await this.settingsManager.updateLogSettings({ logColors: data.enabled });
          break;
        case 'setWebviewLogLevel':
          await this.settingsManager.updateWebviewLogSettings({ webviewLogLevel: data.logLevel });
          break;
        case 'setTracingEnabled':
          await this.settingsManager.updateTracingSettings({ enabled: data.enabled });
          break;
        case 'openLogs':
          logger.show();
          break;
        case 'setAllowAllCommands':
          await this.settingsManager.updateReasonerSettings({ allowAllCommands: data.enabled });
          break;
        case 'setSystemPrompt':
          await this.settingsManager.updateSystemPrompt(data.systemPrompt);
          break;
        case 'getDefaultSystemPrompt':
          this.settingsManager.sendDefaultSystemPrompt();
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
          await this.settingsManager.updateSettings({ autoSaveHistory: data.enabled });
          break;
        case 'setMaxSessions':
          await this.settingsManager.updateSettings({ maxSessions: data.maxSessions });
          break;
        case 'clearAllHistory':
          await this.clearAllHistory();
          break;
        case 'resetToDefaults':
          await this.settingsManager.resetToDefaults();
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

  // ── Tracing ──

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

  // ── Public API (extension.ts) ──

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

  // ── Message Queue ──

  /**
   * Process messages that were queued during post-response summarization.
   * Each queued message is handled sequentially — if a queued message
   * triggers another summarization, further messages continue to queue
   * and are picked up by the same while loop after the await.
   */
  private async drainQueue(): Promise<void> {
    while (this._pendingMessages.length > 0) {
      const pending = this._pendingMessages.shift()!;
      logger.info(`[ChatProvider] Draining queued message (remaining=${this._pendingMessages.length})`);
      const result = await this.requestOrchestrator.handleMessage(
        pending.message, this.currentSessionId,
        () => this.fileContextManager.getEditorContext(),
        pending.attachments
      );
      this.currentSessionId = result.sessionId;
    }
  }

  // ── Settings & Search Helpers ──

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

  private sendCurrentSettings() {
    const snapshot = this.settingsManager.getCurrentSettings();
    const wsSettings = this.webSearchManager.getSettings().settings;
    const config = vscode.workspace.getConfiguration('deepseek');
    const editMode = config.get<string>('editMode') || 'manual';

    // Sync edit mode with config
    this.diffManager.setEditMode(editMode as 'manual' | 'ask' | 'auto');

    if (this._view) {
      this._view.webview.postMessage({
        type: 'settings',
        ...snapshot,
        webSearch: {
          searchDepth: wsSettings.searchDepth,
          creditsPerPrompt: wsSettings.creditsPerPrompt,
          maxResultsPerSearch: wsSettings.maxResultsPerSearch,
          cacheDuration: wsSettings.cacheDuration
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

  // ── History & Session Management ──

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

  public getTavilyClient(): TavilyClient {
    return this.tavilyClient;
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
      // Send edit mode BEFORE history so webview has correct mode when rendering pending files
      const config = vscode.workspace.getConfiguration('deepseek');
      const editMode = config.get<string>('editMode') || 'manual';
      this._view.webview.postMessage({ type: 'editModeSettings', mode: editMode });

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

      // Send edit mode BEFORE history so webview has correct mode when rendering pending files
      const config = vscode.workspace.getConfiguration('deepseek');
      const editMode = config.get<string>('editMode') || 'manual';
      this._view.webview.postMessage({ type: 'editModeSettings', mode: editMode });

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

  // ── HTML Template ──

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