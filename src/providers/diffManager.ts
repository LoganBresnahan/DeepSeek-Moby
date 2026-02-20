/**
 * DiffManager — Owns diff lifecycle, code application, tab management, and status bar.
 *
 * Extracted from ChatProvider (Phase 3 of ChatProvider refactor).
 * Communicates via vscode.EventEmitter — ChatProvider subscribes to events
 * and forwards them to the webview via postMessage.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { DiffEngine } from '../utils/diff';
import { logger } from '../utils/logger';
import { DiffMetadata, DiffInfo, DiffListChangedEvent, CodeAppliedEvent, DiffApprovalResult } from './types';
import { FileContextManager } from './fileContextManager';
import { extractCodeBlocks } from '../utils/codeBlocks';

export class DiffManager {
  // ── Events ──

  private readonly _onDiffListChanged = new vscode.EventEmitter<DiffListChangedEvent>();
  private readonly _onAutoAppliedFilesChanged = new vscode.EventEmitter<DiffListChangedEvent>();
  private readonly _onCodeApplied = new vscode.EventEmitter<CodeAppliedEvent>();
  private readonly _onActiveDiffChanged = new vscode.EventEmitter<{ filePath: string }>();
  private readonly _onDiffClosed = new vscode.EventEmitter<void>();
  private readonly _onWarning = new vscode.EventEmitter<{ message: string }>();
  private readonly _onEditConfirm = new vscode.EventEmitter<{ filePath: string; code: string; language: string }>();
  private readonly _onEditRejected = new vscode.EventEmitter<{ filePath: string }>();
  private readonly _onWaitingForApproval = new vscode.EventEmitter<{ filePaths: string[] }>();

  readonly onDiffListChanged = this._onDiffListChanged.event;
  readonly onAutoAppliedFilesChanged = this._onAutoAppliedFilesChanged.event;
  readonly onCodeApplied = this._onCodeApplied.event;
  readonly onActiveDiffChanged = this._onActiveDiffChanged.event;
  readonly onDiffClosed = this._onDiffClosed.event;
  readonly onWarning = this._onWarning.event;
  readonly onEditConfirm = this._onEditConfirm.event;
  readonly onEditRejected = this._onEditRejected.event;
  readonly onWaitingForApproval = this._onWaitingForApproval.event;

  // ── State ──

  private activeDiffs: Map<string, DiffMetadata> = new Map();
  private resolvedDiffs: Array<{ filePath: string; timestamp: number; status: 'applied' | 'rejected'; iteration: number; diffId: string }> = [];
  private _lastNotifiedDiffIndex = 0;
  private autoAppliedFiles: Array<{ filePath: string; timestamp: number; description?: string }> = [];
  private diffTabGroupId: number | null = null;
  private diffStatusBarItem: vscode.StatusBarItem;
  private lastActiveEditorUri: vscode.Uri | null = null;
  private editMode: 'manual' | 'ask' | 'auto';
  private processedCodeBlocks = new Set<string>();
  private pendingDiffs = new Map<string, { code: string; language: string; timer: NodeJS.Timeout }>();
  private fileEditCounts = new Map<string, number>();
  private currentResponseFileChanges: Array<{ filePath: string; status: 'applied' | 'rejected' | 'pending'; iteration: number }> = [];
  private closingDiffsInProgress: number = 0;
  private pendingApprovals = new Map<string, {
    resolve: (result: DiffApprovalResult) => void;
    filePath: string;
  }>();

  private disposables: vscode.Disposable[] = [];
  private flushCallback: (() => void) | null = null;

  // ── Constructor ──

  constructor(
    private diffEngine: DiffEngine,
    private fileContextManager: FileContextManager,
    initialEditMode: 'manual' | 'ask' | 'auto'
  ) {
    this.editMode = initialEditMode;

    // Create status bar item for diff tracking
    this.diffStatusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100
    );
    this.diffStatusBarItem.command = 'deepseek.showDiffQuickPick';
    this.diffStatusBarItem.tooltip = 'Click to review pending diffs';
    this.disposables.push(this.diffStatusBarItem);

    // Track when diff documents are actually closed (tab closed, not just hidden)
    this.disposables.push(
      vscode.workspace.onDidCloseTextDocument((document) => {
        if (document.uri.scheme !== 'deepseek-diff') return;

        logger.debug(`[OVERLAY-DEBUG] Diff document closed: ${document.uri.toString()}`);

        for (const [uriKey, metadata] of this.activeDiffs.entries()) {
          if (metadata.proposedUri.toString() === document.uri.toString() ||
              metadata.originalUri.toString() === document.uri.toString()) {
            if (this.closingDiffsInProgress > 0) {
              logger.debug(`[OVERLAY-DEBUG] Ignoring close for ${metadata.targetFilePath} - ${this.closingDiffsInProgress} intentional close(s) in progress`);
              return;
            }
            logger.debug(`[OVERLAY-DEBUG] Removing diff for ${metadata.targetFilePath} due to manual tab close`);
            this.activeDiffs.delete(uriKey);

            // Resolve pending approval as rejected if one exists (blocking ask mode)
            const pendingApproval = this.pendingApprovals.get(metadata.diffId);
            if (pendingApproval) {
              logger.info(`[DiffManager] Manual tab close resolves pending approval as rejected: ${metadata.diffId}`);
              pendingApproval.resolve({ filePath: metadata.targetFilePath, diffId: metadata.diffId, approved: false });
              this.pendingApprovals.delete(metadata.diffId);
            }

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
        if (!editor) return;

        if (editor.document.uri.scheme === 'deepseek-diff') {
          const uriString = editor.document.uri.toString();

          for (const [key, metadata] of this.activeDiffs.entries()) {
            if (metadata.proposedUri.toString() === uriString ||
                metadata.originalUri.toString() === uriString) {
              this._onActiveDiffChanged.fire({ filePath: metadata.targetFilePath });
              logger.debug(`[DiffManager] Active diff changed to: ${metadata.targetFilePath}`);
              break;
            }
          }
        }
      })
    );
  }

  // ── Public Methods ──

  /**
   * Set the buffer flush callback. Called before emitting diff list events.
   */
  setFlushCallback(fn: () => void): void {
    this.flushCallback = fn;
  }

  /**
   * Get current edit mode.
   */
  get currentEditMode(): 'manual' | 'ask' | 'auto' {
    return this.editMode;
  }

  /**
   * Set edit mode and persist to VS Code config.
   */
  setEditMode(mode: 'manual' | 'ask' | 'auto'): void {
    this.editMode = mode;
    logger.info(`[DiffManager] Edit mode changed to: ${mode}`);
    const config = vscode.workspace.getConfiguration('deepseek');
    config.update('editMode', mode, vscode.ConfigurationTarget.Global);
  }

  /**
   * Reject an edit for a file — close diff without applying.
   */
  async rejectEdit(filePath: string): Promise<void> {
    logger.info(`[DiffManager] Edit rejected for: ${filePath}`);
    await this.closeDiffEditor();
    this._onEditRejected.fire({ filePath });
  }

  // ── Diff Lifecycle ──

  async showDiff(code: string, language: string): Promise<void> {
    const filePathMatch = code.match(/^#\s*File:\s*(.+?)$/m);
    const targetFilePath = filePathMatch ? filePathMatch[1].trim() : null;

    let editor = vscode.window.activeTextEditor;
    let document: vscode.TextDocument | undefined;

    if (targetFilePath) {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (workspaceFolders && workspaceFolders.length > 0) {
        for (const folder of workspaceFolders) {
          const fullPath = vscode.Uri.joinPath(folder.uri, targetFilePath);
          try {
            document = await vscode.workspace.openTextDocument(fullPath);
            this.lastActiveEditorUri = document.uri;
            break;
          } catch (error) {
            continue;
          }
        }

        if (!document) {
          logger.debug(`[DiffManager] File not found, creating new file: ${targetFilePath}`);
          const newFileUri = vscode.Uri.joinPath(workspaceFolders[0].uri, targetFilePath);
          const parentDir = vscode.Uri.joinPath(newFileUri, '..');
          try { await vscode.workspace.fs.createDirectory(parentDir); } catch { /* exists */ }
          await vscode.workspace.fs.writeFile(newFileUri, new Uint8Array());
          document = await vscode.workspace.openTextDocument(newFileUri);
          this.lastActiveEditorUri = document.uri;
          logger.debug(`[DiffManager] Created new file for diff: ${targetFilePath}`);
        }
      } else {
        this._onWarning.fire({ message: 'No workspace folder open' });
        return;
      }
    } else {
      if (!editor || editor.document.uri.scheme !== 'file') {
        if (this.lastActiveEditorUri) {
          const existingDoc = vscode.workspace.textDocuments.find(
            doc => doc.uri.toString() === this.lastActiveEditorUri?.toString()
          );
          if (existingDoc) {
            document = existingDoc;
          } else {
            this._onWarning.fire({ message: 'No active editor to compare with' });
            return;
          }
        } else {
          this._onWarning.fire({ message: 'No active editor to compare with' });
          return;
        }
      } else {
        this.lastActiveEditorUri = editor.document.uri;
        document = editor.document;
      }
    }

    const targetPath = targetFilePath || vscode.workspace.asRelativePath(document.uri);
    const currentCount = this.fileEditCounts.get(targetPath) || 0;
    const iteration = currentCount + 1;
    this.fileEditCounts.set(targetPath, iteration);
    const diffId = `${targetPath}-${Date.now()}-${iteration}`;

    logger.info(`[DiffManager] Creating diff for ${targetPath} (iteration ${iteration})`);

    try {
      const originalContent = document.getText();
      const selection = editor?.selection;
      const cleanCode = code.replace(/^#\s*File:.*\n/i, '');

      let proposedContent: string;
      if (!targetFilePath && selection && !selection.isEmpty && editor) {
        const before = originalContent.substring(0, document.offsetAt(selection.start));
        const after = originalContent.substring(document.offsetAt(selection.end));
        proposedContent = before + cleanCode + after;
      } else {
        const result = this.diffEngine.applyChanges(originalContent, cleanCode);
        proposedContent = result.content;
      }

      const timestamp = Date.now();
      const fileExt = document.fileName.split('.').pop() || 'txt';
      const originalUri = vscode.Uri.parse(`deepseek-diff:original-${timestamp}.${fileExt}`);
      const proposedUri = vscode.Uri.parse(`deepseek-diff:proposed-${timestamp}.${fileExt}`);

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

      const fileName = document.fileName.split('/').pop() || 'file';
      const iterationLabel = iteration > 1 ? ` (${iteration})` : '';
      const diffTitle = `${fileName}${iterationLabel} ↔ With Changes`;

      let diffTabGroup: vscode.TabGroup | undefined;
      if (this.diffTabGroupId !== null) {
        diffTabGroup = vscode.window.tabGroups.all.find(g => g.viewColumn === this.diffTabGroupId);
      }

      if (!diffTabGroup) {
        const rightmostGroup = vscode.window.tabGroups.all
          .reduce((max, g) => (!max || (g.viewColumn ?? 0) > (max.viewColumn ?? 0)) ? g : max,
                  vscode.window.tabGroups.all[0]);
        const newViewColumn = (rightmostGroup?.viewColumn ?? vscode.ViewColumn.One) + 1;

        await vscode.commands.executeCommand('vscode.diff',
          originalUri, proposedUri, diffTitle,
          { viewColumn: newViewColumn, preview: false, preserveFocus: true }
        );
        this.diffTabGroupId = newViewColumn;
        logger.debug(`Created new diff tab group at view column ${newViewColumn}`);
      } else {
        await vscode.commands.executeCommand('vscode.diff',
          originalUri, proposedUri, diffTitle,
          { viewColumn: diffTabGroup.viewColumn, preview: false, preserveFocus: true }
        );
        logger.debug(`Opened new diff tab in existing group at view column ${diffTabGroup.viewColumn}`);
      }

      // Mark existing diffs for same file as superseded
      const supersededDiffs: DiffMetadata[] = [];
      for (const [key, existingMeta] of this.activeDiffs.entries()) {
        if (existingMeta.targetFilePath === targetPath && !existingMeta.superseded) {
          existingMeta.superseded = true;
          supersededDiffs.push(existingMeta);
          logger.debug(`[DiffManager] Marked diff iteration ${existingMeta.iteration} for ${targetPath} as superseded`);
        }
      }

      const metadata: DiffMetadata = {
        proposedUri, originalUri, targetFilePath: targetPath,
        code, language, timestamp, iteration, diffId, superseded: false
      };

      this.activeDiffs.set(proposedUri.toString(), metadata);
      logger.diffShown(fileName);

      this.currentResponseFileChanges.push({ filePath: targetPath, status: 'pending', iteration });
      this.updateDiffStatusBar();
      this.notifyDiffListChanged();

      // Close superseded diff tabs after notifying frontend
      for (const supersededMeta of supersededDiffs) {
        logger.debug(`[DiffManager] Closing superseded diff tab for ${supersededMeta.targetFilePath} (iteration ${supersededMeta.iteration})`);
        await this.closeDiffTabOnly(supersededMeta);
      }

      setTimeout(() => disposable.dispose(), 300000);

    } catch (error: any) {
      logger.error('Failed to show diff', error.message);
      this._onWarning.fire({ message: `Failed to show diff: ${error.message}` });
    }
  }

  async applyCode(code: string, language: string): Promise<void> {
    const activeEditor = vscode.window.activeTextEditor;
    let targetMetadata: DiffMetadata | undefined;

    if (activeEditor && activeEditor.document.uri.scheme === 'deepseek-diff') {
      const uriKey = activeEditor.document.uri.toString();
      targetMetadata = this.activeDiffs.get(uriKey);
      if (!targetMetadata) {
        for (const [key, meta] of this.activeDiffs.entries()) {
          if (meta.proposedUri.toString() === uriKey || meta.originalUri.toString() === uriKey) {
            targetMetadata = meta;
            break;
          }
        }
      }
    }

    if (!targetMetadata && this.activeDiffs.size > 0) {
      const diffs = Array.from(this.activeDiffs.values()).sort((a, b) => b.timestamp - a.timestamp);
      targetMetadata = diffs[0];
      logger.debug(`[DiffManager] No active diff editor, using most recent diff: ${targetMetadata.targetFilePath}`);
    }

    const filePathMatch = code.match(/^#\s*File:\s*(.+?)$/m);
    let targetFilePath = filePathMatch ? filePathMatch[1].trim() : null;

    if (!targetFilePath && targetMetadata) {
      targetFilePath = targetMetadata.targetFilePath;
      logger.debug(`[DiffManager] Using file path from diff metadata: ${targetFilePath}`);
    }

    const cleanCode = code.replace(/^#\s*File:.*\n/i, '');

    try {
      if (targetFilePath) {
        // Target file known — apply via WorkspaceEdit (no visible editor needed)
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
          this._onWarning.fire({ message: 'No workspace folder open' });
          this.sendCodeAppliedStatus(false, 'No workspace folder open');
          return;
        }

        let document: vscode.TextDocument | undefined;
        let fileUri: vscode.Uri | undefined;
        for (const folder of workspaceFolders) {
          const fullPath = vscode.Uri.joinPath(folder.uri, targetFilePath);
          try {
            document = await vscode.workspace.openTextDocument(fullPath);
            fileUri = fullPath;
            break;
          } catch (error) { continue; }
        }

        if (!document || !fileUri) {
          this._onWarning.fire({ message: `File not found in workspace: ${targetFilePath}` });
          this.sendCodeAppliedStatus(false, `File not found: ${targetFilePath}`);
          return;
        }

        const currentContent = document.getText();
        const result = this.diffEngine.applyChanges(currentContent, cleanCode);
        const fullRange = new vscode.Range(
          document.positionAt(0),
          document.positionAt(currentContent.length)
        );

        const edit = new vscode.WorkspaceEdit();
        edit.replace(fileUri, fullRange, result.content);
        await vscode.workspace.applyEdit(edit);
        this.sendCodeAppliedStatus(result.success, result.success ? undefined : 'Patch applied with fallback');

        // Open file in background so user can check the result
        await vscode.window.showTextDocument(document, { preview: false, preserveFocus: true });
      } else {
        // No target file — fall back to active editor
        let editor = activeEditor;

        if (editor && (editor.document.uri.scheme === 'deepseek-diff' || editor.document.uri.scheme === 'git')) {
          const realEditor = vscode.window.visibleTextEditors.find(e =>
            e.document.uri.scheme === 'file' && !e.document.uri.path.includes('deepseek-diff')
          );
          if (realEditor) {
            editor = realEditor;
          } else if (this.lastActiveEditorUri) {
            const doc = await vscode.workspace.openTextDocument(this.lastActiveEditorUri);
            editor = await vscode.window.showTextDocument(doc);
          }
        }

        if (!editor || editor.document.uri.scheme !== 'file') {
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

        if (!selection.isEmpty) {
          const edit = new vscode.WorkspaceEdit();
          edit.replace(document.uri, selection, cleanCode);
          await vscode.workspace.applyEdit(edit);
          this.sendCodeAppliedStatus(true);
          return;
        }

        const result = this.diffEngine.applyChanges(currentContent, cleanCode);
        const fullRange = new vscode.Range(
          document.positionAt(0),
          document.positionAt(currentContent.length)
        );

        const edit = new vscode.WorkspaceEdit();
        edit.replace(document.uri, fullRange, result.content);
        await vscode.workspace.applyEdit(edit);
        this.sendCodeAppliedStatus(result.success, result.success ? undefined : 'Patch applied with fallback');
      }

      if (targetMetadata) {
        await this.closeSingleDiff(targetMetadata);
      } else {
        await this.closeDiffEditor();
      }
    } catch (error: any) {
      logger.error('Failed to apply code', error.message);
      this.sendCodeAppliedStatus(false, error.message);
    }
  }

  async acceptSpecificDiff(diffId: string): Promise<void> {
    const metadata = Array.from(this.activeDiffs.values()).find(m => m.diffId === diffId);
    if (!metadata) {
      logger.warn(`[DiffManager] No diff found for diffId: ${diffId}`);
      return;
    }

    if (metadata.superseded) {
      logger.warn(`[DiffManager] Cannot accept superseded diff: ${diffId}`);
      this._onWarning.fire({ message: 'This version has been superseded by a newer edit. Please use the newer version.' });
      return;
    }

    logger.info(`[DiffManager] Accepting specific diff: ${diffId} (${metadata.targetFilePath})`);

    try {
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
        } catch { /* continue */ }
      }

      if (!fileUri) {
        fileUri = vscode.Uri.joinPath(workspaceFolders[0].uri, metadata.targetFilePath);
        const parentDir = vscode.Uri.joinPath(fileUri, '..');
        try { await vscode.workspace.fs.createDirectory(parentDir); } catch { /* exists */ }
      }

      let document: vscode.TextDocument;
      try {
        document = await vscode.workspace.openTextDocument(fileUri);
      } catch {
        await vscode.workspace.fs.writeFile(fileUri, new Uint8Array());
        document = await vscode.workspace.openTextDocument(fileUri);
      }

      const currentContent = document.getText();
      const cleanCode = metadata.code.replace(/^#\s*File:.*\n/i, '');
      const result = this.diffEngine.applyChanges(currentContent, cleanCode);

      const edit = new vscode.WorkspaceEdit();
      const fullRange = new vscode.Range(
        document.positionAt(0),
        document.positionAt(currentContent.length)
      );
      edit.replace(fileUri, fullRange, result.content);
      await vscode.workspace.applyEdit(edit);
      await document.save();

      logger.debug(`Code applied to: ${metadata.targetFilePath}`);

      this.resolvedDiffs.push({
        filePath: metadata.targetFilePath,
        timestamp: metadata.timestamp,
        status: 'applied',
        iteration: metadata.iteration,
        diffId: metadata.diffId
      });

      this.updateFileChangeStatus(metadata.targetFilePath, metadata.iteration, 'applied');
      await this.closeSingleDiff(metadata);
      await this.focusTargetFile(metadata.targetFilePath);
      this.sendCodeAppliedStatus(true);

      // Resolve pending approval if one exists (blocking ask mode)
      const pendingApproval = this.pendingApprovals.get(diffId);
      if (pendingApproval) {
        pendingApproval.resolve({ filePath: metadata.targetFilePath, diffId, approved: true });
        this.pendingApprovals.delete(diffId);
      }

    } catch (error: any) {
      logger.error(`[DiffManager] Failed to accept diff ${diffId}:`, error.message);
      this.sendCodeAppliedStatus(false, error.message);
    }
  }

  async rejectSpecificDiff(diffId: string): Promise<void> {
    const metadata = Array.from(this.activeDiffs.values()).find(m => m.diffId === diffId);
    if (!metadata) {
      logger.warn(`[DiffManager] No diff found for diffId: ${diffId}`);
      return;
    }

    logger.info(`[DiffManager] Rejecting specific diff: ${diffId} (${metadata.targetFilePath})`);

    this.resolvedDiffs.push({
      filePath: metadata.targetFilePath,
      timestamp: metadata.timestamp,
      status: 'rejected',
      iteration: metadata.iteration,
      diffId: metadata.diffId
    });

    this.updateFileChangeStatus(metadata.targetFilePath, metadata.iteration, 'rejected');
    await this.closeSingleDiff(metadata);

    // Resolve pending approval if one exists (blocking ask mode)
    const pendingApproval = this.pendingApprovals.get(diffId);
    if (pendingApproval) {
      pendingApproval.resolve({ filePath: metadata.targetFilePath, diffId, approved: false });
      this.pendingApprovals.delete(diffId);
    }
  }

  async acceptAllDiffs(): Promise<void> {
    const sorted = Array.from(this.activeDiffs.values()).sort((a, b) => a.timestamp - b.timestamp);
    logger.info(`[DiffManager] Accepting all ${sorted.length} diffs`);
    for (const meta of sorted) {
      await this.applyCode(meta.code, meta.language);
    }
  }

  async rejectAllDiffs(): Promise<void> {
    const allDiffs = Array.from(this.activeDiffs.values());
    logger.info(`[DiffManager] Rejecting all ${allDiffs.length} diffs`);
    for (const meta of allDiffs) {
      await this.closeSingleDiff(meta);
    }
  }

  async closeDiff(): Promise<void> {
    await this.closeDiffEditor();
  }

  /**
   * Apply code changes directly to a file without showing a diff (for auto mode).
   * @param skipNotification If true, don't send diffListChanged (caller handles batching)
   * @returns true if code was applied successfully
   */
  async applyCodeDirectlyForAutoMode(filePath: string, code: string, description?: string, skipNotification = false): Promise<boolean> {
    try {
      let fileUri: vscode.Uri | undefined;
      const isAbsolutePath = filePath.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(filePath);

      if (isAbsolutePath) {
        const absoluteUri = vscode.Uri.file(filePath);
        try {
          await vscode.workspace.fs.stat(absoluteUri);
          fileUri = absoluteUri;
        } catch { /* fall through */ }
      }

      if (!fileUri) {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
          for (const folder of workspaceFolders) {
            const possibleUri = vscode.Uri.joinPath(folder.uri, filePath);
            try {
              await vscode.workspace.fs.stat(possibleUri);
              fileUri = possibleUri;
              break;
            } catch { continue; }
          }
        }
      }

      if (!fileUri) {
        // File doesn't exist — check if this is a "create new file" operation
        // (empty SEARCH block means the LLM wants to create, not edit)
        const newFileContent = this.extractNewFileContent(code);
        if (newFileContent !== null) {
          return this.createNewFileForAutoMode(filePath, newFileContent, description, skipNotification);
        }
        logger.warn(`[DiffManager] Auto mode: File not found: ${filePath}`);
        this._onWarning.fire({ message: `Could not find file: ${filePath}. The file may have been moved or deleted.` });
        return false;
      }

      const document = await vscode.workspace.openTextDocument(fileUri);
      const currentContent = document.getText();
      const result = this.diffEngine.applyChanges(currentContent, code);

      if (!result.success) {
        logger.warn(`[DiffManager] Auto mode: Diff application had issues for ${filePath}: ${result.message}`);
        this._onWarning.fire({ message: `Code edit may not have been applied correctly to ${filePath}: ${result.message || 'No matching code found'}` });
      }

      const edit = new vscode.WorkspaceEdit();
      const fullRange = new vscode.Range(
        document.positionAt(0),
        document.positionAt(currentContent.length)
      );
      edit.replace(fileUri, fullRange, result.content);
      await vscode.workspace.applyEdit(edit);
      await document.save();

      const currentCount = this.fileEditCounts.get(filePath) || 0;
      const iteration = currentCount + 1;
      this.fileEditCounts.set(filePath, iteration);
      const diffId = `${filePath}-${Date.now()}-${iteration}`;

      logger.info(`[DiffManager] Auto mode: Applied changes to ${filePath} (iteration ${iteration})`);

      this.autoAppliedFiles.push({ filePath, timestamp: Date.now(), description });

      this.resolvedDiffs.push({
        filePath, timestamp: Date.now(), status: 'applied', iteration, diffId
      });

      this.currentResponseFileChanges.push({ filePath, status: 'applied', iteration });

      if (!skipNotification) {
        this.emitAutoAppliedChanges();
      }
      this.sendCodeAppliedStatus(true);
      return true;

    } catch (error: any) {
      logger.error(`[DiffManager] Auto mode: Failed to apply code to ${filePath}:`, error.message);
      this.sendCodeAppliedStatus(false, error.message, filePath);
      return false;
    }
  }

  /**
   * Extract content from the REPLACE section when SEARCH is empty (new file creation).
   * Returns the file content if this is a create-new-file pattern, null otherwise.
   */
  private extractNewFileContent(code: string): string | null {
    // Strip # File: header if present
    const stripped = code.replace(/^#\s*File:.*\n/i, '');

    // Pattern: empty SEARCH block followed by content in REPLACE block
    // Matches: <<<<<<< SEARCH\n======= [AND]\n<content>\n>>>>>>> REPLACE
    const createPattern = /<<<<<<< SEARCH\s*\n=======(?:\s*AND)?\s*\n([\s\S]*?)>>>>>>> REPLACE/;
    const match = stripped.match(createPattern);
    if (match) {
      return match[1].trimEnd();
    }

    return null;
  }

  /**
   * Create a new file in auto mode when the file doesn't exist yet.
   */
  private async createNewFileForAutoMode(filePath: string, content: string, description?: string, skipNotification = false): Promise<boolean> {
    try {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders || workspaceFolders.length === 0) {
        logger.warn(`[DiffManager] Auto mode: No workspace folder to create file: ${filePath}`);
        return false;
      }

      const newFileUri = vscode.Uri.joinPath(workspaceFolders[0].uri, filePath);
      const encoder = new TextEncoder();
      await vscode.workspace.fs.writeFile(newFileUri, encoder.encode(content));

      const currentCount = this.fileEditCounts.get(filePath) || 0;
      const iteration = currentCount + 1;
      this.fileEditCounts.set(filePath, iteration);
      const diffId = `${filePath}-${Date.now()}-${iteration}`;

      logger.info(`[DiffManager] Auto mode: Created new file ${filePath}`);

      this.autoAppliedFiles.push({ filePath, timestamp: Date.now(), description });
      this.resolvedDiffs.push({ filePath, timestamp: Date.now(), status: 'applied', iteration, diffId });
      this.currentResponseFileChanges.push({ filePath, status: 'applied', iteration });

      if (!skipNotification) {
        this.emitAutoAppliedChanges();
      }
      this.sendCodeAppliedStatus(true);
      return true;
    } catch (error: any) {
      logger.error(`[DiffManager] Auto mode: Failed to create file ${filePath}:`, error.message);
      this.sendCodeAppliedStatus(false, error.message, filePath);
      return false;
    }
  }

  // ── Focus / Navigation ──

  async focusSpecificDiff(diffId: string): Promise<void> {
    const metadata = Array.from(this.activeDiffs.values()).find(m => m.diffId === diffId);
    if (!metadata) {
      logger.warn(`[DiffManager] No diff found for diffId: ${diffId}`);
      return;
    }

    const iterationLabel = metadata.iteration > 1 ? ` (${metadata.iteration})` : '';
    await vscode.commands.executeCommand('vscode.diff',
      metadata.originalUri, metadata.proposedUri,
      `${metadata.targetFilePath}${iterationLabel} ↔ With Changes`
    );
    logger.debug(`[DiffManager] Focused diff: ${diffId} (${metadata.targetFilePath})`);
  }

  async focusFileOrDiff(diffId: string | undefined, filePath: string | undefined): Promise<void> {
    if (diffId) {
      const metadata = Array.from(this.activeDiffs.values()).find(m => m.diffId === diffId);
      if (metadata) {
        const iterationLabel = metadata.iteration > 1 ? ` (${metadata.iteration})` : '';
        await vscode.commands.executeCommand('vscode.diff',
          metadata.originalUri, metadata.proposedUri,
          `${metadata.targetFilePath}${iterationLabel} ↔ With Changes`
        );
        logger.debug(`[DiffManager] Focused diff: ${diffId} (${metadata.targetFilePath})`);
        return;
      }
      logger.debug(`[DiffManager] Diff ${diffId} not found (may have been applied), falling back to file`);
    }

    if (filePath) {
      await this.openFile(filePath);
    } else {
      logger.warn('[DiffManager] focusFileOrDiff: no diffId or filePath provided');
    }
  }

  async openFile(filePath: string): Promise<void> {
    if (!filePath) {
      logger.warn('[DiffManager] openFile called with empty filePath');
      return;
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      logger.warn('[DiffManager] No workspace folder found');
      return;
    }

    const absolutePath = path.isAbsolute(filePath)
      ? filePath
      : path.join(workspaceFolder.uri.fsPath, filePath);

    const uri = vscode.Uri.file(absolutePath);
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { preview: false });
      logger.debug(`[DiffManager] Opened file: ${filePath}`);
    } catch (error) {
      logger.warn(`[DiffManager] Failed to open file: ${filePath}: ${error}`);
      this._onWarning.fire({ message: `Could not open file: ${filePath}` });
    }
  }

  // ── Streaming Integration ──

  /**
   * Detect complete code blocks in the accumulated response and auto-handle in ask/auto mode.
   * Encapsulates the code block detection logic from ChatProvider handleUserMessage.
   */
  async handleCodeBlockDetection(accumulatedResponse: string): Promise<void> {
    if (this.editMode === 'ask' || this.editMode === 'auto') {
      const blocks = extractCodeBlocks(accumulatedResponse);

      for (const block of blocks) {
        if (block.language === 'tool-output') continue;

        // Dedup before any logging — this method is called on every flush
        const blockId = `${block.startIndex}-${block.raw.length}`;
        if (this.processedCodeBlocks.has(blockId)) continue;
        this.processedCodeBlocks.add(blockId);

        const fileHeaderMatch = block.content.match(/^#\s*File:\s*(.+?)$/m);
        if (!fileHeaderMatch) {
          logger.debug(`[DiffManager] Skipping auto-diff for code block without # File: header (likely explanatory code)`);
          continue;
        }

        if (this.editMode === 'ask') {
          await this.handleAskModeDiff(block.content, block.language);
        } else if (this.editMode === 'auto') {
          const filePath = fileHeaderMatch[1].trim();
          const codeWithoutHeader = block.content.replace(/^#\s*File:.*\n/i, '');
          logger.info(`[DiffManager] Auto-applying code block for: ${filePath}`);
          if (!this.currentResponseFileChanges.some(f => f.filePath === filePath)) {
            this.currentResponseFileChanges.push({ filePath, status: 'pending', iteration: 0 });
          }
          await this.applyCodeDirectlyForAutoMode(filePath, codeWithoutHeader, 'Auto-applied from code block');
        }
      }
    }
  }

  async handleAutoShowDiff(code: string, language: string): Promise<void> {
    try {
      logger.info(`[DiffManager] Starting auto-show diff (language: ${language}, editMode: ${this.editMode})`);

      logger.debug(`[FileResolver] Strategy 0: Checking # File: header in code...`);
      const filePathMatch = code.match(/^#\s*File:\s*(.+?)$/m);
      let filePath = filePathMatch ? filePathMatch[1].trim() : null;

      if (filePath) {
        logger.debug(`[FileResolver] ✓ Strategy 0 SUCCESS: Found # File: header "${filePath}"`);
      } else {
        logger.warn(`[FileResolver] ✗ Strategy 0 FAILED: No # File: header found`);
        filePath = await this.fileContextManager.resolveFilePath(code, language);

        if (filePath) {
          code = `# File: ${filePath}\n${code}`;
          logger.debug(`[DiffManager] Injected inferred file path: ${filePath}`);
        } else {
          logger.error(`[DiffManager] Could not determine target file - skipping auto-diff`);
          this._onWarning.fire({
            message: 'Could not determine which file to edit. Please add a "# File: path" comment to the code block.'
          });
          return;
        }
      }

      logger.debug(`[DiffManager] Opening diff editor for file: ${filePath}`);
      await this.showDiff(code, language);

      this._onEditConfirm.fire({ filePath, code, language });
      logger.info(`[DiffManager] ✓ Auto-showed diff for "${filePath}" in ask mode`);
    } catch (error: any) {
      logger.error('[DiffManager] Failed to auto-show diff:', error.message);
      this._onWarning.fire({ message: `Failed to show diff: ${error.message}` });
    }
  }

  // ── Blocking Ask Mode Approval ──

  /**
   * Show a diff immediately and register it for blocking approval.
   * Used in ask mode instead of handleDebouncedDiff().
   */
  async handleAskModeDiff(code: string, language: string): Promise<void> {
    await this.handleAutoShowDiff(code, language);

    const filePath = code.match(/^#\s*File:\s*(.+?)$/m)?.[1]?.trim();
    if (!filePath) return;

    const metadata = Array.from(this.activeDiffs.values())
      .find(m => m.targetFilePath === filePath && !m.superseded);
    if (!metadata) return;

    this.registerPendingApproval(metadata.diffId, filePath);
  }

  private registerPendingApproval(diffId: string, filePath: string): void {
    // If there's already a pending approval for this file (superseded), reject it
    for (const [existingId, existing] of this.pendingApprovals.entries()) {
      if (existing.filePath === filePath) {
        logger.debug(`[DiffManager] Superseding pending approval for ${filePath} (old: ${existingId}, new: ${diffId})`);
        existing.resolve({ filePath, diffId: existingId, approved: false });
        this.pendingApprovals.delete(existingId);
      }
    }

    this.pendingApprovals.set(diffId, {
      resolve: () => {},  // placeholder, replaced by waitForPendingApprovals
      filePath
    });
  }

  /**
   * Wait for all pending approvals to be resolved (accept/reject/tab-close).
   * Called by RequestOrchestrator at iteration boundaries.
   */
  async waitForPendingApprovals(): Promise<DiffApprovalResult[]> {
    if (this.pendingApprovals.size === 0) return [];

    const filePaths = Array.from(this.pendingApprovals.values()).map(p => p.filePath);
    this._onWaitingForApproval.fire({ filePaths });
    logger.info(`[DiffManager] Waiting for ${this.pendingApprovals.size} pending approval(s): ${filePaths.join(', ')}`);

    const promises: Promise<DiffApprovalResult>[] = [];
    for (const [diffId, pending] of this.pendingApprovals.entries()) {
      promises.push(new Promise<DiffApprovalResult>((resolve) => {
        pending.resolve = resolve;
      }));
    }

    const results = await Promise.all(promises);
    this.pendingApprovals.clear();
    return results;
  }

  /**
   * Cancel all pending approvals (resolves them as rejected).
   * Called on stop generation, new conversation, etc.
   */
  cancelPendingApprovals(): void {
    for (const [diffId, pending] of this.pendingApprovals.entries()) {
      pending.resolve({ filePath: pending.filePath, diffId, approved: false });
    }
    this.pendingApprovals.clear();
  }

  handleDebouncedDiff(code: string, language: string): void {
    const filePathMatch = code.match(/^#\s*File:\s*(.+?)$/m);
    const filePath = filePathMatch ? filePathMatch[1].trim() : 'unknown';

    logger.debug(`[DiffManager] Debouncing diff for ${filePath} (2.5s delay)`);

    const existing = this.pendingDiffs.get(filePath);
    if (existing) {
      clearTimeout(existing.timer);
      logger.debug(`[DiffManager] Replaced pending diff for ${filePath} (LLM iteration detected)`);
    }

    const timer = setTimeout(async () => {
      logger.debug(`[DiffManager] Debounce timer expired for ${filePath}, showing diff now`);
      this.pendingDiffs.delete(filePath);
      await this.handleAutoShowDiff(code, language);
    }, 2500);

    this.pendingDiffs.set(filePath, { code, language, timer });
  }

  async detectAndProcessUnfencedEdits(content: string): Promise<void> {
    const hasSearchMarker = /<<<{3,}\s*SEARCH/i.test(content);
    const hasReplaceMarker = />>>{3,}\s*REPLACE/i.test(content);

    if (!hasSearchMarker || !hasReplaceMarker) return;

    logger.debug(`[DiffManager] Detected potential unfenced SEARCH/REPLACE markers`);

    const fencedBlocks = extractCodeBlocks(content);
    let contentWithoutFencedBlocks = content;
    for (const block of fencedBlocks) {
      contentWithoutFencedBlocks = contentWithoutFencedBlocks.replace(block.raw, '<<<FENCED_BLOCK>>>');
    }

    const unfencedHasSearch = /<<<{3,}\s*SEARCH/i.test(contentWithoutFencedBlocks);
    const unfencedHasReplace = />>>{3,}\s*REPLACE/i.test(contentWithoutFencedBlocks);

    if (!unfencedHasSearch || !unfencedHasReplace) {
      logger.debug(`[DiffManager] All SEARCH/REPLACE blocks are inside code fences (already processed)`);
      return;
    }

    logger.debug(`[DiffManager] Found UNFENCED SEARCH/REPLACE blocks - attempting fallback processing`);

    const unfencedEditRegex = /#\s*File:\s*(.+?)(?:\n|\r\n)([\s\S]*?<<<{3,}\s*SEARCH[\s\S]*?>>>{3,}\s*REPLACE)/gi;
    const unfencedMatches = [...contentWithoutFencedBlocks.matchAll(unfencedEditRegex)];

    if (unfencedMatches.length > 0) {
      for (const editMatch of unfencedMatches) {
        const filePath = editMatch[1].trim();
        const codeBlock = editMatch[2];

        logger.debug(`[DiffManager] Processing unfenced edit for: ${filePath}`);

        const codeWithHeader = `# File: ${filePath}\n${codeBlock}`;
        const blockId = `unfenced-${filePath}-${codeBlock.length}`;
        if (this.processedCodeBlocks.has(blockId)) {
          logger.debug(`[DiffManager] Skipping already processed unfenced block: ${blockId}`);
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
      logger.warn(`[DiffManager] Found SEARCH/REPLACE markers but no # File: header - cannot auto-process`);
      this._onWarning.fire({
        message: 'Code edit detected but missing file path. The response contains SEARCH/REPLACE format but no "# File:" header to identify which file to edit.'
      });
    }
  }

  clearProcessedBlocks(): void {
    this.processedCodeBlocks.clear();
  }

  clearPendingDiffs(): void {
    for (const [filePath, pending] of this.pendingDiffs.entries()) {
      clearTimeout(pending.timer);
      logger.debug(`[DiffManager] Cleared pending diff timer for ${filePath}`);
    }
    this.pendingDiffs.clear();
    this.cancelPendingApprovals();
  }

  clearResponseFileChanges(): void {
    this.currentResponseFileChanges = [];
  }

  // ── State Queries ──

  getModifiedFilesContext(): string {
    const appliedFiles = new Set<string>();

    for (const diff of this.resolvedDiffs) {
      if (diff.status === 'applied') {
        appliedFiles.add(diff.filePath);
      }
    }

    for (const file of this.autoAppliedFiles) {
      appliedFiles.add(file.filePath);
    }

    if (appliedFiles.size === 0) return '';

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

  getFileChanges(): Array<{ filePath: string; status: 'applied' | 'rejected' | 'pending'; iteration: number }> {
    return this.currentResponseFileChanges;
  }

  // ── Session Management ──

  /**
   * Clear all diff state for a new conversation.
   */
  clearSession(): void {
    this.autoAppliedFiles = [];
    this.resolvedDiffs = [];
    this._lastNotifiedDiffIndex = 0;
    this.fileEditCounts.clear();
  }

  /**
   * Emit auto-applied files changes (incremental, called after tool batch closes).
   */
  emitAutoAppliedChanges(): void {
    this.notifyAutoAppliedFilesChanged();
  }

  // ── Quick Pick ──

  async showDiffQuickPick(): Promise<void> {
    if (this.activeDiffs.size === 0) {
      vscode.window.showInformationMessage('No pending diffs');
      return;
    }

    const diffsByFile = new Map<string, DiffMetadata[]>();
    for (const [key, meta] of this.activeDiffs.entries()) {
      const filePath = meta.targetFilePath;
      if (!diffsByFile.has(filePath)) {
        diffsByFile.set(filePath, []);
      }
      diffsByFile.get(filePath)!.push(meta);
    }

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

      for (let i = 0; i < metas.length; i++) {
        const meta = metas[i];
        const itemLabel = diffCount > 1 ? `  ${label} - Diff ${i + 1}` : label;
        items.push({
          label: itemLabel,
          description: path.dirname(filePath),
          detail: `Created ${this.formatTimestamp(meta.timestamp)}`,
          metadata: meta,
          buttons: [
            { iconPath: new vscode.ThemeIcon('check'), tooltip: 'Accept changes' },
            { iconPath: new vscode.ThemeIcon('close'), tooltip: 'Reject changes' }
          ]
        });
      }
    }

    const quickPick = vscode.window.createQuickPick<DiffQuickPickItem>();
    quickPick.items = items;
    quickPick.placeholder = 'Select a diff to review (Enter to focus, click buttons to accept/reject)';
    quickPick.matchOnDescription = true;
    quickPick.matchOnDetail = true;

    quickPick.onDidAccept(async () => {
      const selected = quickPick.selectedItems[0];
      if (selected) {
        await this.focusDiff(selected.metadata);
      }
    });

    quickPick.onDidTriggerItemButton(async (e) => {
      const item = e.item;
      const button = e.button;

      if (button.tooltip === 'Accept changes') {
        await this.acceptSpecificDiff(item.metadata.targetFilePath);
        logger.debug(`[QuickPick] Accepted diff for ${item.metadata.targetFilePath}`);
      } else if (button.tooltip === 'Reject changes') {
        await this.rejectSpecificDiff(item.metadata.targetFilePath);
        logger.debug(`[QuickPick] Rejected diff for ${item.metadata.targetFilePath}`);
      }

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

  // ── Disposal ──

  dispose(): void {
    this.clearPendingDiffs();
    this._onDiffListChanged.dispose();
    this._onAutoAppliedFilesChanged.dispose();
    this._onCodeApplied.dispose();
    this._onActiveDiffChanged.dispose();
    this._onDiffClosed.dispose();
    this._onWarning.dispose();
    this._onEditConfirm.dispose();
    this._onEditRejected.dispose();
    this._onWaitingForApproval.dispose();
    this.disposables.forEach(d => d.dispose());
  }

  // ── Private Methods ──

  private notifyDiffListChanged(): void {
    if (this.flushCallback) {
      logger.debug(`[Buffer] FLUSH before notifyDiffListChanged`);
      this.flushCallback();
    }

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

    const combinedDiffs = [...pendingDiffs, ...resolvedDiffsList];

    const pendingByPath = new Map<string, typeof pendingDiffs[0]>();
    const resolvedByPath = new Map<string, typeof resolvedDiffsList[0]>();

    for (const d of combinedDiffs) {
      if (d.status === 'pending') {
        const existing = pendingByPath.get(d.filePath);
        if (!existing || d.timestamp > existing.timestamp) {
          pendingByPath.set(d.filePath, d);
        }
      } else {
        const existing = resolvedByPath.get(d.filePath);
        if (!existing || d.timestamp > existing.timestamp) {
          resolvedByPath.set(d.filePath, d);
        }
      }
    }

    const allDiffs = [...pendingByPath.values(), ...resolvedByPath.values()]
      .sort((a, b) => a.timestamp - b.timestamp);

    this._onDiffListChanged.fire({ diffs: allDiffs, editMode: this.editMode });
  }

  private notifyAutoAppliedFilesChanged(): void {
    if (this.flushCallback) {
      logger.debug(`[Buffer] FLUSH before notifyAutoAppliedFilesChanged`);
      this.flushCallback();
    }

    const newDiffs = this.resolvedDiffs.slice(this._lastNotifiedDiffIndex);
    this._lastNotifiedDiffIndex = this.resolvedDiffs.length;

    if (newDiffs.length === 0) return;

    const diffsArray = newDiffs.map(d => ({
      filePath: d.filePath,
      timestamp: d.timestamp,
      status: d.status,
      iteration: d.iteration,
      diffId: d.diffId,
      superseded: false
    }));

    logger.debug(`[Frontend] Sending diffListChanged (auto-applied) message: ${diffsArray.length} new files`);
    this._onAutoAppliedFilesChanged.fire({ diffs: diffsArray, editMode: this.editMode });
  }

  private async closeDiffTabOnly(metadata: DiffMetadata): Promise<void> {
    this.closingDiffsInProgress++;
    logger.debug(`[OVERLAY-DEBUG] Closing tab only for ${metadata.targetFilePath} (counter: ${this.closingDiffsInProgress})`);

    try {
      for (const tabGroup of vscode.window.tabGroups.all) {
        for (const tab of tabGroup.tabs) {
          const input = tab.input as any;
          if (input?.original?.toString() === metadata.originalUri.toString() ||
              input?.modified?.toString() === metadata.proposedUri.toString()) {
            try { await vscode.window.tabGroups.close(tab); } catch (e) { /* tab may be closed */ }
            logger.debug(`[DiffManager] Closed superseded diff tab for: ${metadata.targetFilePath}`);
            break;
          }
        }
      }
    } finally {
      setTimeout(() => {
        this.closingDiffsInProgress = Math.max(0, this.closingDiffsInProgress - 1);
        logger.debug(`[OVERLAY-DEBUG] Tab close complete, counter now: ${this.closingDiffsInProgress}`);
      }, 500);
    }
  }

  private async closeSingleDiff(metadata: DiffMetadata): Promise<void> {
    this.closingDiffsInProgress++;
    logger.debug(`[OVERLAY-DEBUG] Starting intentional close for ${metadata.targetFilePath} (counter: ${this.closingDiffsInProgress})`);

    try {
      for (const tabGroup of vscode.window.tabGroups.all) {
        for (const tab of tabGroup.tabs) {
          const input = tab.input as any;
          if (input?.original?.toString() === metadata.originalUri.toString() ||
              input?.modified?.toString() === metadata.proposedUri.toString()) {
            try { await vscode.window.tabGroups.close(tab); } catch (e) { /* tab may be closed */ }
            break;
          }
        }
      }

      this.activeDiffs.delete(metadata.proposedUri.toString());
      logger.debug(`Closed diff for: ${metadata.targetFilePath}`);
      this.updateDiffStatusBar();
      this.notifyDiffListChanged();
    } finally {
      setTimeout(() => {
        this.closingDiffsInProgress = Math.max(0, this.closingDiffsInProgress - 1);
        logger.debug(`[OVERLAY-DEBUG] Intentional close complete, counter now: ${this.closingDiffsInProgress}`);
      }, 500);
    }
  }

  private async closeDiffEditor(): Promise<void> {
    const tabsToClose: vscode.Tab[] = [];

    for (const tabGroup of vscode.window.tabGroups.all) {
      for (const tab of tabGroup.tabs) {
        const input = tab.input as any;
        if (input?.original?.scheme === 'deepseek-diff' || input?.modified?.scheme === 'deepseek-diff') {
          tabsToClose.push(tab);
        }
      }
    }

    if (tabsToClose.length > 0) {
      logger.debug(`Closing ${tabsToClose.length} diff tab(s)`);
      for (const tab of tabsToClose) {
        try { await vscode.window.tabGroups.close(tab); } catch (e) { /* tab may be closed */ }
      }
    }

    this.activeDiffs.clear();
    this.diffTabGroupId = null;
    this.updateDiffStatusBar();
    this.notifyDiffListChanged();
  }

  private updateDiffStatusBar(): void {
    const diffCount = this.activeDiffs.size;

    if (diffCount === 0) {
      this.diffStatusBarItem.hide();
    } else {
      const plural = diffCount === 1 ? 'diff' : 'diffs';
      this.diffStatusBarItem.text = `$(diff) DeepSeek: ${diffCount} ${plural}`;
      this.diffStatusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      this.diffStatusBarItem.show();
    }
  }

  private updateFileChangeStatus(filePath: string, iteration: number, status: 'applied' | 'rejected'): void {
    const index = this.currentResponseFileChanges.findIndex(
      fc => fc.filePath === filePath && fc.iteration === iteration
    );
    if (index !== -1) {
      this.currentResponseFileChanges[index].status = status;
    }
  }

  private sendCodeAppliedStatus(success: boolean, error?: string, filePath?: string): void {
    logger.codeApplied(success, filePath);
    this._onCodeApplied.fire({ success, error, filePath });
  }

  private async focusDiff(metadata: DiffMetadata): Promise<void> {
    for (const tabGroup of vscode.window.tabGroups.all) {
      for (const tab of tabGroup.tabs) {
        if (tab.input instanceof vscode.TabInputTextDiff) {
          if (tab.input.modified.toString() === metadata.proposedUri.toString()) {
            await vscode.window.showTextDocument(metadata.proposedUri, {
              viewColumn: tabGroup.viewColumn,
              preview: false
            });
            return;
          }
        }
      }
    }
    logger.warn(`[DiffManager] Could not find diff editor for ${metadata.targetFilePath}`);
  }

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

  /**
   * Focus the target file in its existing editor pane after a diff is closed.
   */
  private async focusTargetFile(filePath: string): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) return;

    for (const folder of workspaceFolders) {
      const fileUri = vscode.Uri.joinPath(folder.uri, filePath);
      try {
        const doc = await vscode.workspace.openTextDocument(fileUri);
        const existingEditor = vscode.window.visibleTextEditors.find(
          e => e.document.uri.toString() === doc.uri.toString()
        );
        const viewColumn = existingEditor?.viewColumn ?? vscode.ViewColumn.One;
        await vscode.window.showTextDocument(doc, { viewColumn, preview: false, preserveFocus: false });
        logger.debug(`[DiffManager] Focused target file after apply: ${filePath}`);
        return;
      } catch { continue; }
    }
  }

  private mapLanguage(language: string): string {
    const languageMap: Record<string, string> = {
      'js': 'javascript', 'ts': 'typescript', 'py': 'python', 'rb': 'ruby',
      'rs': 'rust', 'go': 'go', 'java': 'java', 'cpp': 'cpp', 'c': 'c',
      'cs': 'csharp', 'php': 'php', 'swift': 'swift', 'kt': 'kotlin',
      'scala': 'scala', 'sh': 'shellscript', 'bash': 'shellscript',
      'zsh': 'shellscript', 'sql': 'sql', 'html': 'html', 'css': 'css',
      'scss': 'scss', 'json': 'json', 'yaml': 'yaml', 'yml': 'yaml',
      'xml': 'xml', 'md': 'markdown', 'markdown': 'markdown', 'text': 'plaintext'
    };
    return languageMap[language.toLowerCase()] || language;
  }
}
