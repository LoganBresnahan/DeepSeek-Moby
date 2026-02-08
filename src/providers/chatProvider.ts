import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { DeepSeekClient, Message as ApiMessage, ToolCall } from '../deepseekClient';
import { StatusBar } from '../views/statusBar';
import { ConversationManager } from '../events';
import { DiffEngine } from '../utils/diff';
import { logger } from '../utils/logger';
import { workspaceTools, applyCodeEditTool, executeToolCall } from '../tools/workspaceTools';
import { parseDSMLToolCalls, stripDSML } from '../utils/dsmlParser';
import { TavilyClient, TavilySearchResponse } from '../clients/tavilyClient';
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

interface DiffMetadata {
  proposedUri: vscode.Uri;        // The "modified" side of the diff
  originalUri: vscode.Uri;        // The "original" side of the diff
  targetFilePath: string;         // Actual file path (e.g., "src/file.ts")
  code: string;                   // Full code including "# File:" header
  language: string;               // Language identifier
  timestamp: number;              // When this diff was created
  iteration: number;              // Edit iteration number (1, 2, 3, etc.)
  diffId: string;                 // Unique ID for this specific diff
  superseded?: boolean;           // True if a newer iteration exists for same file
}

export class ChatProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'deepseek-chat-view';
  private _view?: vscode.WebviewView;
  private deepSeekClient: DeepSeekClient;
  private statusBar: StatusBar;
  private conversationManager: ConversationManager;
  private currentSessionId: string | null = null;
  private lastActiveEditorUri: vscode.Uri | null = null;
  private abortController: AbortController | null = null;
  private diffEngine: DiffEngine;
  private activeDiffs: Map<string, DiffMetadata> = new Map();
  private resolvedDiffs: Array<{ filePath: string; timestamp: number; status: 'applied' | 'rejected'; iteration: number; diffId: string }> = [];
  private autoAppliedFiles: Array<{ filePath: string; timestamp: number; description?: string }> = [];
  private diffTabGroupId: number | null = null;
  private diffStatusBarItem: vscode.StatusBarItem;
  private disposables: vscode.Disposable[] = [];
  private tavilyClient: TavilyClient;
  private webSearchEnabled: boolean = false;
  private webSearchSettings: {
    searchesPerPrompt: number;
    searchDepth: 'basic' | 'advanced';
    cacheDuration: number;
    maxSearchesPerPrompt: number;
  } = {
    searchesPerPrompt: 1,
    searchDepth: 'basic',
    cacheDuration: 15,
    maxSearchesPerPrompt: 1
  };
  private searchCache: Map<string, { results: string; timestamp: number }> = new Map();
  // Edit mode state
  private editMode: 'manual' | 'ask' | 'auto' = 'manual';
  private processedCodeBlocks = new Set<string>();

  // Debouncing state for ask mode (reduces duplicate diffs when LLM iterates)
  private pendingDiffs = new Map<string, { code: string; language: string; timer: NodeJS.Timeout }>();

  // Track edit iterations per file (for numbering multiple edits to same file)
  private fileEditCounts = new Map<string, number>();

  // Track file changes for current response (saved to history)
  private currentResponseFileChanges: Array<{ filePath: string; status: 'applied' | 'rejected' | 'pending'; iteration: number }> = [];

  // Flag to prevent onDidCloseTextDocument from removing diffs we're intentionally closing
  // Use a counter instead of boolean to handle nested/overlapping close operations
  private closingDiffsInProgress: number = 0;

  // File tracking state
  private selectedFiles = new Map<string, string>(); // path → content (user-selected files)
  private readFilesInTurn = new Set<string>(); // Track ALL files read by LLM during conversation turn
  private userMessageIntent: string | null = null; // Extracted file intent from user message
  private fileModalOpen = false; // Track whether file selection modal is open

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
    this.diffEngine = new DiffEngine();
    this.tavilyClient = tavilyClient;

    // Create status bar item for diff tracking
    this.diffStatusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100 // Priority: higher = more to the left
    );
    this.diffStatusBarItem.command = 'deepseek.showDiffQuickPick';
    this.diffStatusBarItem.tooltip = 'Click to review pending diffs';
    this.disposables.push(this.diffStatusBarItem);

    // Load current session
    this.loadCurrentSession();

    // Track when diff documents are actually closed (tab closed, not just hidden)
    this.disposables.push(
      vscode.workspace.onDidCloseTextDocument((document) => {
        if (document.uri.scheme !== 'deepseek-diff') return;

        logger.info(`[OVERLAY-DEBUG] Diff document closed: ${document.uri.toString()}`);

        // Find which diff this corresponds to
        for (const [uriKey, metadata] of this.activeDiffs.entries()) {
          if (metadata.proposedUri.toString() === document.uri.toString() ||
              metadata.originalUri.toString() === document.uri.toString()) {
            // If we're intentionally closing any diff, ignore ALL close events
            // We handle removal manually in closeSingleDiff to avoid race conditions
            // (VS Code fires close events for documents we're programmatically closing,
            // and sometimes for OTHER diffs in the same tab group)
            if (this.closingDiffsInProgress > 0) {
              logger.info(`[OVERLAY-DEBUG] Ignoring close for ${metadata.targetFilePath} - ${this.closingDiffsInProgress} intentional close(s) in progress`);
              return;
            }
            // User manually closed the diff tab
            logger.info(`[OVERLAY-DEBUG] Removing diff for ${metadata.targetFilePath} due to manual tab close`);
            this.activeDiffs.delete(uriKey);
            this.updateDiffStatusBar();
            this.notifyDiffListChanged();
            break;
          }
        }
      })
    );

    // Track when active editor changes (to update which diff is active)
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (!editor || !this._view) return;

        // Check if the active editor is a diff editor
        if (editor.document.uri.scheme === 'deepseek-diff') {
          // Find which diff this corresponds to
          const uriString = editor.document.uri.toString();

          for (const [key, metadata] of this.activeDiffs.entries()) {
            if (metadata.proposedUri.toString() === uriString ||
                metadata.originalUri.toString() === uriString) {
              // Notify frontend which diff is now active
              this._view.webview.postMessage({
                type: 'activeDiffChanged',
                filePath: metadata.targetFilePath
              });
              logger.info(`[ChatProvider] Active diff changed to: ${metadata.targetFilePath}`);
              break;
            }
          }
        }
      })
    );

    // Track when new files are opened (for live modal updates)
    this.disposables.push(
      vscode.workspace.onDidOpenTextDocument((document) => {
        // If file modal is open, send updated open files list
        if (this.fileModalOpen) {
          const validSchemes = ['file', 'vscode-remote'];
          if (validSchemes.includes(document.uri.scheme) && !document.isClosed) {
            const relativePath = vscode.workspace.asRelativePath(document.uri);

            // Skip VS Code internal files
            if (!relativePath.startsWith('extension-output-') &&
                !relativePath.includes('[') &&
                !document.isUntitled) {
              logger.info(`[ChatProvider] File opened while modal open: ${relativePath} - refreshing list`);
              this.sendOpenFiles();
            }
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

  private notifyDiffListChanged() {
    if (!this._view) return;

    // IMPORTANT: Flush buffer before sending diffListChanged to prevent race condition
    // where buffered content hasn't been emitted before segment finalization
    if (this.contentBuffer) {
      logger.info(`[Buffer] FLUSH before notifyDiffListChanged`);
      this.contentBuffer.flush();
    }

    // Combine pending diffs with resolved diffs
    const pendingDiffs = Array.from(this.activeDiffs.values()).map(meta => ({
      filePath: meta.targetFilePath,
      timestamp: meta.timestamp,
      status: 'pending' as const,
      proposedUri: meta.proposedUri.toString(),
      iteration: meta.iteration,
      diffId: meta.diffId,
      superseded: meta.superseded || false
    }));

    const resolvedDiffsList = this.resolvedDiffs.map(d => ({
      filePath: d.filePath,
      timestamp: d.timestamp,
      status: d.status,
      iteration: d.iteration,
      diffId: d.diffId,
      superseded: false
    }));

    // Combine all diffs
    const combinedDiffs = [...pendingDiffs, ...resolvedDiffsList];

    // Deduplicate by filePath - for resolved diffs, keep only the most recent entry per file
    // Keep all pending diffs visible as user may need to accept/reject them
    const pendingByPath = new Map<string, typeof pendingDiffs[0]>();
    const resolvedByPath = new Map<string, typeof resolvedDiffsList[0]>();

    for (const d of combinedDiffs) {
      if (d.status === 'pending') {
        // For pending, keep the most recent per file (older ones are superseded)
        const existing = pendingByPath.get(d.filePath);
        if (!existing || d.timestamp > existing.timestamp) {
          pendingByPath.set(d.filePath, d);
        }
      } else {
        // For resolved (applied/rejected), keep only the most recent per file
        const existing = resolvedByPath.get(d.filePath);
        if (!existing || d.timestamp > existing.timestamp) {
          resolvedByPath.set(d.filePath, d);
        }
      }
    }

    // Combine deduplicated diffs and sort by timestamp
    const allDiffs = [...pendingByPath.values(), ...resolvedByPath.values()]
      .sort((a, b) => a.timestamp - b.timestamp);

    this._view.webview.postMessage({
      type: 'diffListChanged',
      diffs: allDiffs,
      editMode: this.editMode
    });
  }

  /**
   * Get the list of files that have been successfully modified in this session.
   * Used to inform the LLM about already-applied changes to prevent redundant edits.
   */
  private getModifiedFilesContext(): string {
    // Combine resolved diffs (ask mode) and auto-applied files (auto mode)
    const appliedFiles = new Set<string>();

    for (const diff of this.resolvedDiffs) {
      if (diff.status === 'applied') {
        appliedFiles.add(diff.filePath);
      }
    }

    for (const file of this.autoAppliedFiles) {
      appliedFiles.add(file.filePath);
    }

    if (appliedFiles.size === 0) {
      return '';
    }

    const fileList = Array.from(appliedFiles).map(f => `- ${f}`).join('\n');
    return `
--- ALREADY MODIFIED FILES (this session) ---
The following files have already been successfully modified in this conversation:
${fileList}

Do NOT re-edit these files unless the user explicitly requests additional changes to them.
If changes in other files might require updates to an already-modified file, mention this to the user
rather than automatically re-editing. Example: "I notice my changes to X might require updating Y
which I already edited - would you like me to update it?"
`;
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
        case 'setEditMode':
          this.setEditMode(data.mode);
          break;
        case 'showLogs':
          // Show the DeepSeek output channel (logs)
          logger.show();
          break;
        case 'rejectEdit':
          await this.rejectEdit(data.filePath);
          break;
        case 'acceptSpecificDiff':
          await this.acceptSpecificDiff(data.diffId);
          break;
        case 'rejectSpecificDiff':
          await this.rejectSpecificDiff(data.diffId);
          break;
        case 'focusDiff':
          await this.focusSpecificDiff(data.diffId);
          break;
        case 'openFile':
          await this.openFile(data.filePath);
          break;
        // case 'rejectAllDiffs': ...
        // case 'focusDiff': ...
        case 'getOpenFiles':
          await this.sendOpenFiles();
          break;
        case 'fileModalOpened':
          this.fileModalOpen = true;
          logger.info('[ChatProvider] File modal opened - live updates enabled');
          break;
        case 'fileModalClosed':
          this.fileModalOpen = false;
          logger.info('[ChatProvider] File modal closed - live updates disabled');
          break;
        case 'searchFiles':
          await this.handleFileSearch(data.query);
          break;
        case 'getFileContent':
          await this.sendFileContent(data.filePath);
          break;
        case 'setSelectedFiles':
          await this.setSelectedFiles(data.files);
          break;
        case 'setSearchDepth':
          await this.updateWebSearchSettings({ searchDepth: data.searchDepth });
          break;
        case 'setSearchesPerPrompt':
          await this.updateWebSearchSettings({ maxSearchesPerPrompt: data.searchesPerPrompt });
          break;
        case 'setCacheDuration':
          await this.updateWebSearchSettings({ cacheDuration: data.cacheDuration });
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
    this.searchCache.clear();

    // Clear auto-applied files list for new conversation
    this.autoAppliedFiles = [];

    // Clear resolved diffs list for new conversation
    this.resolvedDiffs = [];

    // Clear file edit counts for new conversation
    this.fileEditCounts.clear();

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
    const logLevel = config.get<string>('logLevel') || 'INFO';
    const logColors = config.get<boolean>('logColors') ?? true;
    const systemPrompt = config.get<string>('systemPrompt') || '';
    const autoSaveHistory = config.get<boolean>('autoSaveHistory') ?? true;
    const maxSessions = config.get<number>('maxSessions') ?? 50;
    const allowAllCommands = config.get<boolean>('allowAllShellCommands') ?? false;

    // Sync internal state with config
    this.editMode = editMode as 'manual' | 'ask' | 'auto';

    if (this._view) {
      this._view.webview.postMessage({
        type: 'settings',
        model,
        temperature,
        maxToolCalls,
        maxTokens,
        logLevel,
        logColors,
        systemPrompt,
        autoSaveHistory,
        maxSessions,
        allowAllCommands,
        // Web search settings
        webSearch: {
          searchDepth: this.webSearchSettings.searchDepth,
          searchesPerPrompt: this.webSearchSettings.maxSearchesPerPrompt,
          cacheDuration: this.webSearchSettings.cacheDuration
        }
      });
      // Send edit mode separately
      this._view.webview.postMessage({
        type: 'editModeSettings',
        mode: editMode
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

  private updateWebSearchSettings(settings: {
    searchesPerPrompt?: number;
    searchDepth?: 'basic' | 'advanced';
    cacheDuration?: number;
    maxSearchesPerPrompt?: number;
  }) {
    if (settings.searchesPerPrompt !== undefined) {
      this.webSearchSettings.searchesPerPrompt = settings.searchesPerPrompt;
    }
    if (settings.searchDepth !== undefined) {
      this.webSearchSettings.searchDepth = settings.searchDepth;
    }
    if (settings.cacheDuration !== undefined) {
      this.webSearchSettings.cacheDuration = settings.cacheDuration;
    }
    if (settings.maxSearchesPerPrompt !== undefined) {
      this.webSearchSettings.maxSearchesPerPrompt = settings.maxSearchesPerPrompt;
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

  private async resetToDefaults() {
    try {
      const config = vscode.workspace.getConfiguration('deepseek');

      // Reset all settings to defaults
      await config.update('logLevel', undefined, vscode.ConfigurationTarget.Global);
      await config.update('logColors', undefined, vscode.ConfigurationTarget.Global);
      await config.update('systemPrompt', undefined, vscode.ConfigurationTarget.Global);
      await config.update('maxTokens', undefined, vscode.ConfigurationTarget.Global);
      await config.update('maxToolCalls', undefined, vscode.ConfigurationTarget.Global);
      await config.update('editMode', undefined, vscode.ConfigurationTarget.Global);
      await config.update('autoSaveHistory', undefined, vscode.ConfigurationTarget.Global);
      await config.update('maxSessions', undefined, vscode.ConfigurationTarget.Global);

      // Reset in-memory settings
      this.webSearchSettings = {
        searchesPerPrompt: 1,
        searchDepth: 'basic',
        cacheDuration: 15,
        maxSearchesPerPrompt: 1
      };

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

  private setEditMode(mode: 'manual' | 'ask' | 'auto') {
    this.editMode = mode;
    logger.info(`[ChatProvider] Edit mode changed to: ${mode}`);
    // Persist to settings
    const config = vscode.workspace.getConfiguration('deepseek');
    config.update('editMode', mode, vscode.ConfigurationTarget.Global);
  }

  private async rejectEdit(filePath: string) {
    logger.info(`[ChatProvider] Edit rejected for: ${filePath}`);
    // Close diff without applying
    await this.closeDiffEditor();
    this._view?.webview.postMessage({ type: 'editRejected', filePath });
  }

  // ============================================
  // FILE SELECTION METHODS
  // ============================================

  private async sendOpenFiles() {
    const openFiles: string[] = [];
    const allUris = new Set<string>();

    // Use tab groups API to get ALL open tabs (even background/unfocused ones)
    // This is more reliable than workspace.textDocuments which may miss deferred tabs
    const tabGroups = vscode.window.tabGroups.all;
    logger.info(`[ChatProvider] Scanning ${tabGroups.length} tab groups for open files`);

    for (const group of tabGroups) {
      logger.info(`[ChatProvider]   Tab group has ${group.tabs.length} tabs`);
      for (const tab of group.tabs) {
        if (tab.input instanceof vscode.TabInputText) {
          const uri = tab.input.uri;
          allUris.add(uri.toString());
          logger.info(`[ChatProvider]     Found tab: ${vscode.workspace.asRelativePath(uri)}`);
        }
      }
    }

    logger.info(`[ChatProvider] Total unique file URIs from tabs: ${allUris.size}`);

    // Process all unique URIs
    for (const uriString of allUris) {
      const uri = vscode.Uri.parse(uriString);
      const relativePath = vscode.workspace.asRelativePath(uri);

      // Log each document
      logger.info(`[ChatProvider] Processing: ${relativePath} | scheme: ${uri.scheme}`);

      // Include file and vscode-remote schemes (for WSL/SSH/containers)
      const validSchemes = ['file', 'vscode-remote'];
      if (!validSchemes.includes(uri.scheme)) {
        logger.info(`[ChatProvider]   → Skipped (invalid scheme: ${uri.scheme})`);
        continue;
      }

      // Skip VS Code internal files (output channels, debug console, etc.)
      if (relativePath.startsWith('extension-output-') ||
          relativePath.includes('[')) {
        logger.info(`[ChatProvider]   → Skipped (VS Code internal file)`);
        continue;
      }

      openFiles.push(relativePath);
      logger.info(`[ChatProvider]   → ✓ INCLUDED in open files list`);
    }

    logger.info(`[ChatProvider] Sending ${openFiles.length} open files to frontend: ${JSON.stringify(openFiles)}`);
    this._view?.webview.postMessage({
      type: 'openFiles',
      files: openFiles
    });
  }

  private async handleFileSearch(query: string) {
    logger.info(`[ChatProvider] File search requested: "${query}"`);
    const results: string[] = [];

    try {
      // Use VS Code's findFiles API to search (case-sensitive by default)
      // Convert query to glob pattern if it doesn't contain wildcards
      let pattern = query;
      if (!query.includes('*') && !query.includes('?')) {
        pattern = `**/*${query}*`;
      }

      logger.info(`[ChatProvider] Searching with pattern: "${pattern}"`);

      const files = await vscode.workspace.findFiles(
        pattern,
        '**/node_modules/**',
        50 // Limit to 50 results
      );

      for (const file of files) {
        const relativePath = vscode.workspace.asRelativePath(file);
        results.push(relativePath);
        logger.info(`[ChatProvider] Found file: ${relativePath}`);
      }

      logger.info(`[ChatProvider] File search for "${query}" returned ${results.length} results`);
    } catch (error: any) {
      logger.error(`[ChatProvider] File search error: ${error.message}`);
    }

    this._view?.webview.postMessage({
      type: 'searchResults',
      results: results
    });
  }

  private async sendFileContent(filePath: string) {
    try {
      // Resolve relative path to absolute
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        logger.error('[ChatProvider] No workspace folder found');
        return;
      }

      const absolutePath = vscode.Uri.joinPath(workspaceFolder.uri, filePath);
      const content = await vscode.workspace.fs.readFile(absolutePath);
      const textContent = Buffer.from(content).toString('utf8');

      logger.info(`[ChatProvider] Sending file content for: ${filePath} (${textContent.length} chars)`);

      this._view?.webview.postMessage({
        type: 'fileContent',
        filePath: filePath,
        content: textContent
      });
    } catch (error: any) {
      logger.error(`[ChatProvider] Error reading file ${filePath}: ${error.message}`);
      vscode.window.showErrorMessage(`Failed to read file: ${filePath}`);
    }
  }

  private async setSelectedFiles(files: Array<{ path: string; content: string }>) {
    this.selectedFiles.clear();

    for (const file of files) {
      this.selectedFiles.set(file.path, file.content);
    }

    logger.info(`[ChatProvider] Updated selected files: ${this.selectedFiles.size} files`);

    // Log file paths for debugging
    for (const path of this.selectedFiles.keys()) {
      logger.info(`[ChatProvider]   - ${path}`);
    }
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

  private async handleUserMessage(message: string, attachments?: Array<{content: string, name: string, size: number}>) {
    if (!this._view) {
      return;
    }

    // Clear processed code blocks for new conversation turn
    this.processedCodeBlocks.clear();
    // Clear read files tracking
    this.readFilesInTurn.clear();
    // Extract user intent from message (for file path inference)
    this.userMessageIntent = this.extractFileIntent(message);
    // Clear any pending debounced diffs
    this.clearPendingDiffs();

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

**Current Edit Mode: ${this.editMode.toUpperCase()}**
${editModeDescriptions[this.editMode]}

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
    const modifiedFilesContext = this.getModifiedFilesContext();
    if (modifiedFilesContext) {
      systemPrompt += modifiedFilesContext;
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
    let accumulatedResponse = '';  // For reasoner: accumulates responses across shell iterations

    // Per-iteration tracking for R1 continuation (reasoning AND content)
    let reasoningIterations: string[] = [];
    let currentIterationReasoning = '';
    let contentIterations: string[] = [];
    let currentIterationContent = '';

    // Clear file changes tracking for this response
    this.currentResponseFileChanges = [];

    // Create abort controller for this request
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    this._view.webview.postMessage({
      type: 'startResponse',
      isReasoner: isReasonerModel
    });

    // Initialize content transform buffer for debounced streaming
    // This prevents jarring UI transitions when <shell> tags are detected
    this.contentBuffer = new ContentTransformBuffer({
      debounceMs: 150,
      debug: true, // Enable extensive debug logging
      log: (msg) => logger.info(msg), // Route buffer logs through our logger
      onFlush: (segments) => {
        logger.info(`[Buffer→Frontend] onFlush: ${segments.length} segment(s) to process`);
        for (const segment of segments) {
          switch (segment.type) {
            case 'text':
              // Send regular text to frontend
              const textContent = segment.content as string;
              const preview = textContent.length > 100 ? textContent.slice(0, 100) + '...' : textContent;
              logger.info(`[Buffer→Frontend] streamToken: "${preview.replace(/\n/g, '\\n')}" (${textContent.length} chars)`);
              this._view?.webview.postMessage({
                type: 'streamToken',
                token: textContent
              });
              break;

            case 'shell':
              // Don't send shell tags as text - they'll be handled by shellExecuting message
              // Just log for debugging
              logger.info(`[ContentBuffer] Detected shell commands, will be handled after iteration`);
              break;

            case 'thinking':
              // Thinking tags are for R1 reasoner, handled separately via streamReasoning
              // Just skip them here
              logger.info(`[ContentBuffer] Detected thinking tags, handled separately`);
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
      if (this.selectedFiles.size > 0) {
        let selectedFilesContext = '\n\n--- Selected Files for Context ---\n';
        logger.info(`[ChatProvider] Injecting ${this.selectedFiles.size} selected files into context`);

        for (const [filePath, content] of this.selectedFiles.entries()) {
          selectedFilesContext += `\n### File: ${filePath}\n\`\`\`\n${content}\n\`\`\`\n`;
          logger.info(`[ChatProvider] ✓ Added selected file to context: ${filePath} (${content.length} chars)`);
        }
        selectedFilesContext += '--- End Selected Files ---\n';

        // Append to the last user message
        if (historyMessages.length > 0) {
          const lastMsg = historyMessages[historyMessages.length - 1];
          if (lastMsg.role === 'user') {
            lastMsg.content = lastMsg.content + selectedFilesContext;
            logger.info(`[ChatProvider] ✓ Selected files context injected into user message`);
          }
        }
      }

      // Tool calling loop (only for non-reasoner models)
      let streamingSystemPrompt = systemPrompt;
      if (!isReasonerModel) {
        const { toolMessages, limitReached, allToolDetails: toolDetails } = await this.runToolLoop(historyMessages, systemPrompt, signal);
        toolCallsForHistory = toolDetails;
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

      // Shell execution tracking for history
      let shellResultsForHistory: ShellResult[] = [];

      // Reasoner shell loop - run shell commands if R1 outputs them
      const maxShellIterations = 5;  // Prevent infinite loops
      let shellIteration = 0;
      let currentSystemPrompt = streamingSystemPrompt;
      let currentHistoryMessages = [...historyMessages];

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
          // Notify frontend of new iteration for per-iteration thinking dropdowns
          this._view?.webview.postMessage({
            type: 'iterationStart',
            iteration: shellIteration + 1  // 1-indexed for display
          });
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
            }

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
            if (this.editMode === 'ask' || this.editMode === 'auto') {
              const codeBlockRegex = /```(\w+)?\n([\s\S]*?)\n```/g;
              const matches = [...accumulatedResponse.matchAll(codeBlockRegex)];

              for (const match of matches) {
                const language = match[1] || 'plaintext';
                const code = match[2];

                // Skip tool outputs
                if (language === 'tool-output') {
                  continue;
                }

                // IMPORTANT: Only auto-process if code has explicit # File: header
                // This prevents false positives when LLM shows explanatory code
                const fileHeaderMatch = code.match(/^#\s*File:\s*(.+?)$/m);
                if (!fileHeaderMatch) {
                  logger.info(`[ChatProvider] Skipping auto-diff for code block without # File: header (likely explanatory code)`);
                  continue;
                }

                // Create unique identifier for this block
                const blockId = `${match.index}-${match[0].length}`;

                // Skip if already processed
                if (this.processedCodeBlocks.has(blockId)) {
                  continue;
                }

                // Mark as processed
                this.processedCodeBlocks.add(blockId);

                if (this.editMode === 'ask') {
                  // Use debounced diff display (waits 2.5s to batch rapid LLM iterations)
                  this.handleDebouncedDiff(code, language);
                } else if (this.editMode === 'auto') {
                  // Auto-apply directly
                  const filePath = fileHeaderMatch[1].trim();
                  const codeWithoutHeader = code.replace(/^#\s*File:.*\n/i, '');
                  logger.info(`[ChatProvider] Auto-applying code block for: ${filePath}`);
                  this.applyCodeDirectlyForAutoMode(filePath, codeWithoutHeader, 'Auto-applied from code block');
                }
              }
            }
          },
          currentSystemPrompt,
          // Reasoning callback for deepseek-reasoner
          isReasonerModel ? (reasoningToken) => {
            // Track timing for first reasoning token
            if (!firstReasoningTokenTime) {
              firstReasoningTokenTime = Date.now();
              const waitTime = firstReasoningTokenTime - iterationStartTime;
              logger.info(`[Timing] First reasoning token after ${waitTime}ms`);
            }
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
      if (this.editMode !== 'manual') {
        await this.detectAndProcessUnfencedEdits(cleanResponse);
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
          editMode: this.editMode
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

      // Save assistant message to history (with clean response)
      const tokenCount = this.deepSeekClient.estimateTokens(cleanResponse + fullReasoning);
      if (this.currentSessionId && (cleanResponse || fullReasoning)) {
        // Combine reasoning and content for storage
        const fullContent = fullReasoning
          ? `<reasoning>\n${fullReasoning}\n</reasoning>\n\n${cleanResponse}`
          : cleanResponse;
        await this.conversationManager.addMessageToCurrentSession({
          role: 'assistant',
          content: fullContent
        });
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
          // Combine reasoning and partial content for storage
          const partialFullContent = fullReasoning
            ? `<reasoning>\n${fullReasoning}\n</reasoning>\n\n${cleanPartialResponse}\n\n*[Generation stopped]*`
            : `${cleanPartialResponse}\n\n*[Generation stopped]*`;
          await this.conversationManager.addMessageToCurrentSession({
            role: 'assistant',
            content: partialFullContent
          });
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
    signal: AbortSignal
  ): Promise<{ toolMessages: ApiMessage[]; limitReached: boolean; allToolDetails: Array<{ name: string; detail: string; status: string }> }> {
    const toolMessages: ApiMessage[] = [];
    // Get max tool calls from config (100 = no limit)
    const config = vscode.workspace.getConfiguration('deepseek');
    const configuredLimit = config.get<number>('maxToolCalls') ?? 25;
    const maxIterations = configuredLimit >= 100 ? Infinity : configuredLimit;
    let iterations = 0;

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
              this.readFilesInTurn.add(args.file_path);
              logger.info(`[ChatProvider] ✓ Tracked read file: ${args.file_path} (total: ${this.readFilesInTurn.size})`);
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
              this.readFilesInTurn.add(args.file);
              logger.info(`[ChatProvider] ✓ Tracked file from apply_code_edit: ${args.file} (total tracked: ${this.readFilesInTurn.size})`);

              // Handle based on edit mode
              if (args.code) {
                if (this.editMode === 'ask') {
                  logger.info(`[ChatProvider] Triggering auto-diff for apply_code_edit in ask mode`);
                  // Add # File: header to the code
                  const codeWithHeader = `# File: ${args.file}\n${args.code}`;
                  const language = args.language || 'plaintext';

                  // Trigger auto-diff (this will open diff and show accept/reject overlay)
                  await this.handleAutoShowDiff(codeWithHeader, language);
                } else if (this.editMode === 'auto') {
                  logger.info(`[ChatProvider] Auto-applying code edit for: ${args.file}`);
                  // In auto mode, apply code directly (skip notification, we'll batch it)
                  const applied = await this.applyCodeDirectlyForAutoMode(args.file, args.code, args.description, true);
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
        this.notifyAutoAppliedFilesChanged();

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
    if (limitReached) {
      const totalToolCalls = globalToolIndex;
      this._view?.webview.postMessage({
        type: 'warning',
        message: `Tool iteration limit reached (${iterations} iterations, ${totalToolCalls} total tool calls). The task may require multiple requests to complete.`
      });
    }

    return { toolMessages, limitReached, allToolDetails };
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
    // NEW: Determine which diff this applies to
    const activeEditor = vscode.window.activeTextEditor;
    let targetMetadata: DiffMetadata | undefined;

    if (activeEditor && activeEditor.document.uri.scheme === 'deepseek-diff') {
      // User is viewing a diff - apply that one
      const uriKey = activeEditor.document.uri.toString();
      targetMetadata = this.activeDiffs.get(uriKey);

      if (!targetMetadata) {
        // Try to find by matching the URI on either side of diff
        for (const [key, meta] of this.activeDiffs.entries()) {
          if (meta.proposedUri.toString() === uriKey ||
              meta.originalUri.toString() === uriKey) {
            targetMetadata = meta;
            break;
          }
        }
      }
    }

    if (!targetMetadata && this.activeDiffs.size > 0) {
      // Fallback: Use most recent diff (last in queue)
      const diffs = Array.from(this.activeDiffs.values())
        .sort((a, b) => b.timestamp - a.timestamp);
      targetMetadata = diffs[0];
      logger.info(`[ChatProvider] No active diff editor, using most recent diff: ${targetMetadata.targetFilePath}`);
    }

    // Extract file path from code or use metadata
    const filePathMatch = code.match(/^#\s*File:\s*(.+?)$/m);
    let targetFilePath = filePathMatch ? filePathMatch[1].trim() : null;

    // If we have metadata and no explicit file path, use metadata's file path
    if (!targetFilePath && targetMetadata) {
      targetFilePath = targetMetadata.targetFilePath;
      logger.info(`[ChatProvider] Using file path from diff metadata: ${targetFilePath}`);
    }

    // Strip "# File:" header
    const cleanCode = code.replace(/^#\s*File:.*\n/i, '');

    let editor = vscode.window.activeTextEditor;

    // If a specific file path is mentioned, try to find/open that file
    if (targetFilePath) {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (workspaceFolders && workspaceFolders.length > 0) {
        let foundDoc: vscode.TextDocument | undefined;

        // Try each workspace folder
        for (const folder of workspaceFolders) {
          const fullPath = vscode.Uri.joinPath(folder.uri, targetFilePath);
          try {
            foundDoc = await vscode.workspace.openTextDocument(fullPath);
            break;
          } catch (error) {
            continue;
          }
        }

        if (foundDoc) {
          // Open the document and use it
          editor = await vscode.window.showTextDocument(foundDoc, { preview: false });
        } else {
          vscode.window.showWarningMessage(`File not found in workspace: ${targetFilePath}`);
          this.sendCodeAppliedStatus(false, `File not found: ${targetFilePath}`);
          return;
        }
      }
    } else {
      // No file path specified - find the target editor
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

      // Only use selection replacement if:
      // 1. We didn't explicitly open a file (no targetFilePath)
      // 2. There's a non-empty selection
      if (!targetFilePath && !selection.isEmpty) {
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

      // Close only the specific diff if we identified it
      if (targetMetadata) {
        await this.closeSingleDiff(targetMetadata);
      } else {
        // Fallback: close all diffs (old behavior)
        await this.closeDiffEditor();
      }

    } catch (error: any) {
      logger.error('Failed to apply code', error.message);
      this.sendCodeAppliedStatus(false, error.message);
    }
  }

  /**
   * Close just the diff tab without removing from tracking.
   * Used for superseded diffs where we want to close the tab but keep showing
   * the entry in the dropdown as "Newer Version Below".
   */
  private async closeDiffTabOnly(metadata: DiffMetadata) {
    // Increment counter to prevent onDidCloseTextDocument from removing ANY diffs
    this.closingDiffsInProgress++;
    logger.info(`[OVERLAY-DEBUG] Closing tab only for ${metadata.targetFilePath} (counter: ${this.closingDiffsInProgress})`);

    try {
      // Find and close the tab for this specific diff
      for (const tabGroup of vscode.window.tabGroups.all) {
        for (const tab of tabGroup.tabs) {
          const input = tab.input as any;
          if (input?.original?.toString() === metadata.originalUri.toString() ||
              input?.modified?.toString() === metadata.proposedUri.toString()) {
            try {
              await vscode.window.tabGroups.close(tab);
              logger.info(`[ChatProvider] Closed superseded diff tab for: ${metadata.targetFilePath}`);
            } catch (e) {
              // Tab might already be closed
            }
            break;
          }
        }
      }
      // Note: We intentionally do NOT remove from activeDiffs or update status bar here
      // The entry stays in tracking so it shows as "Newer Version Below" in the dropdown
    } finally {
      setTimeout(() => {
        this.closingDiffsInProgress = Math.max(0, this.closingDiffsInProgress - 1);
        logger.info(`[OVERLAY-DEBUG] Tab close complete, counter now: ${this.closingDiffsInProgress}`);
      }, 500);
    }
  }

  private async closeSingleDiff(metadata: DiffMetadata) {
    // Increment counter to prevent onDidCloseTextDocument from removing ANY diffs
    // VS Code sometimes fires close events for other diffs in the same tab group
    this.closingDiffsInProgress++;
    logger.info(`[OVERLAY-DEBUG] Starting intentional close for ${metadata.targetFilePath} (counter: ${this.closingDiffsInProgress})`);

    try {
      // Find and close the tab for this specific diff
      for (const tabGroup of vscode.window.tabGroups.all) {
        for (const tab of tabGroup.tabs) {
          const input = tab.input as any;
          if (input?.original?.toString() === metadata.originalUri.toString() ||
              input?.modified?.toString() === metadata.proposedUri.toString()) {
            try {
              await vscode.window.tabGroups.close(tab);
            } catch (e) {
              // Tab might already be closed
            }
            break;
          }
        }
      }

      // Remove from tracking
      this.activeDiffs.delete(metadata.proposedUri.toString());
      logger.info(`Closed diff for: ${metadata.targetFilePath}`);

      // Update status bar
      this.updateDiffStatusBar();

      // Notify frontend
      this.notifyDiffListChanged();
    } finally {
      // Decrement counter after a delay to allow all document close events to settle
      // Use 500ms to be safe - VS Code close events can be delayed
      setTimeout(() => {
        this.closingDiffsInProgress = Math.max(0, this.closingDiffsInProgress - 1);
        logger.info(`[OVERLAY-DEBUG] Intentional close complete, counter now: ${this.closingDiffsInProgress}`);
      }, 500);
    }
  }

  private async closeDiffEditor() {
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
    if (tabsToClose.length > 0) {
      logger.info(`Closing ${tabsToClose.length} diff tab(s)`);
      for (const tab of tabsToClose) {
        try {
          await vscode.window.tabGroups.close(tab);
        } catch (e) {
          // Tab might already be closed
        }
      }
    }

    // Clear all tracked diffs
    this.activeDiffs.clear();
    this.diffTabGroupId = null;

    // Update status bar
    this.updateDiffStatusBar();

    this.notifyDiffListChanged();
  }

  private async acceptSpecificDiff(diffId: string) {
    const metadata = Array.from(this.activeDiffs.values())
      .find(m => m.diffId === diffId);

    if (!metadata) {
      logger.warn(`[ChatProvider] No diff found for diffId: ${diffId}`);
      return;
    }

    // Check if this diff is superseded
    if (metadata.superseded) {
      logger.warn(`[ChatProvider] Cannot accept superseded diff: ${diffId}`);
      this._view?.webview.postMessage({
        type: 'warning',
        message: `This version has been superseded by a newer edit. Please use the newer version.`
      });
      return;
    }

    logger.info(`[ChatProvider] Accepting specific diff: ${diffId} (${metadata.targetFilePath})`);

    try {
      // Open the target file directly using the metadata's file path
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders || workspaceFolders.length === 0) {
        throw new Error('No workspace folder open');
      }

      let fileUri: vscode.Uri | undefined;
      for (const folder of workspaceFolders) {
        const possibleUri = vscode.Uri.joinPath(folder.uri, metadata.targetFilePath);
        try {
          await vscode.workspace.fs.stat(possibleUri);
          fileUri = possibleUri;
          break;
        } catch {
          // File doesn't exist in this folder, might need to create it
        }
      }

      // If file doesn't exist, create it (for new file diffs)
      if (!fileUri) {
        fileUri = vscode.Uri.joinPath(workspaceFolders[0].uri, metadata.targetFilePath);
        // Ensure parent directory exists
        const parentDir = vscode.Uri.joinPath(fileUri, '..');
        try {
          await vscode.workspace.fs.createDirectory(parentDir);
        } catch {
          // Directory might already exist
        }
      }

      // Open the document
      let document: vscode.TextDocument;
      try {
        document = await vscode.workspace.openTextDocument(fileUri);
      } catch {
        // File doesn't exist, create empty
        await vscode.workspace.fs.writeFile(fileUri, new Uint8Array());
        document = await vscode.workspace.openTextDocument(fileUri);
      }

      const currentContent = document.getText();

      // Strip "# File:" header from the code
      const cleanCode = metadata.code.replace(/^#\s*File:.*\n/i, '');

      // Use DiffEngine to apply changes
      const result = this.diffEngine.applyChanges(currentContent, cleanCode);

      // Apply the changes
      const edit = new vscode.WorkspaceEdit();
      const fullRange = new vscode.Range(
        document.positionAt(0),
        document.positionAt(currentContent.length)
      );
      edit.replace(fileUri, fullRange, result.content);
      await vscode.workspace.applyEdit(edit);

      // Save the document
      await document.save();

      logger.info(`Code applied to: ${metadata.targetFilePath}`);

      // Track as resolved
      this.resolvedDiffs.push({
        filePath: metadata.targetFilePath,
        timestamp: metadata.timestamp,
        status: 'applied',
        iteration: metadata.iteration,
        diffId: metadata.diffId
      });

      // Update status in current response file changes for history
      this.updateFileChangeStatus(metadata.targetFilePath, metadata.iteration, 'applied');

      // Close the specific diff tab
      await this.closeSingleDiff(metadata);

      this.sendCodeAppliedStatus(true);

    } catch (error: any) {
      logger.error(`[ChatProvider] Failed to accept diff ${diffId}:`, error.message);
      this.sendCodeAppliedStatus(false, error.message);
    }
  }

  private async rejectSpecificDiff(diffId: string) {
    const metadata = Array.from(this.activeDiffs.values())
      .find(m => m.diffId === diffId);

    if (!metadata) {
      logger.warn(`[ChatProvider] No diff found for diffId: ${diffId}`);
      return;
    }

    // Check if this diff is superseded - allow rejection to clean up the entry
    logger.info(`[ChatProvider] Rejecting specific diff: ${diffId} (${metadata.targetFilePath})`);

    // Track as resolved
    this.resolvedDiffs.push({
      filePath: metadata.targetFilePath,
      timestamp: metadata.timestamp,
      status: 'rejected',
      iteration: metadata.iteration,
      diffId: metadata.diffId
    });

    // Update status in current response file changes for history
    this.updateFileChangeStatus(metadata.targetFilePath, metadata.iteration, 'rejected');

    // Close the specific diff tab
    await this.closeSingleDiff(metadata);
  }

  private updateFileChangeStatus(filePath: string, iteration: number, status: 'applied' | 'rejected') {
    const index = this.currentResponseFileChanges.findIndex(
      fc => fc.filePath === filePath && fc.iteration === iteration
    );
    if (index !== -1) {
      this.currentResponseFileChanges[index].status = status;
    }
  }

  /**
   * Apply code changes directly to a file without showing a diff (for auto mode)
   * @param skipNotification If true, don't send diffListChanged (caller handles batching)
   * @returns true if code was applied successfully
   */
  private async applyCodeDirectlyForAutoMode(filePath: string, code: string, description?: string, skipNotification = false): Promise<boolean> {
    try {
      // Find the file - handle both absolute and relative paths
      let fileUri: vscode.Uri | undefined;

      // Check if path is absolute (Unix: starts with /, Windows: starts with drive letter)
      const isAbsolutePath = filePath.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(filePath);

      if (isAbsolutePath) {
        // Try absolute path directly
        const absoluteUri = vscode.Uri.file(filePath);
        try {
          await vscode.workspace.fs.stat(absoluteUri);
          fileUri = absoluteUri;
        } catch {
          // Absolute path doesn't exist, will fall through to workspace search
        }
      }

      // If not found via absolute path, try workspace-relative
      if (!fileUri) {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
          for (const folder of workspaceFolders) {
            const possibleUri = vscode.Uri.joinPath(folder.uri, filePath);
            try {
              await vscode.workspace.fs.stat(possibleUri);
              fileUri = possibleUri;
              break;
            } catch {
              // File doesn't exist in this folder, continue
            }
          }
        }
      }

      if (!fileUri) {
        logger.warn(`[ChatProvider] Auto mode: File not found: ${filePath}`);
        this._view?.webview.postMessage({
          type: 'warning',
          message: `Could not find file: ${filePath}. The file may have been moved or deleted.`
        });
        return false;
      }

      // Read current content
      const document = await vscode.workspace.openTextDocument(fileUri);
      const currentContent = document.getText();

      // Apply changes using DiffEngine
      const result = this.diffEngine.applyChanges(currentContent, code);

      if (!result.success) {
        logger.warn(`[ChatProvider] Auto mode: Diff application had issues for ${filePath}: ${result.message}`);
        this._view?.webview.postMessage({
          type: 'warning',
          message: `Code edit may not have been applied correctly to ${filePath}: ${result.message || 'No matching code found'}`
        });
      }

      // Apply the changes
      const edit = new vscode.WorkspaceEdit();
      const fullRange = new vscode.Range(
        document.positionAt(0),
        document.positionAt(currentContent.length)
      );
      edit.replace(fileUri, fullRange, result.content);
      await vscode.workspace.applyEdit(edit);

      // Save the document
      await document.save();

      // Track iteration for this file (same as showDiff)
      const currentCount = this.fileEditCounts.get(filePath) || 0;
      const iteration = currentCount + 1;
      this.fileEditCounts.set(filePath, iteration);
      const diffId = `${filePath}-${Date.now()}-${iteration}`;

      logger.info(`[ChatProvider] Auto mode: Applied changes to ${filePath} (iteration ${iteration})`);

      // Track this file as modified (for LLM feedback context)
      this.autoAppliedFiles.push({
        filePath,
        timestamp: Date.now(),
        description
      });

      // Also add to resolvedDiffs so it shows in the dropdown with iteration
      this.resolvedDiffs.push({
        filePath,
        timestamp: Date.now(),
        status: 'applied',
        iteration,
        diffId
      });

      // Track this file change for history (auto-applied = applied status)
      this.currentResponseFileChanges.push({
        filePath,
        status: 'applied',
        iteration
      });

      // Notify frontend (unless caller is handling batching)
      if (!skipNotification) {
        this.notifyAutoAppliedFilesChanged();
      }
      this.sendCodeAppliedStatus(true);
      return true;

    } catch (error: any) {
      logger.error(`[ChatProvider] Auto mode: Failed to apply code to ${filePath}:`, error.message);
      this.sendCodeAppliedStatus(false, error.message, filePath);
      return false;
    }
  }

  /**
   * Notify frontend of auto-applied files list change
   * Uses resolvedDiffs instead of autoAppliedFiles because it has proper diffId/iteration
   */
  private notifyAutoAppliedFilesChanged() {
    if (!this._view) return;

    // IMPORTANT: Flush buffer before sending diffListChanged to prevent race condition
    // where buffered content hasn't been emitted before segment finalization
    if (this.contentBuffer) {
      logger.info(`[Buffer] FLUSH before notifyAutoAppliedFilesChanged`);
      this.contentBuffer.flush();
    }

    // Use resolvedDiffs which has the proper structure (diffId, iteration)
    // Auto-applied files are added to resolvedDiffs with status 'applied'
    // Deduplicate by filePath - keep only the most recent entry for each file
    const deduplicatedDiffs = new Map<string, typeof this.resolvedDiffs[0]>();
    for (const d of this.resolvedDiffs) {
      const existing = deduplicatedDiffs.get(d.filePath);
      if (!existing || d.timestamp > existing.timestamp) {
        deduplicatedDiffs.set(d.filePath, d);
      }
    }

    const diffsArray = Array.from(deduplicatedDiffs.values())
      .sort((a, b) => a.timestamp - b.timestamp)
      .map(d => ({
        filePath: d.filePath,
        timestamp: d.timestamp,
        status: d.status,
        iteration: d.iteration,
        diffId: d.diffId,
        superseded: false
      }));

    logger.info(`[Frontend] Sending diffListChanged (auto-applied) message: ${diffsArray.length} unique files`);
    this._view.webview.postMessage({
      type: 'diffListChanged',
      diffs: diffsArray,
      editMode: this.editMode
    });
  }

  private async acceptAllDiffs() {
    // Apply in chronological order (oldest first)
    const sorted = Array.from(this.activeDiffs.values())
      .sort((a, b) => a.timestamp - b.timestamp);

    logger.info(`[ChatProvider] Accepting all ${sorted.length} diffs`);

    for (const meta of sorted) {
      await this.applyCode(meta.code, meta.language);
    }
  }

  private async rejectAllDiffs() {
    // Create copy since closeSingleDiff modifies the map
    const allDiffs = Array.from(this.activeDiffs.values());

    logger.info(`[ChatProvider] Rejecting all ${allDiffs.length} diffs`);

    for (const meta of allDiffs) {
      await this.closeSingleDiff(meta);
    }
  }

  private async focusSpecificDiff(diffId: string) {
    const metadata = Array.from(this.activeDiffs.values())
      .find(m => m.diffId === diffId);

    if (!metadata) {
      logger.warn(`[ChatProvider] No diff found for diffId: ${diffId}`);
      return;
    }

    // Re-open the diff to bring it to front
    const iterationLabel = metadata.iteration > 1 ? ` (${metadata.iteration})` : '';
    await vscode.commands.executeCommand('vscode.diff',
      metadata.originalUri,
      metadata.proposedUri,
      `${metadata.targetFilePath}${iterationLabel} ↔ With Changes`
    );

    logger.info(`[ChatProvider] Focused diff: ${diffId} (${metadata.targetFilePath})`);
  }

  /**
   * Opens a file in the editor (used for auto-applied files without active diffs)
   */
  private async openFile(filePath: string) {
    if (!filePath) {
      logger.warn('[ChatProvider] openFile called with empty filePath');
      return;
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      logger.warn('[ChatProvider] No workspace folder found');
      return;
    }

    const absolutePath = path.isAbsolute(filePath)
      ? filePath
      : path.join(workspaceFolder.uri.fsPath, filePath);

    const uri = vscode.Uri.file(absolutePath);

    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { preview: false });
      logger.info(`[ChatProvider] Opened file: ${filePath}`);
    } catch (error) {
      logger.warn(`[ChatProvider] Failed to open file: ${filePath}: ${error}`);
      vscode.window.showWarningMessage(`Could not open file: ${filePath}`);
    }
  }

  /**
   * Updates the status bar item to show current diff count
   */
  private updateDiffStatusBar(): void {
    const diffCount = this.activeDiffs.size;

    if (diffCount === 0) {
      this.diffStatusBarItem.hide();
    } else {
      const plural = diffCount === 1 ? 'diff' : 'diffs';
      this.diffStatusBarItem.text = `$(diff) DeepSeek: ${diffCount} ${plural}`;
      this.diffStatusBarItem.backgroundColor = new vscode.ThemeColor(
        'statusBarItem.warningBackground'
      );
      this.diffStatusBarItem.show();
    }
  }

  /**
   * Shows quick pick menu for managing diffs
   */
  public async showDiffQuickPick(): Promise<void> {
    if (this.activeDiffs.size === 0) {
      vscode.window.showInformationMessage('No pending diffs');
      return;
    }

    // Group diffs by file path
    const diffsByFile = new Map<string, DiffMetadata[]>();

    for (const [key, meta] of this.activeDiffs.entries()) {
      const filePath = meta.targetFilePath;
      if (!diffsByFile.has(filePath)) {
        diffsByFile.set(filePath, []);
      }
      diffsByFile.get(filePath)!.push(meta);
    }

    // Create quick pick items
    interface DiffQuickPickItem extends vscode.QuickPickItem {
      metadata: DiffMetadata;
      action?: 'accept' | 'reject';
    }

    const items: DiffQuickPickItem[] = [];

    for (const [filePath, metas] of diffsByFile.entries()) {
      const fileName = path.basename(filePath);
      const diffCount = metas.length;
      const label = diffCount > 1
        ? `$(file) ${fileName} (${diffCount} diffs)`
        : `$(file) ${fileName}`;

      // Add item for each diff
      for (let i = 0; i < metas.length; i++) {
        const meta = metas[i];
        const itemLabel = diffCount > 1 ? `  ${label} - Diff ${i + 1}` : label;

        items.push({
          label: itemLabel,
          description: path.dirname(filePath),
          detail: `Created ${this.formatTimestamp(meta.timestamp)}`,
          metadata: meta,
          buttons: [
            {
              iconPath: new vscode.ThemeIcon('check'),
              tooltip: 'Accept changes'
            },
            {
              iconPath: new vscode.ThemeIcon('close'),
              tooltip: 'Reject changes'
            }
          ]
        });
      }
    }

    // Show quick pick
    const quickPick = vscode.window.createQuickPick<DiffQuickPickItem>();
    quickPick.items = items;
    quickPick.placeholder = 'Select a diff to review (Enter to focus, click buttons to accept/reject)';
    quickPick.matchOnDescription = true;
    quickPick.matchOnDetail = true;

    // Handle item selection (Enter key or click)
    quickPick.onDidAccept(async () => {
      const selected = quickPick.selectedItems[0];
      if (selected) {
        // Focus the diff editor
        await this.focusDiff(selected.metadata);
      }
    });

    // Handle button clicks (Accept/Reject)
    quickPick.onDidTriggerItemButton(async (e) => {
      const item = e.item;
      const button = e.button;

      if (button.tooltip === 'Accept changes') {
        await this.acceptSpecificDiff(item.metadata.targetFilePath);
        logger.info(`[QuickPick] Accepted diff for ${item.metadata.targetFilePath}`);
      } else if (button.tooltip === 'Reject changes') {
        await this.rejectSpecificDiff(item.metadata.targetFilePath);
        logger.info(`[QuickPick] Rejected diff for ${item.metadata.targetFilePath}`);
      }

      // Refresh the quick pick items
      const remainingItems = quickPick.items.filter(i =>
        i.metadata.targetFilePath !== item.metadata.targetFilePath
      );

      if (remainingItems.length === 0) {
        quickPick.hide();
        vscode.window.showInformationMessage('All diffs processed!');
      } else {
        quickPick.items = remainingItems;
      }
    });

    quickPick.show();
  }

  /**
   * Focuses a specific diff editor
   */
  private async focusDiff(metadata: DiffMetadata): Promise<void> {
    // Find the diff editor tab
    for (const tabGroup of vscode.window.tabGroups.all) {
      for (const tab of tabGroup.tabs) {
        if (tab.input instanceof vscode.TabInputTextDiff) {
          // Check if this is our diff
          if (tab.input.modified.toString() === metadata.proposedUri.toString()) {
            // Focus this tab
            await vscode.window.showTextDocument(metadata.proposedUri, {
              viewColumn: tabGroup.viewColumn,
              preview: false
            });
            return;
          }
        }
      }
    }

    logger.warn(`[ChatProvider] Could not find diff editor for ${metadata.targetFilePath}`);
  }

  /**
   * Formats timestamp for display
   */
  private formatTimestamp(timestamp: number): string {
    const now = Date.now();
    const diffMs = now - timestamp;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);

    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    return new Date(timestamp).toLocaleString();
  }

  private async showDiff(code: string, language: string) {
    // Extract file path from "# File:" header if present
    const filePathMatch = code.match(/^#\s*File:\s*(.+?)$/m);
    const targetFilePath = filePathMatch ? filePathMatch[1].trim() : null;

    let editor = vscode.window.activeTextEditor;
    let document: vscode.TextDocument | undefined;

    // If a specific file path is mentioned, try to find/open that file
    if (targetFilePath) {
      // Try to find the file in workspace
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (workspaceFolders && workspaceFolders.length > 0) {
        // Try each workspace folder
        for (const folder of workspaceFolders) {
          const fullPath = vscode.Uri.joinPath(folder.uri, targetFilePath);
          try {
            // Check if file exists and open it (don't show in editor, just load the document)
            document = await vscode.workspace.openTextDocument(fullPath);
            // Update tracked editor URI for later use
            this.lastActiveEditorUri = document.uri;
            break;
          } catch (error) {
            // File not found in this workspace folder, try next
            continue;
          }
        }

        if (!document) {
          // File doesn't exist - this might be a new file creation
          // Create an empty file so we can show a diff (empty → new content)
          logger.info(`[ChatProvider] File not found, creating new file: ${targetFilePath}`);

          const newFileUri = vscode.Uri.joinPath(workspaceFolders[0].uri, targetFilePath);

          // Ensure parent directory exists
          const parentDir = vscode.Uri.joinPath(newFileUri, '..');
          try {
            await vscode.workspace.fs.createDirectory(parentDir);
          } catch {
            // Directory might already exist, that's fine
          }

          // Create empty file
          await vscode.workspace.fs.writeFile(newFileUri, new Uint8Array());
          document = await vscode.workspace.openTextDocument(newFileUri);
          this.lastActiveEditorUri = document.uri;

          logger.info(`[ChatProvider] Created new file for diff: ${targetFilePath}`);
        }
      } else {
        vscode.window.showWarningMessage('No workspace folder open');
        return;
      }
    } else {
      // No file path specified - use active editor
      // If current editor isn't a file (e.g., diff view is active), try to use the last tracked editor
      if (!editor || editor.document.uri.scheme !== 'file') {
        if (this.lastActiveEditorUri) {
          // Try to find the editor with our tracked URI
          const existingDoc = vscode.workspace.textDocuments.find(
            doc => doc.uri.toString() === this.lastActiveEditorUri?.toString()
          );
          if (existingDoc) {
            document = existingDoc;
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
        document = editor.document;
      }
    }

    // Track iteration number for this file (for multiple edits to same file)
    const targetPath = targetFilePath || vscode.workspace.asRelativePath(document.uri);
    const currentCount = this.fileEditCounts.get(targetPath) || 0;
    const iteration = currentCount + 1;
    this.fileEditCounts.set(targetPath, iteration);

    // Generate unique diffId
    const diffId = `${targetPath}-${Date.now()}-${iteration}`;

    logger.info(`[ChatProvider] Creating diff for ${targetPath} (iteration ${iteration})`);

    try {
      const originalContent = document.getText();
      const selection = editor?.selection;

      // Strip "# File:" header if present
      const cleanCode = code.replace(/^#\s*File:.*\n/i, '');

      // Create the proposed content by applying the code to the current file
      let proposedContent: string;

      // Only use selection replacement if:
      // 1. We didn't explicitly open a file (no targetFilePath)
      // 2. There's an active editor with a non-empty selection
      if (!targetFilePath && selection && !selection.isEmpty && editor) {
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

      // Show diff editor in dedicated tab group
      const fileName = document.fileName.split('/').pop() || 'file';
      const iterationLabel = iteration > 1 ? ` (${iteration})` : '';
      const diffTitle = `${fileName}${iterationLabel} ↔ With Changes`;

      // Find or create dedicated diff tab group
      let diffTabGroup: vscode.TabGroup | undefined;

      // Check if we have a tracked diff tab group that still exists
      if (this.diffTabGroupId !== null) {
        diffTabGroup = vscode.window.tabGroups.all.find(g => g.viewColumn === this.diffTabGroupId);
      }

      // If no existing diff tab group, create one by splitting to the right
      if (!diffTabGroup) {
        // Get the rightmost tab group to split from
        const rightmostGroup = vscode.window.tabGroups.all
          .reduce((max, g) => (!max || (g.viewColumn ?? 0) > (max.viewColumn ?? 0)) ? g : max,
                  vscode.window.tabGroups.all[0]);

        // Calculate the new view column (to the right)
        const newViewColumn = (rightmostGroup?.viewColumn ?? vscode.ViewColumn.One) + 1;

        // Open diff in new column (splits to the right)
        // Use preview: false to ensure it opens as a permanent tab
        await vscode.commands.executeCommand('vscode.diff',
          originalUri,
          proposedUri,
          diffTitle,
          {
            viewColumn: newViewColumn,
            preview: false,
            preserveFocus: true
          }
        );

        // Track the new diff tab group
        this.diffTabGroupId = newViewColumn;
        logger.info(`Created new diff tab group at view column ${newViewColumn}`);
      } else {
        // Open diff in existing diff tab group as a NEW TAB
        // CRITICAL: Use preview: false to prevent replacing existing diffs
        await vscode.commands.executeCommand('vscode.diff',
          originalUri,
          proposedUri,
          diffTitle,
          {
            viewColumn: diffTabGroup.viewColumn,
            preview: false,
            preserveFocus: true
          }
        );
        logger.info(`Opened new diff tab in existing group at view column ${diffTabGroup.viewColumn}`);
      }

      // Mark any existing diffs for the same file as superseded and collect them for closing
      // This happens when LLM creates multiple iterations for the same file
      const supersededDiffs: DiffMetadata[] = [];
      for (const [key, existingMeta] of this.activeDiffs.entries()) {
        if (existingMeta.targetFilePath === targetPath && !existingMeta.superseded) {
          existingMeta.superseded = true;
          supersededDiffs.push(existingMeta);
          logger.info(`[ChatProvider] Marked diff iteration ${existingMeta.iteration} for ${targetPath} as superseded`);
        }
      }

      // Track this diff in the Map
      const metadata: DiffMetadata = {
        proposedUri,
        originalUri,
        targetFilePath: targetPath,
        code,
        language,
        timestamp,
        iteration,
        diffId,
        superseded: false
      };

      this.activeDiffs.set(proposedUri.toString(), metadata);
      logger.diffShown(fileName);

      // Track this file change for history (initially pending)
      this.currentResponseFileChanges.push({
        filePath: targetPath,
        status: 'pending',
        iteration
      });

      // Update status bar
      this.updateDiffStatusBar();

      // Notify frontend of updated diff list
      this.notifyDiffListChanged();

      // Close superseded diff tabs (do this after notifying frontend so they see the superseded state first)
      // Use closeDiffTabOnly to keep entries in activeDiffs for dropdown display as "Newer Version Below"
      for (const supersededMeta of supersededDiffs) {
        logger.info(`[ChatProvider] Closing superseded diff tab for ${supersededMeta.targetFilePath} (iteration ${supersededMeta.iteration})`);
        await this.closeDiffTabOnly(supersededMeta);
      }

      // Clean up provider after a delay
      setTimeout(() => disposable.dispose(), 300000); // 5 minutes

    } catch (error: any) {
      logger.error('Failed to show diff', error.message);
      vscode.window.showErrorMessage(`Failed to show diff: ${error.message}`);
    }
  }

  /**
   * Clears all pending debounced diffs
   */
  private clearPendingDiffs(): void {
    for (const [filePath, pending] of this.pendingDiffs.entries()) {
      clearTimeout(pending.timer);
      logger.info(`[ChatProvider] Cleared pending diff timer for ${filePath}`);
    }
    this.pendingDiffs.clear();
  }

  /**
   * Handles debounced diff display for ask mode.
   * Waits 2.5 seconds after the last code block for the same file before showing the diff.
   * This batches rapid LLM iterations (e.g., "oh wait, let me update that again").
   */
  private handleDebouncedDiff(code: string, language: string): void {
    // Extract file path from code
    const filePathMatch = code.match(/^#\s*File:\s*(.+?)$/m);
    const filePath = filePathMatch ? filePathMatch[1].trim() : 'unknown';

    logger.info(`[ChatProvider] Debouncing diff for ${filePath} (2.5s delay)`);

    // Check if there's already a pending diff for this file
    const existing = this.pendingDiffs.get(filePath);

    if (existing) {
      // Clear the old timer
      clearTimeout(existing.timer);
      logger.info(`[ChatProvider] Replaced pending diff for ${filePath} (LLM iteration detected)`);
    }

    // Create new timer
    const timer = setTimeout(async () => {
      logger.info(`[ChatProvider] Debounce timer expired for ${filePath}, showing diff now`);
      this.pendingDiffs.delete(filePath);
      await this.handleAutoShowDiff(code, language);
    }, 2500); // 2.5 second debounce

    // Store the pending diff
    this.pendingDiffs.set(filePath, { code, language, timer });
  }

  /**
   * Detect and process SEARCH/REPLACE blocks that appear OUTSIDE of code fences.
   * This is a fallback for when the LLM doesn't format output correctly.
   *
   * The DiffEngine already has robust parsing for SEARCH/REPLACE format.
   * This method just needs to detect when to invoke it outside of fenced code blocks.
   */
  private async detectAndProcessUnfencedEdits(content: string): Promise<void> {
    // Quick check: does the content even have SEARCH/REPLACE markers?
    const hasSearchMarker = /<<<{3,}\s*SEARCH/i.test(content);
    const hasReplaceMarker = />>>{3,}\s*REPLACE/i.test(content);

    if (!hasSearchMarker || !hasReplaceMarker) {
      return; // No unfenced markers to process
    }

    logger.info(`[ChatProvider] Detected potential unfenced SEARCH/REPLACE markers`);

    // Check if all SEARCH/REPLACE blocks are inside code fences
    // If they're inside fences, they were already processed during streaming
    const fencedBlockRegex = /```[\w]*\n[\s\S]*?```/g;
    let contentWithoutFencedBlocks = content;
    let match;
    while ((match = fencedBlockRegex.exec(content)) !== null) {
      // Replace fenced blocks with placeholder to check what's left
      contentWithoutFencedBlocks = contentWithoutFencedBlocks.replace(match[0], '<<<FENCED_BLOCK>>>');
    }

    // Check if SEARCH/REPLACE markers exist OUTSIDE of fenced blocks
    const unfencedHasSearch = /<<<{3,}\s*SEARCH/i.test(contentWithoutFencedBlocks);
    const unfencedHasReplace = />>>{3,}\s*REPLACE/i.test(contentWithoutFencedBlocks);

    if (!unfencedHasSearch || !unfencedHasReplace) {
      logger.info(`[ChatProvider] All SEARCH/REPLACE blocks are inside code fences (already processed)`);
      return;
    }

    logger.info(`[ChatProvider] Found UNFENCED SEARCH/REPLACE blocks - attempting fallback processing`);

    // Extract just the unfenced portion for parsing
    // Look for # File: header followed by SEARCH/REPLACE block
    const unfencedEditRegex = /#\s*File:\s*(.+?)(?:\n|\r\n)([\s\S]*?<<<{3,}\s*SEARCH[\s\S]*?>>>{3,}\s*REPLACE)/gi;
    const unfencedMatches = [...contentWithoutFencedBlocks.matchAll(unfencedEditRegex)];

    if (unfencedMatches.length > 0) {
      // Found unfenced edits with file headers - process them
      for (const editMatch of unfencedMatches) {
        const filePath = editMatch[1].trim();
        const codeBlock = editMatch[2];

        logger.info(`[ChatProvider] Processing unfenced edit for: ${filePath}`);

        // Create a code block with the header for processing
        const codeWithHeader = `# File: ${filePath}\n${codeBlock}`;

        // Create a unique ID to avoid reprocessing
        const blockId = `unfenced-${filePath}-${codeBlock.length}`;
        if (this.processedCodeBlocks.has(blockId)) {
          logger.info(`[ChatProvider] Skipping already processed unfenced block: ${blockId}`);
          continue;
        }
        this.processedCodeBlocks.add(blockId);

        if (this.editMode === 'ask') {
          this.handleDebouncedDiff(codeWithHeader, 'plaintext');
        } else if (this.editMode === 'auto') {
          await this.applyCodeDirectlyForAutoMode(filePath, codeBlock, 'Auto-applied from unfenced code block');
        }
      }
    } else {
      // SEARCH/REPLACE markers found but no # File: header
      // Send a warning to help the user understand why the edit wasn't applied
      logger.warn(`[ChatProvider] Found SEARCH/REPLACE markers but no # File: header - cannot auto-process`);

      this._view?.webview.postMessage({
        type: 'warning',
        message: 'Code edit detected but missing file path. The response contains SEARCH/REPLACE format but no "# File:" header to identify which file to edit.'
      });
    }
  }

  private async handleAutoShowDiff(code: string, language: string) {
    try {
      logger.info(`[ChatProvider] Starting auto-show diff (language: ${language}, editMode: ${this.editMode})`);

      // Layer 1: Extract explicit file path from code (# File: header)
      logger.info(`[FileResolver] Strategy 0: Checking # File: header in code...`);
      const filePathMatch = code.match(/^#\s*File:\s*(.+?)$/m);
      let filePath = filePathMatch ? filePathMatch[1].trim() : null;

      if (filePath) {
        logger.info(`[FileResolver] ✓ Strategy 0 SUCCESS: Found # File: header "${filePath}"`);
      } else {
        logger.warn(`[FileResolver] ✗ Strategy 0 FAILED: No # File: header found`);

        // Layer 2-6: Use multi-layer resolution (inference + interactive fallback)
        filePath = await this.resolveFilePath(code, language);

        if (filePath) {
          // Inject the resolved file path into the code
          code = `# File: ${filePath}\n${code}`;
          logger.info(`[ChatProvider] Injected inferred file path: ${filePath}`);
        } else {
          logger.error(`[ChatProvider] Could not determine target file - skipping auto-diff`);
          vscode.window.showWarningMessage(
            'Could not determine which file to edit. Please add a "# File: path" comment to the code block.'
          );
          return;
        }
      }

      // Auto-show the diff
      logger.info(`[ChatProvider] Opening diff editor for file: ${filePath}`);
      await this.showDiff(code, language);

      // Send confirmation request to frontend (for ask mode)
      this._view?.webview.postMessage({
        type: 'showEditConfirm',
        filePath,
        code,
        language
      });

      logger.info(`[ChatProvider] ✓ Auto-showed diff for "${filePath}" in ask mode`);
    } catch (error: any) {
      logger.error('[ChatProvider] Failed to auto-show diff:', error.message);
      vscode.window.showErrorMessage(`Failed to show diff: ${error.message}`);
    }
  }

  /**
   * Extract file intent from user's message
   * Returns file path if user explicitly mentioned a file to edit
   */
  private extractFileIntent(message: string): string | null {
    const patterns = [
      // "update the changelog" -> CHANGELOG.md
      { regex: /(?:update|edit|modify|change|fix)\s+(?:the\s+)?(changelog)/i, file: 'CHANGELOG.md' },
      { regex: /(?:update|edit|modify|change|fix)\s+(?:the\s+)?(readme)/i, file: 'README.md' },
      { regex: /(?:update|edit|modify|change|fix)\s+(?:the\s+)?(package\.json|package)/i, file: 'package.json' },

      // "edit src/utils/helper.ts" - captures full path
      { regex: /(?:update|edit|modify|change|fix)\s+(\S+\.\w+)/i, file: '$1' }
    ];

    for (const { regex, file } of patterns) {
      const match = message.match(regex);
      if (match) {
        const resolved = file.startsWith('$') ? match[1] : file;
        logger.info(`[FileResolver] Extracted file intent from message: "${resolved}"`);
        return resolved;
      }
    }

    return null;
  }

  /**
   * Infer file path from context when # File: header is missing
   * Uses multiple strategies with detailed logging
   */
  private inferFilePath(code: string, language: string): string | null {
    logger.info(`[FileResolver] Starting file path inference (language: ${language})`);

    // Strategy 1: Check user's message intent
    logger.info(`[FileResolver] Strategy 1: Checking user message intent...`);
    if (this.userMessageIntent) {
      logger.info(`[FileResolver] ✓ Strategy 1 SUCCESS: Using file intent "${this.userMessageIntent}"`);
      return this.userMessageIntent;
    } else {
      logger.warn(`[FileResolver] ✗ Strategy 1 FAILED: No user intent extracted`);
    }

    // Strategy 2: Check selected files
    logger.info(`[FileResolver] Strategy 2: Checking selected files (${this.selectedFiles.size} selected)...`);
    if (this.selectedFiles.size === 1) {
      const file = Array.from(this.selectedFiles.keys())[0];
      logger.info(`[FileResolver] ✓ Strategy 2 SUCCESS: Single selected file "${file}"`);
      return file;
    } else if (this.selectedFiles.size > 1) {
      logger.warn(`[FileResolver] ✗ Strategy 2 FAILED: Multiple files selected (${this.selectedFiles.size})`);
    } else {
      logger.warn(`[FileResolver] ✗ Strategy 2 FAILED: No files selected`);
    }

    // Strategy 3: Check read files - single file rule
    logger.info(`[FileResolver] Strategy 3: Checking read files (${this.readFilesInTurn.size} read)...`);
    if (this.readFilesInTurn.size === 1) {
      const file = Array.from(this.readFilesInTurn)[0];
      logger.info(`[FileResolver] ✓ Strategy 3 SUCCESS: Single read file "${file}"`);
      return file;
    } else if (this.readFilesInTurn.size > 1) {
      logger.warn(`[FileResolver] ✗ Strategy 3 FAILED: Multiple files read (${this.readFilesInTurn.size})`);
    } else {
      logger.warn(`[FileResolver] ✗ Strategy 3 FAILED: No files read`);
    }

    // Strategy 4: Match by language/extension
    logger.info(`[FileResolver] Strategy 4: Matching by extension for language "${language}"...`);
    const extMap: Record<string, string[]> = {
      markdown: ['.md'],
      typescript: ['.ts', '.tsx'],
      javascript: ['.js', '.jsx'],
      python: ['.py'],
      json: ['.json'],
      css: ['.css'],
      html: ['.html']
    };

    const extensions = extMap[language] || [];
    if (extensions.length > 0) {
      // Check selected files first
      if (this.selectedFiles.size > 0) {
        for (const file of this.selectedFiles.keys()) {
          if (extensions.some(ext => file.endsWith(ext))) {
            logger.info(`[FileResolver] ✓ Strategy 4 SUCCESS: Matched selected file by extension "${file}"`);
            return file;
          }
        }
      }

      // Then check read files
      if (this.readFilesInTurn.size > 0) {
        for (const file of this.readFilesInTurn) {
          if (extensions.some(ext => file.endsWith(ext))) {
            logger.info(`[FileResolver] ✓ Strategy 4 SUCCESS: Matched read file by extension "${file}"`);
            return file;
          }
        }
      }

      logger.warn(`[FileResolver] ✗ Strategy 4 FAILED: No files match extensions ${extensions.join(', ')}`);
    } else {
      logger.warn(`[FileResolver] ✗ Strategy 4 FAILED: Unknown language "${language}"`);
    }

    logger.warn(`[FileResolver] All inference strategies failed`);
    return null;
  }

  /**
   * Resolve file path using inference + interactive fallback
   * Returns null if unable to determine file
   */
  private async resolveFilePath(code: string, language: string): Promise<string | null> {
    // Try inference first
    const inferred = this.inferFilePath(code, language);
    if (inferred) {
      return inferred;
    }

    // Strategy 5: Interactive quick picker as last resort
    logger.info(`[FileResolver] Strategy 5: Showing interactive quick picker...`);
    const availableFiles = Array.from(new Set([
      ...this.selectedFiles.keys(),
      ...this.readFilesInTurn
    ]));

    if (availableFiles.length > 1) {
      const selected = await vscode.window.showQuickPick(availableFiles, {
        placeHolder: 'Which file should these changes apply to?',
        title: 'Select target file for code changes'
      });

      if (selected) {
        logger.info(`[FileResolver] ✓ Strategy 5 SUCCESS: User selected "${selected}"`);
        return selected;
      } else {
        logger.warn(`[FileResolver] ✗ Strategy 5 FAILED: User cancelled selection`);
      }
    } else {
      logger.warn(`[FileResolver] ✗ Strategy 5 FAILED: No available files to choose from`);
    }

    // Fallback: Use active editor if nothing else works
    logger.info(`[FileResolver] Strategy 6 (Fallback): Using active editor...`);
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      const relativePath = vscode.workspace.asRelativePath(editor.document.uri);
      logger.info(`[FileResolver] ✓ Strategy 6 SUCCESS: Active editor "${relativePath}"`);
      return relativePath;
    } else {
      logger.warn(`[FileResolver] ✗ Strategy 6 FAILED: No active editor`);
    }

    logger.error(`[FileResolver] COMPLETE FAILURE: Unable to determine target file`);
    return null;
  }

  private async closeDiff() {
    // Close all diff editors (delegates to closeDiffEditor which handles activeDiffs)
    await this.closeDiffEditor();
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

  private sendCodeAppliedStatus(success: boolean, error?: string, filePath?: string) {
    logger.codeApplied(success, filePath);
    if (this._view) {
      this._view.webview.postMessage({
        type: 'codeApplied',
        success,
        error,
        filePath
      });
    }
  }

  private async loadCurrentSessionHistory() {
    const currentSession = await this.conversationManager.getCurrentSession();
    if (!currentSession || !this._view) return;

    const messages = await this.conversationManager.getSessionMessagesCompat(currentSession.id);
    if (messages.length > 0) {
      // Notify webview of loaded session (for SessionActor)
      this._view.webview.postMessage({
        type: 'sessionLoaded',
        sessionId: currentSession.id,
        title: currentSession.title,
        model: this.deepSeekClient.getModel()
      });

      this._view.webview.postMessage({
        type: 'loadHistory',
        history: messages.map((msg: { role: string; content: string }) => ({
          role: msg.role,
          content: msg.content
        }))
      });
    }
  }

  public async loadSession(sessionId: string) {
    const session = await this.conversationManager.getSession(sessionId);
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
      const messages = await this.conversationManager.getSessionMessagesCompat(sessionId);
      this._view.webview.postMessage({
        type: 'loadHistory',
        history: messages.map((msg: { role: string; content: string }) => ({
          role: msg.role,
          content: msg.content
        }))
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