import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { DeepSeekClient, Message as ApiMessage, ToolCall } from '../deepseekClient';
import { StatusBar } from '../views/statusBar';
import { ChatHistoryManager } from '../chatHistory/ChatHistoryManager';
import { DiffEngine } from '../utils/diff';
import { logger } from '../utils/logger';
import { workspaceTools, applyCodeEditTool, executeToolCall } from '../tools/workspaceTools';
import { parseDSMLToolCalls, stripDSML } from '../utils/dsmlParser';
import { TavilyClient, TavilySearchResponse } from '../clients/tavilyClient';

interface DiffMetadata {
  proposedUri: vscode.Uri;        // The "modified" side of the diff
  originalUri: vscode.Uri;        // The "original" side of the diff
  targetFilePath: string;         // Actual file path (e.g., "src/file.ts")
  code: string;                   // Full code including "# File:" header
  language: string;               // Language identifier
  timestamp: number;              // When this diff was created
  iteration: number;              // Edit iteration number (1, 2, 3, etc.)
  diffId: string;                 // Unique ID for this specific diff
}

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
  private activeDiffs: Map<string, DiffMetadata> = new Map();
  private resolvedDiffs: Array<{ filePath: string; timestamp: number; status: 'applied' | 'rejected'; iteration: number; diffId: string }> = [];
  private autoAppliedFiles: Array<{ filePath: string; timestamp: number; description?: string }> = [];
  private diffTabGroupId: number | null = null;
  private diffStatusBarItem: vscode.StatusBarItem;
  private disposables: vscode.Disposable[] = [];
  private tavilyClient: TavilyClient;
  private webSearchEnabled: boolean = false;
  private webSearchSettings: { searchesPerPrompt: number; searchDepth: 'basic' | 'advanced' } = {
    searchesPerPrompt: 1,
    searchDepth: 'basic'
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
  private closingDiffIntentionally: string | null = null; // diffId being closed

  // File tracking state
  private selectedFiles = new Map<string, string>(); // path → content (user-selected files)
  private readFilesInTurn = new Set<string>(); // Track ALL files read by LLM during conversation turn
  private userMessageIntent: string | null = null; // Extracted file intent from user message
  private fileModalOpen = false; // Track whether file selection modal is open

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
            // If we're intentionally closing a diff, ignore ALL close events
            // We handle removal manually in closeSingleDiff to avoid race conditions
            // (VS Code fires close events for documents we're programmatically closing)
            if (this.closingDiffIntentionally) {
              logger.info(`[OVERLAY-DEBUG] Ignoring close for ${metadata.targetFilePath} - intentional close in progress (${this.closingDiffIntentionally})`);
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

    // Combine pending diffs with resolved diffs
    const pendingDiffs = Array.from(this.activeDiffs.values()).map(meta => ({
      filePath: meta.targetFilePath,
      timestamp: meta.timestamp,
      status: 'pending' as const,
      proposedUri: meta.proposedUri.toString(),
      iteration: meta.iteration,
      diffId: meta.diffId
    }));

    const resolvedDiffsList = this.resolvedDiffs.map(d => ({
      filePath: d.filePath,
      timestamp: d.timestamp,
      status: d.status,
      iteration: d.iteration,
      diffId: d.diffId
    }));

    // Combine and sort by timestamp
    const allDiffs = [...pendingDiffs, ...resolvedDiffsList]
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

    // Clear auto-applied files list for new conversation
    this.autoAppliedFiles = [];

    // Clear resolved diffs list for new conversation
    this.resolvedDiffs = [];

    // Clear file edit counts for new conversation
    this.fileEditCounts.clear();

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
      // Set model immediately on client (VS Code config has propagation delay)
      this.deepSeekClient.setModel(settings.model);
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
    const editMode = config.get<string>('editMode') || 'manual';

    // Sync internal state with config
    this.editMode = editMode as 'manual' | 'ask' | 'auto';

    if (this._view) {
      this._view.webview.postMessage({
        type: 'settings',
        model,
        temperature,
        maxToolCalls
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

**CRITICAL: File Path Requirement**
You MUST include a file path comment as the FIRST LINE of EVERY code block using this EXACT format:

# File: path/to/file.ext

Examples:
\`\`\`markdown
# File: CHANGELOG.md
## Version 2.0.0
- New features
\`\`\`

\`\`\`typescript
# File: src/providers/chatProvider.ts
export function helper() {
  return "updated";
}
\`\`\`

This is MANDATORY. Code blocks without file paths at the first line cannot be applied correctly.

**For EDITING existing code**, output a SINGLE code block with SEARCH/REPLACE format:

\`\`\`
<<<<<<< SEARCH
def example(x)
  return x + 1
end
=======
def example(x)
  return x * 2
end
>>>>>>> REPLACE
\`\`\`

CRITICAL RULES:
1. The <<<<<<< SEARCH, =======, and >>>>>>> REPLACE markers MUST be INSIDE the code block
2. Output ONE code block containing the entire search/replace - NOT separate "before" and "after" blocks
3. Copy the EXACT code from the file for the SEARCH section (including whitespace and comments)
4. Do NOT explain the change outside the code block - put everything in ONE code block
5. The user clicks "Apply" on the code block and it automatically replaces the matching code

**For ADDING new code** (new functions, methods), include surrounding context:
\`\`\`
  def existing_method
    # existing code
  end

  def new_method_i_am_adding
    # new code here
  end

  def another_existing_method
\`\`\`

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

    // Clear file changes tracking for this response
    this.currentResponseFileChanges = [];

    // Create abort controller for this request
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    this._view.webview.postMessage({
      type: 'startResponse',
      isReasoner: isReasonerModel
    });

    // Log the API request
    const model = this.deepSeekClient.getModel();
    const hasAttachments = attachments && attachments.length > 0;
    const requestStartTime = Date.now();

    // Declare outside try so it's accessible in catch for partial save
    let toolCallsForHistory: Array<{ name: string; detail: string; status: string }> = [];

    try {
      // Get current session messages for context (user message already saved above)
      const currentSession = await this.chatHistoryManager.getCurrentSession();
      const messageCount = currentSession ? currentSession.messages.length : 1;
      logger.apiRequest(model, messageCount, hasAttachments);

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

      const _response = await this.deepSeekClient.streamChat(
        historyMessages,
        async (token) => {
          fullResponse += token;
          this._view?.webview.postMessage({
            type: 'streamToken',
            token
          });

          // Detect complete code blocks and auto-show diff in "ask" mode
          if (this.editMode === 'ask') {
            const codeBlockRegex = /```(\w+)?\n([\s\S]*?)\n```/g;
            const matches = [...fullResponse.matchAll(codeBlockRegex)];

            for (const match of matches) {
              const language = match[1] || 'plaintext';
              const code = match[2];

              // Skip tool outputs
              if (language === 'tool-output') {
                continue;
              }

              // IMPORTANT: Only auto-show diff if code has explicit # File: header
              // This prevents false positives when LLM shows explanatory code
              const hasFileHeader = /^#\s*File:\s*(.+?)$/m.test(code);
              if (!hasFileHeader) {
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

              // Use debounced diff display (waits 2.5s to batch rapid LLM iterations)
              this.handleDebouncedDiff(code, language);
            }
          }
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
          toolCalls: toolCallsForHistory.length > 0 ? toolCallsForHistory : undefined,
          fileChanges: this.currentResponseFileChanges.length > 0 ? this.currentResponseFileChanges : undefined,
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
        // Save partial response to history if there's content
        if (this.currentSessionId && (fullResponse || fullReasoning)) {
          const cleanPartialResponse = stripDSML(fullResponse);
          const partialTokenCount = this.deepSeekClient.estimateTokens(cleanPartialResponse + fullReasoning);
          await this.chatHistoryManager.addMessageToCurrentSession({
            role: 'assistant',
            content: cleanPartialResponse + '\n\n*[Generation stopped]*',
            reasoning_content: fullReasoning || undefined,
            toolCalls: toolCallsForHistory.length > 0 ? toolCallsForHistory : undefined,
            fileChanges: this.currentResponseFileChanges.length > 0 ? this.currentResponseFileChanges : undefined,
            tokens: partialTokenCount
          });
          logger.info(`[ChatProvider] Saved partial response to history (${partialTokenCount} tokens)`);
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
                  // In auto mode, apply code directly
                  await this.applyCodeDirectlyForAutoMode(args.file, args.code, args.description);
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

  private async closeSingleDiff(metadata: DiffMetadata) {
    // Set flag to prevent onDidCloseTextDocument from removing OTHER diffs
    this.closingDiffIntentionally = metadata.diffId;

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
      // Clear flag after a small delay to allow document close events to settle
      setTimeout(() => {
        this.closingDiffIntentionally = null;
      }, 100);
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

    if (metadata) {
      logger.info(`[ChatProvider] Accepting specific diff: ${diffId} (${metadata.targetFilePath})`);
      // Track as resolved BEFORE applying (which removes from activeDiffs)
      this.resolvedDiffs.push({
        filePath: metadata.targetFilePath,
        timestamp: metadata.timestamp,
        status: 'applied',
        iteration: metadata.iteration,
        diffId: metadata.diffId
      });
      // Update status in current response file changes for history
      this.updateFileChangeStatus(metadata.targetFilePath, metadata.iteration, 'applied');
      await this.applyCode(metadata.code, metadata.language);
    } else {
      logger.warn(`[ChatProvider] No diff found for diffId: ${diffId}`);
    }
  }

  private async rejectSpecificDiff(diffId: string) {
    const metadata = Array.from(this.activeDiffs.values())
      .find(m => m.diffId === diffId);

    if (metadata) {
      logger.info(`[ChatProvider] Rejecting specific diff: ${diffId} (${metadata.targetFilePath})`);
      // Track as resolved BEFORE closing (which removes from activeDiffs)
      this.resolvedDiffs.push({
        filePath: metadata.targetFilePath,
        timestamp: metadata.timestamp,
        status: 'rejected',
        iteration: metadata.iteration,
        diffId: metadata.diffId
      });
      // Update status in current response file changes for history
      this.updateFileChangeStatus(metadata.targetFilePath, metadata.iteration, 'rejected');
      await this.closeSingleDiff(metadata);
    } else {
      logger.warn(`[ChatProvider] No diff found for diffId: ${diffId}`);
    }
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
   */
  private async applyCodeDirectlyForAutoMode(filePath: string, code: string, description?: string) {
    try {
      // Find the file in the workspace
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders || workspaceFolders.length === 0) {
        throw new Error('No workspace folder open');
      }

      // Try to find the file
      let fileUri: vscode.Uri | undefined;
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

      if (!fileUri) {
        logger.warn(`[ChatProvider] Auto mode: File not found: ${filePath}`);
        return;
      }

      // Read current content
      const document = await vscode.workspace.openTextDocument(fileUri);
      const currentContent = document.getText();

      // Apply changes using DiffEngine
      const result = this.diffEngine.applyChanges(currentContent, code);

      if (!result.success) {
        logger.warn(`[ChatProvider] Auto mode: Diff application had issues for ${filePath}: ${result.message}`);
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

      // Notify frontend
      this.notifyAutoAppliedFilesChanged();
      this.sendCodeAppliedStatus(true);

    } catch (error: any) {
      logger.error(`[ChatProvider] Auto mode: Failed to apply code to ${filePath}:`, error.message);
      this.sendCodeAppliedStatus(false, error.message);
    }
  }

  /**
   * Notify frontend of auto-applied files list change
   */
  private notifyAutoAppliedFilesChanged() {
    if (!this._view) return;

    this._view.webview.postMessage({
      type: 'diffListChanged',
      diffs: this.autoAppliedFiles.map(f => ({
        filePath: f.filePath,
        timestamp: f.timestamp,
        status: 'applied'
      })),
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
          vscode.window.showWarningMessage(`File not found in workspace: ${targetFilePath}`);
          return;
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

      // Track this diff in the Map
      const metadata: DiffMetadata = {
        proposedUri,
        originalUri,
        targetFilePath: targetPath,
        code,
        language,
        timestamp,
        iteration,
        diffId
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
          reasoning_content: msg.reasoning_content,
          toolCalls: msg.toolCalls,
          fileChanges: msg.fileChanges
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
          reasoning_content: msg.reasoning_content,
          toolCalls: msg.toolCalls,
          fileChanges: msg.fileChanges
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
                    <span class="tool-limit-hint">Controls randomness in responses. 0 = deterministic, 2 = very creative</span>
                  </div>
                  <div id="toolLimitControl" class="temperature-control" style="display: block;">
                    <label>Tool Iterations: <span id="toolLimitValue">25</span></label>
                    <input type="range" id="toolLimitSlider" min="5" max="100" step="5" value="25">
                    <span class="tool-limit-hint">Limits tool calling loops (each loop can have multiple tools). 100 = No limit</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div id="chatMessages" class="chat-messages"></div>

          <div class="input-area">
            <div class="input-row">
              <div class="input-buttons-grid">
                <!-- Row 1: Files + Edit Mode -->
                <button id="filesBtn" class="grid-btn files-btn" title="Select files for context">
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M14.5 2h-6L7 .5 1.5 1v13l.5.5h12l.5-.5v-12l-.5-.5zM14 14H2V2h4.5l1.5 1.5h6V14z"/>
                  </svg>
                  <!-- Keep water spurt CSS for future use (not triggered) -->
                  <div class="water-spurt">
                    <div class="droplet"></div>
                    <div class="droplet"></div>
                    <div class="droplet"></div>
                    <div class="droplet"></div>
                    <div class="droplet"></div>
                  </div>
                </button>
                <button id="editModeBtn" class="grid-btn edit-mode-btn" title="Edit mode: Manual">
                  <svg id="editModeIcon" width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                    <!-- Letter "M" for Manual mode -->
                    <text x="8" y="11" font-size="10" font-weight="bold" text-anchor="middle" fill="currentColor">M</text>
                  </svg>
                </button>
                <!-- Row 2: Help + Attach -->
                <button id="helpBtn" class="grid-btn help-btn" title="Commands">
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 13A6 6 0 1 1 8 2a6 6 0 0 1 0 12zm-.5-3h1v1h-1v-1zm.5-7a2.5 2.5 0 0 0-2.5 2.5h1A1.5 1.5 0 1 1 8 8c-.55 0-1 .45-1 1v1h1v-.8c0-.11.09-.2.2-.2h.3a2.5 2.5 0 0 0 0-5z"/>
                  </svg>
                </button>
                <button id="attachBtn" class="grid-btn attach-btn" title="Attach file">
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M4.5 3a2.5 2.5 0 0 1 5 0v9a1.5 1.5 0 0 1-3 0V5a.5.5 0 0 1 1 0v7a.5.5 0 0 0 1 0V3a1.5 1.5 0 1 0-3 0v9a2.5 2.5 0 0 0 5 0V5a.5.5 0 0 1 1 0v7a3.5 3.5 0 1 1-7 0V3z"/>
                  </svg>
                </button>
                <button id="searchBtn" class="grid-btn search-btn" title="Web search">
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
              <div class="input-textarea-wrapper">
                <textarea
                  id="messageInput"
                  placeholder="Seek deep..."
                  rows="1"
                ></textarea>
                <!-- Status Panel - Messages, Warnings, Errors -->
                <div class="status-panel">
                  <div class="status-panel-moby" id="statusPanelMoby">
                    <img src="${iconUri}" alt="Moby">
                    <div class="water-spurt">
                      <div class="droplet"></div>
                      <div class="droplet"></div>
                      <div class="droplet"></div>
                      <div class="droplet"></div>
                      <div class="droplet"></div>
                    </div>
                  </div>
                  <div class="status-panel-left">
                    <div class="status-panel-messages" id="statusPanelMessages"></div>
                  </div>
                  <!-- Resizable separator -->
                  <div class="status-panel-separator" id="statusPanelSeparator"></div>
                  <div class="status-panel-right">
                    <div class="status-panel-warnings" id="statusPanelWarnings"></div>
                    <button class="status-panel-logs-btn" id="statusPanelLogsBtn" title="Show Logs">
                      <svg viewBox="0 0 16 16" fill="currentColor">
                        <path d="M3 3h10v1H3V3zm0 3h10v1H3V6zm0 3h7v1H3V9zm0 3h10v1H3v-1z"/>
                      </svg>
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <!-- File chips - show selected files for context -->
            <div id="fileChipsContainer" class="file-chips-container" style="display: none;">
              <span class="file-chips-label">Context:</span>
              <div id="fileChips"></div>
            </div>
            <input type="file" id="fileInput" accept=".js,.ts,.jsx,.tsx,.py,.java,.go,.rs,.cpp,.c,.h,.cs,.rb,.php,.swift,.kt,.scala,.vue,.svelte,.json,.yaml,.yml,.toml,.xml,.env,.ini,.conf,.md,.txt,.rst,.log,.html,.css,.scss,.less,.sh,.bash,.zsh,.sql,.graphql,.proto" style="display: none" multiple>
            <div id="attachments" class="attachments"></div>
          </div>
        </div>

        <!-- File selection modal -->
        <div id="fileModalOverlay" class="file-modal-overlay" style="display: none;">
          <div class="file-modal">
            <div class="file-modal-header">
              <h3 class="file-modal-title">Select Files for Context</h3>
              <button id="fileModalClose" class="file-modal-close">&times;</button>
            </div>
            <div class="file-modal-body">
              <!-- Open files section -->
              <div class="file-section">
                <div class="file-section-header">Open Files (<span id="openFilesCount">0</span>)</div>
                <div id="openFilesList" class="open-files-list">
                  <div class="file-search-no-results">No files currently open</div>
                </div>
              </div>

              <!-- Search section -->
              <div class="file-section">
                <div class="file-section-header">Search Files</div>
                <input
                  type="text"
                  id="fileSearchInput"
                  class="file-search-input"
                  placeholder="🔍 Type to search files. Searching is case sensitive"
                />
                <div id="fileSearchResults" class="file-search-results" style="display: none;">
                  <!-- Search results will be inserted here -->
                </div>
              </div>

              <!-- Selected files section -->
              <div class="file-section">
                <div class="selected-files-header">
                  <div class="file-section-header">Selected Files (<span id="selectedFilesCount">0</span>)</div>
                  <button id="clearSelectedBtn" class="selected-files-clear" style="display: none;">Clear All</button>
                </div>
                <div id="selectedFilesList" class="selected-files-list">
                  <div class="selected-files-empty">No files selected</div>
                </div>
              </div>
            </div>
            <div class="file-modal-footer">
              <button id="fileModalCancel" class="file-modal-btn file-modal-btn-cancel">Cancel</button>
              <button id="fileModalAdd" class="file-modal-btn file-modal-btn-add" disabled>Add to Context</button>
            </div>
          </div>
        </div>

        <script src="${scriptUri}"></script>
      </body>
      </html>
    `;
  }
}