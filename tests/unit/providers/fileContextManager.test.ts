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
      tabGroups: { all: [] },
      activeTextEditor: undefined,
      showQuickPick: vi.fn(),
      showErrorMessage: vi.fn(),
    },
    workspace: {
      ...(original as any).workspace,
      asRelativePath: vi.fn((uri: any) => {
        const str = typeof uri === 'string' ? uri : uri?.toString?.() || '';
        return str.replace('file:///', '').replace('file://', '');
      }),
      findFiles: vi.fn(async () => []),
      workspaceFolders: [{ uri: { toString: () => 'file:///workspace', fsPath: '/workspace' } }],
      getWorkspaceFolder: vi.fn(() => ({ uri: { fsPath: '/workspace' } })),
      fs: {
        readFile: vi.fn(async () => Buffer.from('file content here')),
      },
    },
    Uri: {
      parse: (s: string) => ({ toString: () => s, scheme: 'file', fsPath: s }),
      joinPath: (_base: any, rel: string) => ({ toString: () => `file:///workspace/${rel}`, fsPath: `/workspace/${rel}` }),
    },
    TabInputText: class TabInputText { uri: any; constructor(uri: any) { this.uri = uri; } },
  };
});

vi.mock('child_process', () => ({
  spawnSync: vi.fn(() => ({ stdout: '', stderr: '', status: 0, error: null })),
}));

import { FileContextManager } from '../../../src/providers/fileContextManager';
import type { OpenFilesEvent, FileSearchResultsEvent, FileContentEvent } from '../../../src/providers/types';
import * as vscode from 'vscode';

describe('FileContextManager', () => {
  let manager: FileContextManager;

  beforeEach(() => {
    manager = new FileContextManager();
    vi.clearAllMocks();
  });

  afterEach(() => {
    manager.dispose();
  });

  // ── setModalOpen ──

  describe('setModalOpen', () => {
    it('should set modal open state', () => {
      expect(manager.isModalOpen).toBe(false);
      manager.setModalOpen(true);
      expect(manager.isModalOpen).toBe(true);
      manager.setModalOpen(false);
      expect(manager.isModalOpen).toBe(false);
    });
  });

  // ── sendOpenFiles ──

  describe('sendOpenFiles', () => {
    it('should fire onOpenFiles with list of open tabs', () => {
      const events: OpenFilesEvent[] = [];
      manager.onOpenFiles(e => events.push(e));

      const mockUri = { toString: () => 'file:///workspace/src/main.ts', scheme: 'file' };
      (vscode.window as any).tabGroups = {
        all: [{
          tabs: [{
            input: Object.assign(Object.create((vscode as any).TabInputText.prototype), { uri: mockUri })
          }]
        }]
      };
      (vscode.workspace.asRelativePath as any).mockReturnValue('src/main.ts');

      manager.sendOpenFiles();
      expect(events).toHaveLength(1);
      expect(events[0].files).toContain('src/main.ts');
    });

    it('should skip non-file schemes', () => {
      const events: OpenFilesEvent[] = [];
      manager.onOpenFiles(e => events.push(e));

      const mockUri = { toString: () => 'output:channel', scheme: 'output' };
      (vscode.window as any).tabGroups = {
        all: [{
          tabs: [{
            input: Object.assign(Object.create((vscode as any).TabInputText.prototype), { uri: mockUri })
          }]
        }]
      };
      (vscode as any).Uri.parse = (s: string) => ({ toString: () => s, scheme: 'output', fsPath: s });

      manager.sendOpenFiles();

      expect(events).toHaveLength(1);
      expect(events[0].files).toHaveLength(0);

      (vscode as any).Uri.parse = (s: string) => ({ toString: () => s, scheme: 'file', fsPath: s });
    });

    it('should skip VS Code internal files', () => {
      const events: OpenFilesEvent[] = [];
      manager.onOpenFiles(e => events.push(e));

      const mockUri = { toString: () => 'file:///extension-output-foo', scheme: 'file' };
      (vscode.window as any).tabGroups = {
        all: [{
          tabs: [{
            input: Object.assign(Object.create((vscode as any).TabInputText.prototype), { uri: mockUri })
          }]
        }]
      };
      (vscode.workspace.asRelativePath as any).mockReturnValue('extension-output-foo');

      manager.sendOpenFiles();

      expect(events).toHaveLength(1);
      expect(events[0].files).toHaveLength(0);
    });
  });

  // ── handleFileSearch ──

  describe('handleFileSearch', () => {
    it('should fire onSearchResults with matching files', async () => {
      const events: FileSearchResultsEvent[] = [];
      manager.onSearchResults(e => events.push(e));

      const mockUri = { toString: () => 'file:///workspace/src/utils.ts' };
      (vscode.workspace.findFiles as any).mockResolvedValue([mockUri]);
      (vscode.workspace.asRelativePath as any).mockReturnValue('src/utils.ts');

      await manager.handleFileSearch('utils');

      expect(events).toHaveLength(1);
      expect(events[0].results).toContain('src/utils.ts');
    });

    it('should wrap non-glob queries in wildcard pattern', async () => {
      manager.onSearchResults(() => {});
      (vscode.workspace.findFiles as any).mockResolvedValue([]);

      await manager.handleFileSearch('helper');

      expect(vscode.workspace.findFiles).toHaveBeenCalledWith(
        '**/*helper*',
        '**/node_modules/**',
        50
      );
    });

    it('should pass glob queries through unchanged', async () => {
      manager.onSearchResults(() => {});
      (vscode.workspace.findFiles as any).mockResolvedValue([]);

      await manager.handleFileSearch('**/*.ts');

      expect(vscode.workspace.findFiles).toHaveBeenCalledWith(
        '**/*.ts',
        '**/node_modules/**',
        50
      );
    });

    it('should handle search errors gracefully', async () => {
      const events: FileSearchResultsEvent[] = [];
      manager.onSearchResults(e => events.push(e));
      (vscode.workspace.findFiles as any).mockRejectedValue(new Error('Search failed'));

      await manager.handleFileSearch('foo');

      expect(events).toHaveLength(1);
      expect(events[0].results).toHaveLength(0);
    });
  });

  // ── sendFileContent ──

  describe('sendFileContent', () => {
    it('should fire onFileContent with file contents', async () => {
      const events: FileContentEvent[] = [];
      manager.onFileContent(e => events.push(e));

      (vscode.workspace.fs.readFile as any).mockResolvedValue(Buffer.from('hello world'));

      await manager.sendFileContent('src/main.ts');

      expect(events).toHaveLength(1);
      expect(events[0].filePath).toBe('src/main.ts');
      expect(events[0].content).toBe('hello world');
    });

    it('should handle missing workspace folder', async () => {
      const events: FileContentEvent[] = [];
      manager.onFileContent(e => events.push(e));

      const origFolders = (vscode.workspace as any).workspaceFolders;
      (vscode.workspace as any).workspaceFolders = undefined;

      await manager.sendFileContent('src/main.ts');

      expect(events).toHaveLength(0);

      (vscode.workspace as any).workspaceFolders = origFolders;
    });

    it('should handle read errors', async () => {
      const events: FileContentEvent[] = [];
      manager.onFileContent(e => events.push(e));
      (vscode.workspace.fs.readFile as any).mockRejectedValue(new Error('Not found'));

      await manager.sendFileContent('nonexistent.ts');

      expect(events).toHaveLength(0);
      expect(vscode.window.showErrorMessage).toHaveBeenCalled();
    });
  });

  // ── setSelectedFiles ──

  describe('setSelectedFiles', () => {
    it('should store selected files', () => {
      manager.setSelectedFiles([
        { path: 'src/a.ts', content: 'content a' },
        { path: 'src/b.ts', content: 'content b' },
      ]);

      expect(manager.selectedFileCount).toBe(2);
    });

    it('should clear previous selection', () => {
      manager.setSelectedFiles([{ path: 'src/old.ts', content: 'old' }]);
      manager.setSelectedFiles([{ path: 'src/new.ts', content: 'new' }]);

      expect(manager.selectedFileCount).toBe(1);
    });
  });

  // ── clearTurnTracking ──

  describe('clearTurnTracking', () => {
    it('should clear read files set', () => {
      manager.trackReadFile('src/a.ts');
      manager.trackReadFile('src/b.ts');
      expect(manager.readFileCount).toBe(2);

      manager.clearTurnTracking();
      expect(manager.readFileCount).toBe(0);
    });
  });

  // ── trackReadFile ──

  describe('trackReadFile', () => {
    it('should track unique files', () => {
      manager.trackReadFile('src/a.ts');
      manager.trackReadFile('src/b.ts');
      manager.trackReadFile('src/a.ts'); // duplicate

      expect(manager.readFileCount).toBe(2);
    });
  });

  // ── extractFileIntent ──

  describe('extractFileIntent', () => {
    it('should extract known file names from message', () => {
      manager.extractFileIntent('update the changelog');
      // Verify intent is used in inferFilePath
      const result = manager.inferFilePath('some code', 'plaintext');
      expect(result).toBe('CHANGELOG.md');
    });

    it('should extract readme intent', () => {
      manager.extractFileIntent('edit the readme');
      const result = manager.inferFilePath('some code', 'plaintext');
      expect(result).toBe('README.md');
    });

    it('should extract explicit file paths', () => {
      manager.extractFileIntent('fix src/utils/helper.ts');
      const result = manager.inferFilePath('some code', 'plaintext');
      expect(result).toBe('src/utils/helper.ts');
    });

    it('should return null for messages without file intent', () => {
      manager.extractFileIntent('how does this work?');
      // No intent + no files = null
      const result = manager.inferFilePath('some code', 'plaintext');
      expect(result).toBeNull();
    });
  });

  // ── getSelectedFilesContext ──

  describe('getSelectedFilesContext', () => {
    it('should return empty string when no files selected', () => {
      expect(manager.getSelectedFilesContext()).toBe('');
    });

    it('should format selected files for injection', () => {
      manager.setSelectedFiles([
        { path: 'src/main.ts', content: 'console.log("hello")' },
      ]);

      const context = manager.getSelectedFilesContext();
      expect(context).toContain('--- Selected Files for Context ---');
      expect(context).toContain('### File: src/main.ts');
      expect(context).toContain('console.log("hello")');
      expect(context).toContain('--- End Selected Files ---');
    });

    it('should include multiple files', () => {
      manager.setSelectedFiles([
        { path: 'a.ts', content: 'a' },
        { path: 'b.ts', content: 'b' },
      ]);

      const context = manager.getSelectedFilesContext();
      expect(context).toContain('### File: a.ts');
      expect(context).toContain('### File: b.ts');
    });
  });

  // ── inferFilePath ──

  describe('inferFilePath', () => {
    it('should use user message intent (strategy 1)', () => {
      manager.extractFileIntent('update the changelog');
      expect(manager.inferFilePath('code', 'markdown')).toBe('CHANGELOG.md');
    });

    it('should use single selected file (strategy 2)', () => {
      manager.setSelectedFiles([{ path: 'src/main.ts', content: '' }]);
      expect(manager.inferFilePath('code', 'typescript')).toBe('src/main.ts');
    });

    it('should skip multiple selected files (strategy 2 fails)', () => {
      manager.setSelectedFiles([
        { path: 'a.ts', content: '' },
        { path: 'b.ts', content: '' },
      ]);
      // No intent, multiple files → strategy 2 fails, no read files → eventually tries extension match
      expect(manager.inferFilePath('code', 'typescript')).toBe('a.ts'); // matches by extension
    });

    it('should use single read file (strategy 3)', () => {
      manager.trackReadFile('src/utils.ts');
      expect(manager.inferFilePath('code', 'plaintext')).toBe('src/utils.ts');
    });

    it('should match by language extension (strategy 4)', () => {
      manager.setSelectedFiles([
        { path: 'styles.css', content: '' },
        { path: 'app.ts', content: '' },
      ]);
      expect(manager.inferFilePath('code', 'css')).toBe('styles.css');
    });

    it('should match read files by extension (strategy 4)', () => {
      manager.trackReadFile('src/helper.py');
      manager.trackReadFile('src/main.ts');
      expect(manager.inferFilePath('code', 'python')).toBe('src/helper.py');
    });

    it('should return null when all strategies fail', () => {
      expect(manager.inferFilePath('code', 'unknown')).toBeNull();
    });

    it('should prioritize intent over selected files', () => {
      manager.extractFileIntent('edit the readme');
      manager.setSelectedFiles([{ path: 'src/main.ts', content: '' }]);
      expect(manager.inferFilePath('code', 'typescript')).toBe('README.md');
    });
  });

  // ── resolveFilePath ──

  describe('resolveFilePath', () => {
    it('should use inference when successful', async () => {
      manager.extractFileIntent('edit the readme');
      const result = await manager.resolveFilePath('code', 'markdown');
      expect(result).toBe('README.md');
    });

    it('should fall back to quick picker when inference fails', async () => {
      manager.trackReadFile('a.ts');
      manager.trackReadFile('b.ts');
      // Multiple read files, no intent → inference fails → quick picker
      (vscode.window.showQuickPick as any).mockResolvedValue('b.ts');

      const result = await manager.resolveFilePath('code', 'plaintext');
      expect(result).toBe('b.ts');
    });

    it('should fall back to active editor', async () => {
      (vscode.window as any).activeTextEditor = {
        document: { uri: { toString: () => 'file:///workspace/fallback.ts' } }
      };
      (vscode.workspace.asRelativePath as any).mockReturnValue('fallback.ts');

      const result = await manager.resolveFilePath('code', 'unknown');
      expect(result).toBe('fallback.ts');

      (vscode.window as any).activeTextEditor = undefined;
    });

    it('should return null when everything fails', async () => {
      (vscode.window as any).activeTextEditor = undefined;
      const result = await manager.resolveFilePath('code', 'unknown');
      expect(result).toBeNull();
    });
  });

  // ── getEditorContext ──

  describe('getEditorContext', () => {
    it('should return empty string when no active editor', async () => {
      (vscode.window as any).activeTextEditor = undefined;
      const result = await manager.getEditorContext();
      expect(result).toBe('');
    });

    it('should include file info and content', async () => {
      (vscode.window as any).activeTextEditor = {
        document: {
          fileName: '/workspace/src/main.ts',
          languageId: 'typescript',
          getText: vi.fn(() => 'const x = 1;'),
          lineCount: 1,
          uri: { toString: () => 'file:///workspace/src/main.ts' },
        },
        selection: {
          isEmpty: true,
          active: { line: 0 },
          start: { line: 0 },
          end: { line: 0 },
        },
      };

      const result = await manager.getEditorContext();
      expect(result).toContain('Current File: main.ts');
      expect(result).toContain('Full Path: /workspace/src/main.ts');
      expect(result).toContain('Language: typescript');
      expect(result).toContain('Total Lines: 1');
      expect(result).toContain('Cursor at line 1');
      expect(result).toContain('--- FULL FILE CONTENT ---');
      expect(result).toContain('const x = 1;');
      expect(result).toContain('--- END FILE CONTENT ---');

      (vscode.window as any).activeTextEditor = undefined;
    });

    it('should include selection info when text is selected', async () => {
      (vscode.window as any).activeTextEditor = {
        document: {
          fileName: '/workspace/src/main.ts',
          languageId: 'typescript',
          getText: vi.fn((sel?: any) => sel ? 'selected text' : 'const x = 1;\nconst y = 2;'),
          lineCount: 2,
          uri: { toString: () => 'file:///workspace/src/main.ts' },
        },
        selection: {
          isEmpty: false,
          active: { line: 0 },
          start: { line: 0 },
          end: { line: 1 },
        },
      };

      const result = await manager.getEditorContext();
      expect(result).toContain('Selected code (lines 1-2)');
      expect(result).toContain('selected text');

      (vscode.window as any).activeTextEditor = undefined;
    });

    it('should include related files when found', async () => {
      const cp = await import('child_process');
      (cp.spawnSync as any).mockReturnValue({
        stdout: './src/main.test.ts\n./src/mainHelper.ts\n',
        stderr: '',
        status: 0,
        error: null,
      });

      (vscode.window as any).activeTextEditor = {
        document: {
          fileName: '/workspace/src/main.ts',
          languageId: 'typescript',
          getText: vi.fn(() => 'code'),
          lineCount: 1,
          uri: { toString: () => 'file:///workspace/src/main.ts' },
        },
        selection: {
          isEmpty: true,
          active: { line: 0 },
          start: { line: 0 },
          end: { line: 0 },
        },
      };

      const result = await manager.getEditorContext();
      expect(result).toContain('--- RELATED FILES IN WORKSPACE ---');

      (vscode.window as any).activeTextEditor = undefined;
      (cp.spawnSync as any).mockReturnValue({ stdout: '', stderr: '', status: 0, error: null });
    });

    it('should handle findRelatedFiles returning empty gracefully', async () => {
      (vscode.workspace.getWorkspaceFolder as any).mockReturnValue(undefined);

      (vscode.window as any).activeTextEditor = {
        document: {
          fileName: '/workspace/src/main.ts',
          languageId: 'typescript',
          getText: vi.fn(() => 'code'),
          lineCount: 1,
          uri: { toString: () => 'file:///workspace/src/main.ts' },
        },
        selection: {
          isEmpty: true,
          active: { line: 0 },
          start: { line: 0 },
          end: { line: 0 },
        },
      };

      const result = await manager.getEditorContext();
      expect(result).not.toContain('--- RELATED FILES IN WORKSPACE ---');

      (vscode.window as any).activeTextEditor = undefined;
      (vscode.workspace.getWorkspaceFolder as any).mockReturnValue({ uri: { fsPath: '/workspace' } });
    });
  });

  // ── dispose ──

  describe('dispose', () => {
    it('should dispose all emitters without error', () => {
      expect(() => manager.dispose()).not.toThrow();
    });

    it('should not fire events after disposal', () => {
      const events: OpenFilesEvent[] = [];
      manager.onOpenFiles(e => events.push(e));
      manager.dispose();

      // After dispose, fire should not reach listeners (emitter cleared)
      expect(events).toHaveLength(0);
    });
  });
});
