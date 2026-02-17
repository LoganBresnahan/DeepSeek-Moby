import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Working EventEmitter for event-driven class testing
const { WorkingEventEmitter } = vi.hoisted(() => ({
  WorkingEventEmitter: class WorkingEventEmitter {
    private _listeners: Array<(e: any) => void> = [];
    event = (listener: (e: any) => void) => {
      this._listeners.push(listener);
      return { dispose: () => { this._listeners = this._listeners.filter(l => l !== listener); } };
    };
    fire = (data: any) => { for (const l of this._listeners) l(data); };
    dispose = () => { this._listeners = []; };
  }
}));

vi.mock('vscode', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    EventEmitter: WorkingEventEmitter,
    window: {
      ...(original as any).window,
      createStatusBarItem: vi.fn(() => ({
        text: '',
        tooltip: '',
        command: '',
        backgroundColor: null,
        show: vi.fn(),
        hide: vi.fn(),
        dispose: vi.fn(),
      })),
      tabGroups: { all: [], close: vi.fn() },
      activeTextEditor: undefined,
      visibleTextEditors: [],
      onDidChangeActiveTextEditor: vi.fn(() => ({ dispose: vi.fn() })),
      showTextDocument: vi.fn(async (doc: any) => ({
        document: doc,
        selection: { isEmpty: true },
        edit: vi.fn(async (cb: any) => {
          cb({ replace: vi.fn() });
          return true;
        }),
      })),
      showInformationMessage: vi.fn(),
      showWarningMessage: vi.fn(),
      showErrorMessage: vi.fn(),
      createQuickPick: vi.fn(() => ({
        items: [],
        placeholder: '',
        matchOnDescription: false,
        matchOnDetail: false,
        onDidAccept: vi.fn(),
        onDidTriggerItemButton: vi.fn(),
        show: vi.fn(),
        hide: vi.fn(),
        dispose: vi.fn(),
      })),
    },
    workspace: {
      ...(original as any).workspace,
      onDidCloseTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
      asRelativePath: vi.fn((uri: any) => {
        const str = typeof uri === 'string' ? uri : uri?.toString?.() || '';
        return str.replace('file:///', '').replace('file://', '');
      }),
      workspaceFolders: [{ uri: { toString: () => 'file:///workspace', fsPath: '/workspace' } }],
      openTextDocument: vi.fn(async (uriOrOpts: any) => ({
        uri: uriOrOpts?.uri || uriOrOpts || { toString: () => 'file:///workspace/test.ts', scheme: 'file' },
        getText: () => 'original content',
        fileName: '/workspace/test.ts',
        positionAt: (offset: number) => ({ line: 0, character: offset }),
        offsetAt: (pos: any) => pos.character || 0,
      })),
      registerTextDocumentContentProvider: vi.fn(() => ({ dispose: vi.fn() })),
      getConfiguration: vi.fn(() => ({
        get: vi.fn(),
        update: vi.fn(),
      })),
      applyEdit: vi.fn(async () => true),
      fs: {
        stat: vi.fn(async () => ({})),
        readFile: vi.fn(async () => Buffer.from('file content')),
        writeFile: vi.fn(async () => {}),
        createDirectory: vi.fn(async () => {}),
      },
    },
    commands: {
      ...(original as any).commands,
      executeCommand: vi.fn(),
    },
    Uri: {
      parse: (s: string) => ({ toString: () => s, scheme: s.split(':')[0] || 'file', fsPath: s }),
      joinPath: (_base: any, rel: string) => ({
        toString: () => `file:///workspace/${rel}`,
        fsPath: `/workspace/${rel}`,
        scheme: 'file',
      }),
      file: (s: string) => ({ toString: () => `file://${s}`, fsPath: s, scheme: 'file' }),
    },
    Range: class Range {
      start: any;
      end: any;
      constructor(start: any, end: any) { this.start = start; this.end = end; }
    },
    WorkspaceEdit: class WorkspaceEdit {
      replace = vi.fn();
    },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ViewColumn: { One: 1, Two: 2, Three: 3 },
    ThemeColor: class ThemeColor { constructor(public id: string) {} },
    ThemeIcon: class ThemeIcon { constructor(public id: string) {} },
    ConfigurationTarget: { Global: 1, Workspace: 2 },
    TabInputTextDiff: class TabInputTextDiff {},
  };
});

vi.mock('../../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    diffShown: vi.fn(),
    codeApplied: vi.fn(),
  },
}));

import { DiffManager } from '../../../src/providers/diffManager';
import type { DiffListChangedEvent, CodeAppliedEvent } from '../../../src/providers/types';
import * as vscode from 'vscode';

// ── Mock factories ──

function createMockDiffEngine() {
  return {
    applyChanges: vi.fn((original: string, newCode: string) => ({
      content: newCode,
      success: true,
      message: 'Applied successfully',
    })),
  };
}

function createMockFileContextManager() {
  return {
    inferFilePath: vi.fn(() => null),
    resolveFilePath: vi.fn(async () => null),
    isModalOpen: false,
    setModalOpen: vi.fn(),
    sendOpenFiles: vi.fn(),
    handleFileSearch: vi.fn(),
    sendFileContent: vi.fn(),
    setSelectedFiles: vi.fn(),
    clearTurnTracking: vi.fn(),
    trackReadFile: vi.fn(),
    extractFileIntent: vi.fn(),
    getSelectedFilesContext: vi.fn(() => ''),
    get selectedFileCount() { return 0; },
    get readFileCount() { return 0; },
    onOpenFiles: vi.fn(),
    onSearchResults: vi.fn(),
    onFileContent: vi.fn(),
    dispose: vi.fn(),
  };
}

function createManager(editMode: 'manual' | 'ask' | 'auto' = 'manual') {
  const diffEngine = createMockDiffEngine();
  const fileContextManager = createMockFileContextManager();
  const manager = new DiffManager(diffEngine as any, fileContextManager as any, editMode);
  return { manager, diffEngine, fileContextManager };
}

describe('DiffManager', () => {
  let manager: DiffManager;
  let diffEngine: ReturnType<typeof createMockDiffEngine>;
  let fileContextManager: ReturnType<typeof createMockFileContextManager>;

  beforeEach(() => {
    ({ manager, diffEngine, fileContextManager } = createManager());
    vi.clearAllMocks();
  });

  afterEach(() => {
    manager.dispose();
  });

  // ── setEditMode ──

  describe('setEditMode', () => {
    it('should set edit mode', () => {
      expect(manager.currentEditMode).toBe('manual');
      manager.setEditMode('ask');
      expect(manager.currentEditMode).toBe('ask');
    });

    it('should persist to VS Code config', () => {
      manager.setEditMode('auto');
      expect(vscode.workspace.getConfiguration).toHaveBeenCalledWith('deepseek');
    });

    it('should accept all valid modes', () => {
      for (const mode of ['manual', 'ask', 'auto'] as const) {
        manager.setEditMode(mode);
        expect(manager.currentEditMode).toBe(mode);
      }
    });
  });

  // ── rejectEdit ──

  describe('rejectEdit', () => {
    it('should fire onEditRejected event', async () => {
      const events: Array<{ filePath: string }> = [];
      manager.onEditRejected(e => events.push(e));

      await manager.rejectEdit('src/main.ts');

      expect(events).toHaveLength(1);
      expect(events[0].filePath).toBe('src/main.ts');
    });
  });

  // ── clearProcessedBlocks ──

  describe('clearProcessedBlocks', () => {
    it('should clear without error', () => {
      expect(() => manager.clearProcessedBlocks()).not.toThrow();
    });
  });

  // ── clearPendingDiffs ──

  describe('clearPendingDiffs', () => {
    it('should clear without error', () => {
      expect(() => manager.clearPendingDiffs()).not.toThrow();
    });
  });

  // ── clearResponseFileChanges ──

  describe('clearResponseFileChanges', () => {
    it('should clear file changes', () => {
      manager.clearResponseFileChanges();
      expect(manager.getFileChanges()).toEqual([]);
    });
  });

  // ── getFileChanges ──

  describe('getFileChanges', () => {
    it('should return empty array initially', () => {
      expect(manager.getFileChanges()).toEqual([]);
    });
  });

  // ── getModifiedFilesContext ──

  describe('getModifiedFilesContext', () => {
    it('should return empty string when no diffs resolved', () => {
      expect(manager.getModifiedFilesContext()).toBe('');
    });
  });

  // ── clearSession ──

  describe('clearSession', () => {
    it('should reset all state without error', () => {
      expect(() => manager.clearSession()).not.toThrow();
    });

    it('should clear file changes', () => {
      manager.clearSession();
      expect(manager.getFileChanges()).toEqual([]);
    });
  });

  // ── setFlushCallback ──

  describe('setFlushCallback', () => {
    it('should store callback', () => {
      const cb = vi.fn();
      manager.setFlushCallback(cb);
      // Callback is called during notifyDiffListChanged (internal)
      expect(() => manager.setFlushCallback(cb)).not.toThrow();
    });
  });

  // ── emitAutoAppliedChanges ──

  describe('emitAutoAppliedChanges', () => {
    it('should call flush callback before emitting', () => {
      const flushCb = vi.fn();
      manager.setFlushCallback(flushCb);

      // With no resolved diffs, it fires but the event has no new diffs
      manager.emitAutoAppliedChanges();

      expect(flushCb).toHaveBeenCalled();
    });

    it('should fire onAutoAppliedFilesChanged with new diffs only', () => {
      const events: DiffListChangedEvent[] = [];
      manager.onAutoAppliedFilesChanged(e => events.push(e));

      // No resolved diffs yet — should not fire (empty diffs array)
      manager.emitAutoAppliedChanges();
      expect(events).toHaveLength(0);
    });
  });

  // ── applyCodeDirectlyForAutoMode ──

  describe('applyCodeDirectlyForAutoMode', () => {
    it('should apply code and fire onCodeApplied on success', async () => {
      (vscode.workspace.fs.stat as any).mockResolvedValue({});
      const codeAppliedEvents: CodeAppliedEvent[] = [];
      manager.onCodeApplied(e => codeAppliedEvents.push(e));

      const mockDoc = {
        uri: { toString: () => 'file:///workspace/src/app.ts', scheme: 'file' },
        getText: () => 'old content',
        positionAt: (o: number) => ({ line: 0, character: o }),
        save: vi.fn(async () => true),
      };
      (vscode.workspace.openTextDocument as any).mockResolvedValue(mockDoc);

      const result = await manager.applyCodeDirectlyForAutoMode('src/app.ts', 'new content');

      expect(result).toBe(true);
      expect(codeAppliedEvents).toHaveLength(1);
      expect(codeAppliedEvents[0].success).toBe(true);
    });

    it('should return false when file not found', async () => {
      (vscode.workspace.fs.stat as any).mockRejectedValue(new Error('Not found'));

      const result = await manager.applyCodeDirectlyForAutoMode('nonexistent.ts', 'code');

      expect(result).toBe(false);

      // Restore stat mock for subsequent tests
      (vscode.workspace.fs.stat as any).mockResolvedValue({});
    });

    it('should track resolved diff', async () => {
      (vscode.workspace.fs.stat as any).mockResolvedValue({});
      const mockDoc = {
        uri: { toString: () => 'file:///workspace/src/app.ts', scheme: 'file' },
        getText: () => 'old',
        positionAt: (o: number) => ({ line: 0, character: o }),
        save: vi.fn(async () => true),
      };
      (vscode.workspace.openTextDocument as any).mockResolvedValue(mockDoc);

      await manager.applyCodeDirectlyForAutoMode('src/app.ts', 'new');

      expect(manager.getFileChanges().length).toBeGreaterThan(0);
      expect(manager.getFileChanges()[0].status).toBe('applied');
    });

    it('should skip notification when skipNotification is true', async () => {
      (vscode.workspace.fs.stat as any).mockResolvedValue({});
      const autoAppliedEvents: DiffListChangedEvent[] = [];
      manager.onAutoAppliedFilesChanged(e => autoAppliedEvents.push(e));

      const mockDoc = {
        uri: { toString: () => 'file:///workspace/src/app.ts', scheme: 'file' },
        getText: () => 'old',
        positionAt: (o: number) => ({ line: 0, character: o }),
        save: vi.fn(async () => true),
      };
      (vscode.workspace.openTextDocument as any).mockResolvedValue(mockDoc);

      await manager.applyCodeDirectlyForAutoMode('src/app.ts', 'new', 'desc', true);

      expect(autoAppliedEvents).toHaveLength(0);
    });

    it('should increment iteration for same file', async () => {
      (vscode.workspace.fs.stat as any).mockResolvedValue({});
      const mockDoc = {
        uri: { toString: () => 'file:///workspace/src/app.ts', scheme: 'file' },
        getText: () => 'old',
        positionAt: (o: number) => ({ line: 0, character: o }),
        save: vi.fn(async () => true),
      };
      (vscode.workspace.openTextDocument as any).mockResolvedValue(mockDoc);

      await manager.applyCodeDirectlyForAutoMode('src/app.ts', 'v1');
      await manager.applyCodeDirectlyForAutoMode('src/app.ts', 'v2');

      const changes = manager.getFileChanges();
      expect(changes).toHaveLength(2);
      expect(changes[0].iteration).toBe(1);
      expect(changes[1].iteration).toBe(2);
    });

    it('should fire onWarning when diff engine reports issues', async () => {
      // Re-create manager with a failing diff engine (clearAllMocks resets the diffEngine mock)
      const { manager: m, diffEngine: de } = createManager();
      de.applyChanges.mockReturnValue({
        content: 'new',
        success: false,
        message: 'No matching code found',
      });

      (vscode.workspace.fs.stat as any).mockResolvedValue({});

      const warnings: Array<{ message: string }> = [];
      m.onWarning(e => warnings.push(e));

      const mockDoc = {
        uri: { toString: () => 'file:///workspace/src/app.ts', scheme: 'file' },
        getText: () => 'old',
        positionAt: (o: number) => ({ line: 0, character: o }),
        save: vi.fn(async () => true),
      };
      (vscode.workspace.openTextDocument as any).mockResolvedValue(mockDoc);

      await m.applyCodeDirectlyForAutoMode('src/app.ts', 'code');

      expect(warnings).toHaveLength(1);
      expect(warnings[0].message).toContain('No matching code found');
      m.dispose();
    });
  });

  // ── handleCodeBlockDetection ──

  describe('handleCodeBlockDetection', () => {
    it('should not throw on empty response', () => {
      expect(() => manager.handleCodeBlockDetection('')).not.toThrow();
    });

    it('should not throw on response without code blocks', () => {
      expect(() => manager.handleCodeBlockDetection('Here is some plain text.')).not.toThrow();
    });

    it('should detect code blocks with file headers', () => {
      const { manager: askManager } = createManager('ask');
      // Code block with file header should be detected
      const response = '```typescript\n# File: src/main.ts\nconst x = 1;\n```';
      expect(() => askManager.handleCodeBlockDetection(response)).not.toThrow();
      askManager.dispose();
    });

    it('should deduplicate processed code blocks', () => {
      const { manager: askManager } = createManager('ask');
      const response = '```typescript\n# File: src/main.ts\nconst x = 1;\n```';

      // Call twice with same response
      askManager.handleCodeBlockDetection(response);
      askManager.handleCodeBlockDetection(response);

      // Should not throw or error
      askManager.dispose();
    });
  });

  // ── handleAutoShowDiff ──

  describe('handleAutoShowDiff', () => {
    it('should fire onEditConfirm for ask mode with file header', async () => {
      const { manager: askManager, diffEngine: de } = createManager('ask');
      const editConfirmEvents: Array<{ filePath: string; code: string; language: string }> = [];
      askManager.onEditConfirm(e => editConfirmEvents.push(e));

      const mockDoc = {
        uri: { toString: () => 'file:///workspace/src/main.ts', scheme: 'file', fsPath: '/workspace/src/main.ts' },
        getText: () => 'original',
        fileName: '/workspace/src/main.ts',
        positionAt: (o: number) => ({ line: 0, character: o }),
        offsetAt: () => 0,
      };
      (vscode.workspace.openTextDocument as any).mockResolvedValue(mockDoc);

      await askManager.handleAutoShowDiff('# File: src/main.ts\nconst x = 1;', 'typescript');

      expect(editConfirmEvents).toHaveLength(1);
      expect(editConfirmEvents[0].filePath).toBe('src/main.ts');
      askManager.dispose();
    });

    it('should use fileContextManager.resolveFilePath when no file header', async () => {
      const { manager: askManager, fileContextManager: fcm } = createManager('ask');
      fcm.resolveFilePath.mockResolvedValue('src/resolved.ts');

      const mockDoc = {
        uri: { toString: () => 'file:///workspace/src/resolved.ts', scheme: 'file', fsPath: '/workspace/src/resolved.ts' },
        getText: () => 'original',
        fileName: '/workspace/src/resolved.ts',
        positionAt: (o: number) => ({ line: 0, character: o }),
        offsetAt: () => 0,
      };
      (vscode.workspace.openTextDocument as any).mockResolvedValue(mockDoc);

      await askManager.handleAutoShowDiff('const x = 1;', 'typescript');

      expect(fcm.resolveFilePath).toHaveBeenCalledWith('const x = 1;', 'typescript');
      askManager.dispose();
    });

    it('should fire onWarning when file path cannot be resolved', async () => {
      const { manager: askManager, fileContextManager: fcm } = createManager('ask');
      fcm.resolveFilePath.mockResolvedValue(null);

      const warnings: Array<{ message: string }> = [];
      askManager.onWarning(e => warnings.push(e));

      await askManager.handleAutoShowDiff('const x = 1;', 'typescript');

      expect(warnings.length).toBeGreaterThanOrEqual(1);
      askManager.dispose();
    });
  });

  // ── handleDebouncedDiff ──

  describe('handleDebouncedDiff', () => {
    it('should not throw', () => {
      expect(() => manager.handleDebouncedDiff('# File: test.ts\ncode', 'typescript')).not.toThrow();
      manager.clearPendingDiffs(); // clean up timer
    });

    it('should replace existing pending diff for same file', () => {
      manager.handleDebouncedDiff('# File: test.ts\nv1', 'typescript');
      manager.handleDebouncedDiff('# File: test.ts\nv2', 'typescript');
      // Should not throw
      manager.clearPendingDiffs(); // clean up timers
    });
  });

  // ── detectAndProcessUnfencedEdits ──

  describe('detectAndProcessUnfencedEdits', () => {
    it('should return early without SEARCH/REPLACE markers', async () => {
      await expect(manager.detectAndProcessUnfencedEdits('plain text')).resolves.not.toThrow();
    });

    it('should return early when markers are inside code fences', async () => {
      const content = '```\n# File: test.ts\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE\n```';
      await expect(manager.detectAndProcessUnfencedEdits(content)).resolves.not.toThrow();
    });
  });

  // ── showDiffQuickPick ──

  describe('showDiffQuickPick', () => {
    it('should show info message when no active diffs', async () => {
      await manager.showDiffQuickPick();
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('No pending diffs');
    });
  });

  // ── acceptSpecificDiff ──

  describe('acceptSpecificDiff', () => {
    it('should warn when diff not found', async () => {
      await manager.acceptSpecificDiff('nonexistent-id');
      // Should log a warning but not throw
    });
  });

  // ── rejectSpecificDiff ──

  describe('rejectSpecificDiff', () => {
    it('should warn when diff not found', async () => {
      await manager.rejectSpecificDiff('nonexistent-id');
      // Should log a warning but not throw
    });
  });

  // ── acceptAllDiffs ──

  describe('acceptAllDiffs', () => {
    it('should handle empty active diffs', async () => {
      await expect(manager.acceptAllDiffs()).resolves.not.toThrow();
    });
  });

  // ── rejectAllDiffs ──

  describe('rejectAllDiffs', () => {
    it('should handle empty active diffs', async () => {
      await expect(manager.rejectAllDiffs()).resolves.not.toThrow();
    });
  });

  // ── closeDiff ──

  describe('closeDiff', () => {
    it('should handle no active diffs', async () => {
      await expect(manager.closeDiff()).resolves.not.toThrow();
    });
  });

  // ── focusSpecificDiff ──

  describe('focusSpecificDiff', () => {
    it('should warn when diff not found', async () => {
      await manager.focusSpecificDiff('nonexistent-id');
      // Should log warning but not throw
    });
  });

  // ── focusFileOrDiff ──

  describe('focusFileOrDiff', () => {
    it('should open file when diff not found', async () => {
      const mockDoc = {
        uri: { toString: () => 'file:///workspace/src/app.ts', scheme: 'file' },
      };
      (vscode.workspace.openTextDocument as any).mockResolvedValue(mockDoc);

      await manager.focusFileOrDiff(undefined, 'src/app.ts');

      expect(vscode.workspace.openTextDocument).toHaveBeenCalled();
    });

    it('should warn when no diffId or filePath provided', async () => {
      await manager.focusFileOrDiff(undefined, undefined);
      // Should log warning
    });
  });

  // ── openFile ──

  describe('openFile', () => {
    it('should open file in editor', async () => {
      const mockDoc = {
        uri: { toString: () => 'file:///workspace/src/app.ts', scheme: 'file' },
      };
      (vscode.workspace.openTextDocument as any).mockResolvedValue(mockDoc);

      await manager.openFile('src/app.ts');

      expect(vscode.window.showTextDocument).toHaveBeenCalled();
    });

    it('should warn on empty file path', async () => {
      await manager.openFile('');
      expect(vscode.window.showTextDocument).not.toHaveBeenCalled();
    });

    it('should handle missing workspace folder', async () => {
      const origFolders = (vscode.workspace as any).workspaceFolders;
      (vscode.workspace as any).workspaceFolders = undefined;

      await manager.openFile('src/app.ts');
      // Should not throw

      (vscode.workspace as any).workspaceFolders = origFolders;
    });
  });

  // ── showDiff ──

  describe('showDiff', () => {
    it('should create diff for file with header', async () => {
      const diffEvents: DiffListChangedEvent[] = [];
      manager.onDiffListChanged(e => diffEvents.push(e));

      const mockDoc = {
        uri: { toString: () => 'file:///workspace/src/main.ts', scheme: 'file', fsPath: '/workspace/src/main.ts' },
        getText: () => 'original content',
        fileName: '/workspace/src/main.ts',
        positionAt: (o: number) => ({ line: 0, character: o }),
        offsetAt: (pos: any) => pos.character || 0,
      };
      (vscode.workspace.openTextDocument as any).mockResolvedValue(mockDoc);

      await manager.showDiff('# File: src/main.ts\nconst x = 1;', 'typescript');

      expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
        'vscode.diff',
        expect.anything(),
        expect.anything(),
        expect.stringContaining('main.ts'),
        expect.anything()
      );
      expect(diffEvents).toHaveLength(1);
    });

    it('should track iteration for same file', async () => {
      const mockDoc = {
        uri: { toString: () => 'file:///workspace/src/main.ts', scheme: 'file', fsPath: '/workspace/src/main.ts' },
        getText: () => 'original content',
        fileName: '/workspace/src/main.ts',
        positionAt: (o: number) => ({ line: 0, character: o }),
        offsetAt: (pos: any) => pos.character || 0,
      };
      (vscode.workspace.openTextDocument as any).mockResolvedValue(mockDoc);

      await manager.showDiff('# File: src/main.ts\nv1', 'typescript');
      await manager.showDiff('# File: src/main.ts\nv2', 'typescript');

      // Second call should have iteration 2 in the title
      const calls = (vscode.commands.executeCommand as any).mock.calls;
      const lastDiffCall = calls[calls.length - 1];
      expect(lastDiffCall[3]).toContain('(2)');
    });

    it('should fire onWarning when no workspace folder', async () => {
      const origFolders = (vscode.workspace as any).workspaceFolders;
      (vscode.workspace as any).workspaceFolders = undefined;

      const warnings: Array<{ message: string }> = [];
      manager.onWarning(e => warnings.push(e));

      await manager.showDiff('# File: src/main.ts\ncode', 'typescript');

      expect(warnings).toHaveLength(1);
      expect(warnings[0].message).toContain('No workspace folder');

      (vscode.workspace as any).workspaceFolders = origFolders;
    });
  });

  // ── applyCode ──

  describe('applyCode', () => {
    it('should fire onCodeApplied on success', async () => {
      const events: CodeAppliedEvent[] = [];
      manager.onCodeApplied(e => events.push(e));

      // Set up active text editor with a file scheme
      const mockEditor = {
        document: {
          uri: { toString: () => 'file:///workspace/test.ts', scheme: 'file' },
          getText: () => 'old content',
          positionAt: (o: number) => ({ line: 0, character: o }),
        },
        selection: { isEmpty: true },
        edit: vi.fn(async (cb: any) => {
          cb({ replace: vi.fn() });
          return true;
        }),
      };
      (vscode.window as any).activeTextEditor = mockEditor;

      await manager.applyCode('new content', 'typescript');

      expect(events).toHaveLength(1);
      expect(events[0].success).toBe(true);

      (vscode.window as any).activeTextEditor = undefined;
    });
  });

  // ── Blocking Ask Mode Approval ──

  describe('blocking ask mode approval', () => {
    let askManager: DiffManager;

    beforeEach(() => {
      const result = createManager('ask');
      askManager = result.manager;
    });

    afterEach(() => {
      askManager.dispose();
    });

    describe('waitForPendingApprovals', () => {
      it('should return empty array when no pending approvals', async () => {
        const results = await askManager.waitForPendingApprovals();
        expect(results).toEqual([]);
      });

      it('should wait for approval and resolve when accepted', async () => {
        // Access private pendingApprovals via any
        const mgr = askManager as any;

        // Register a pending approval
        mgr.registerPendingApproval('diff-1', 'src/test.ts');

        // Start waiting (non-blocking setup)
        const waitPromise = askManager.waitForPendingApprovals();

        // Simulate acceptance by resolving the pending approval
        const pending = mgr.pendingApprovals.get('diff-1');
        expect(pending).toBeDefined();
        pending.resolve({ filePath: 'src/test.ts', diffId: 'diff-1', approved: true });

        const results = await waitPromise;
        expect(results).toHaveLength(1);
        expect(results[0]).toEqual({ filePath: 'src/test.ts', diffId: 'diff-1', approved: true });
      });

      it('should wait for approval and resolve when rejected', async () => {
        const mgr = askManager as any;
        mgr.registerPendingApproval('diff-2', 'src/foo.ts');

        const waitPromise = askManager.waitForPendingApprovals();

        const pending = mgr.pendingApprovals.get('diff-2');
        pending.resolve({ filePath: 'src/foo.ts', diffId: 'diff-2', approved: false });

        const results = await waitPromise;
        expect(results).toHaveLength(1);
        expect(results[0].approved).toBe(false);
      });

      it('should wait for multiple approvals', async () => {
        const mgr = askManager as any;
        mgr.registerPendingApproval('diff-a', 'src/a.ts');
        mgr.registerPendingApproval('diff-b', 'src/b.ts');

        const waitPromise = askManager.waitForPendingApprovals();

        // Resolve both
        const pendingA = mgr.pendingApprovals.get('diff-a');
        const pendingB = mgr.pendingApprovals.get('diff-b');
        pendingA.resolve({ filePath: 'src/a.ts', diffId: 'diff-a', approved: true });
        pendingB.resolve({ filePath: 'src/b.ts', diffId: 'diff-b', approved: false });

        const results = await waitPromise;
        expect(results).toHaveLength(2);
        expect(results.find(r => r.filePath === 'src/a.ts')?.approved).toBe(true);
        expect(results.find(r => r.filePath === 'src/b.ts')?.approved).toBe(false);
      });

      it('should fire onWaitingForApproval event', async () => {
        const mgr = askManager as any;
        const spy = vi.fn();
        askManager.onWaitingForApproval(spy);

        mgr.registerPendingApproval('diff-1', 'src/test.ts');
        const waitPromise = askManager.waitForPendingApprovals();

        expect(spy).toHaveBeenCalledWith({ filePaths: ['src/test.ts'] });

        // Resolve to unblock
        mgr.pendingApprovals.get('diff-1').resolve({ filePath: 'src/test.ts', diffId: 'diff-1', approved: true });
        await waitPromise;
      });
    });

    describe('cancelPendingApprovals', () => {
      it('should resolve all pending approvals as rejected', async () => {
        const mgr = askManager as any;
        mgr.registerPendingApproval('diff-1', 'src/a.ts');
        mgr.registerPendingApproval('diff-2', 'src/b.ts');

        const waitPromise = askManager.waitForPendingApprovals();

        // Cancel all
        askManager.cancelPendingApprovals();

        const results = await waitPromise;
        expect(results).toHaveLength(2);
        expect(results.every(r => r.approved === false)).toBe(true);
      });

      it('should clear pending approvals map', () => {
        const mgr = askManager as any;
        mgr.registerPendingApproval('diff-1', 'src/a.ts');
        askManager.cancelPendingApprovals();
        expect(mgr.pendingApprovals.size).toBe(0);
      });
    });

    describe('registerPendingApproval (superseded diffs)', () => {
      it('should auto-reject previous approval for same file', async () => {
        const mgr = askManager as any;

        // Register first approval for src/test.ts
        mgr.registerPendingApproval('diff-old', 'src/test.ts');
        const waitPromise1 = new Promise<any>((resolve) => {
          mgr.pendingApprovals.get('diff-old').resolve = resolve;
        });

        // Register second approval for same file — should auto-reject the old one
        mgr.registerPendingApproval('diff-new', 'src/test.ts');

        const oldResult = await waitPromise1;
        expect(oldResult.approved).toBe(false);
        expect(oldResult.diffId).toBe('diff-old');

        // Only the new approval should remain
        expect(mgr.pendingApprovals.size).toBe(1);
        expect(mgr.pendingApprovals.has('diff-new')).toBe(true);
      });

      it('should not affect approvals for different files', () => {
        const mgr = askManager as any;
        mgr.registerPendingApproval('diff-1', 'src/a.ts');
        mgr.registerPendingApproval('diff-2', 'src/b.ts');
        expect(mgr.pendingApprovals.size).toBe(2);
      });
    });

    describe('clearPendingDiffs cancels approvals', () => {
      it('should cancel pending approvals when clearing diffs', async () => {
        const mgr = askManager as any;
        mgr.registerPendingApproval('diff-1', 'src/test.ts');

        const waitPromise = askManager.waitForPendingApprovals();

        askManager.clearPendingDiffs();

        const results = await waitPromise;
        expect(results).toHaveLength(1);
        expect(results[0].approved).toBe(false);
      });
    });
  });

  // ── dispose ──

  describe('dispose', () => {
    it('should dispose all emitters without error', () => {
      expect(() => manager.dispose()).not.toThrow();
    });

    it('should dispose status bar item', () => {
      // Create fresh manager to test dispose
      const { manager: m } = createManager();
      m.dispose();
      // Should not throw on second dispose
      expect(() => m.dispose()).not.toThrow();
    });
  });
});
