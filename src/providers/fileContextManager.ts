/**
 * FileContextManager — Owns file selection, search, and context injection.
 *
 * Extracted from ChatProvider (Phase 2 of ChatProvider refactor).
 * Communicates via vscode.EventEmitter — ChatProvider subscribes to events
 * and forwards them to the webview via postMessage.
 */

import * as vscode from 'vscode';
import { logger } from '../utils/logger';
import { OpenFilesEvent, FileSearchResultsEvent, FileContentEvent } from './types';

export class FileContextManager {
  // ── Events ──

  private readonly _onOpenFiles = new vscode.EventEmitter<OpenFilesEvent>();
  private readonly _onSearchResults = new vscode.EventEmitter<FileSearchResultsEvent>();
  private readonly _onFileContent = new vscode.EventEmitter<FileContentEvent>();

  readonly onOpenFiles = this._onOpenFiles.event;
  readonly onSearchResults = this._onSearchResults.event;
  readonly onFileContent = this._onFileContent.event;

  // ── State ──

  private selectedFiles = new Map<string, string>(); // path → content
  private readFilesInTurn = new Set<string>(); // Files read by LLM during current turn
  private userMessageIntent: string | null = null; // Extracted file intent from user message
  private fileModalOpen = false; // Whether file selection modal is open

  // ── Public Methods ──

  /**
   * Set modal open state. When open, new file openings trigger a refresh.
   */
  setModalOpen(open: boolean): void {
    this.fileModalOpen = open;
    logger.info(`[FileContext] File modal ${open ? 'opened' : 'closed'} - live updates ${open ? 'enabled' : 'disabled'}`);
  }

  /**
   * Whether the file modal is currently open (used by document open listener).
   */
  get isModalOpen(): boolean {
    return this.fileModalOpen;
  }

  /**
   * Scan all open editor tabs and emit the file list.
   */
  sendOpenFiles(): void {
    const openFiles: string[] = [];
    const allUris = new Set<string>();

    const tabGroups = vscode.window.tabGroups.all;
    logger.info(`[FileContext] Scanning ${tabGroups.length} tab groups for open files`);

    for (const group of tabGroups) {
      for (const tab of group.tabs) {
        if (tab.input instanceof vscode.TabInputText) {
          const uri = tab.input.uri;
          allUris.add(uri.toString());
        }
      }
    }

    for (const uriString of allUris) {
      const uri = vscode.Uri.parse(uriString);
      const relativePath = vscode.workspace.asRelativePath(uri);

      const validSchemes = ['file', 'vscode-remote'];
      if (!validSchemes.includes(uri.scheme)) {
        continue;
      }

      if (relativePath.startsWith('extension-output-') ||
          relativePath.includes('[')) {
        continue;
      }

      openFiles.push(relativePath);
    }

    logger.info(`[FileContext] Sending ${openFiles.length} open files (from ${allUris.size} tabs)`);
    this._onOpenFiles.fire({ files: openFiles });
  }

  /**
   * Search workspace files by query and emit results.
   */
  async handleFileSearch(query: string): Promise<void> {
    logger.info(`[FileContext] File search requested: "${query}"`);
    const results: string[] = [];

    try {
      let pattern = query;
      if (!query.includes('*') && !query.includes('?')) {
        pattern = `**/*${query}*`;
      }

      logger.info(`[FileContext] Searching with pattern: "${pattern}"`);

      const files = await vscode.workspace.findFiles(
        pattern,
        '**/node_modules/**',
        50
      );

      for (const file of files) {
        const relativePath = vscode.workspace.asRelativePath(file);
        results.push(relativePath);
        logger.info(`[FileContext] Found file: ${relativePath}`);
      }

      logger.info(`[FileContext] File search for "${query}" returned ${results.length} results`);
    } catch (error: any) {
      logger.error(`[FileContext] File search error: ${error.message}`);
    }

    this._onSearchResults.fire({ results });
  }

  /**
   * Read a file's content and emit it.
   */
  async sendFileContent(filePath: string): Promise<void> {
    try {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        logger.error('[FileContext] No workspace folder found');
        return;
      }

      const absolutePath = vscode.Uri.joinPath(workspaceFolder.uri, filePath);
      const content = await vscode.workspace.fs.readFile(absolutePath);
      const textContent = Buffer.from(content).toString('utf8');

      logger.info(`[FileContext] Sending file content for: ${filePath} (${textContent.length} chars)`);
      this._onFileContent.fire({ filePath, content: textContent });
    } catch (error: any) {
      logger.error(`[FileContext] Error reading file ${filePath}: ${error.message}`);
      vscode.window.showErrorMessage(`Failed to read file: ${filePath}`);
    }
  }

  /**
   * Update selected files from the file modal.
   */
  setSelectedFiles(files: Array<{ path: string; content: string }>): void {
    this.selectedFiles.clear();

    for (const file of files) {
      this.selectedFiles.set(file.path, file.content);
    }

    logger.info(`[FileContext] Updated selected files: ${this.selectedFiles.size} files`);
    for (const path of this.selectedFiles.keys()) {
      logger.info(`[FileContext]   - ${path}`);
    }
  }

  /**
   * Clear per-turn tracking state. Called at the start of each user message.
   */
  clearTurnTracking(): void {
    this.readFilesInTurn.clear();
  }

  /**
   * Extract and store file intent from the user's message.
   */
  extractFileIntent(message: string): void {
    this.userMessageIntent = this._extractFileIntent(message);
  }

  /**
   * Track a file read by the LLM tool loop (read_file or apply_code_edit).
   */
  trackReadFile(filePath: string): void {
    this.readFilesInTurn.add(filePath);
    logger.info(`[FileContext] Tracked read file: ${filePath} (total: ${this.readFilesInTurn.size})`);
  }

  /**
   * Get the number of currently selected files.
   */
  get selectedFileCount(): number {
    return this.selectedFiles.size;
  }

  /**
   * Get the number of files read during this turn.
   */
  get readFileCount(): number {
    return this.readFilesInTurn.size;
  }

  /**
   * Build the selected files context string for injection into the user message.
   * Returns empty string if no files are selected.
   */
  getSelectedFilesContext(): string {
    if (this.selectedFiles.size === 0) {
      return '';
    }

    let context = '\n\n--- Selected Files for Context ---\n';
    logger.info(`[FileContext] Injecting ${this.selectedFiles.size} selected files into context`);

    for (const [filePath, content] of this.selectedFiles.entries()) {
      context += `\n### File: ${filePath}\n\`\`\`\n${content}\n\`\`\`\n`;
      logger.info(`[FileContext] ✓ Added selected file to context: ${filePath} (${content.length} chars)`);
    }
    context += '--- End Selected Files ---\n';

    return context;
  }

  /**
   * Infer file path from context when # File: header is missing.
   * Uses multiple strategies with detailed logging.
   */
  inferFilePath(code: string, language: string): string | null {
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
      if (this.selectedFiles.size > 0) {
        for (const file of this.selectedFiles.keys()) {
          if (extensions.some(ext => file.endsWith(ext))) {
            logger.info(`[FileResolver] ✓ Strategy 4 SUCCESS: Matched selected file by extension "${file}"`);
            return file;
          }
        }
      }

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
   * Resolve file path using inference + interactive quick picker fallback.
   * Returns null if unable to determine file.
   */
  async resolveFilePath(code: string, language: string): Promise<string | null> {
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

  // ── Private Methods ──

  /**
   * Extract file intent from user's message.
   * Returns file path if user explicitly mentioned a file to edit.
   */
  private _extractFileIntent(message: string): string | null {
    const patterns = [
      { regex: /(?:update|edit|modify|change|fix)\s+(?:the\s+)?(changelog)/i, file: 'CHANGELOG.md' },
      { regex: /(?:update|edit|modify|change|fix)\s+(?:the\s+)?(readme)/i, file: 'README.md' },
      { regex: /(?:update|edit|modify|change|fix)\s+(?:the\s+)?(package\.json|package)/i, file: 'package.json' },
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

  dispose(): void {
    this._onOpenFiles.dispose();
    this._onSearchResults.dispose();
    this._onFileContent.dispose();
  }
}
