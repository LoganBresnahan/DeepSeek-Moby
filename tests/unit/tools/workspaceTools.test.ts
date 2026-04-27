/**
 * Unit tests for workspaceTools
 *
 * Tests the tool definitions array, executeToolCall dispatch, and individual
 * tool handlers (readFile, searchFiles, listDirectory, etc.).
 * Mocks fs, child_process, and vscode workspace APIs.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mock state ──────────────────────────────────────────────

const { mockFs, mockCp } = vi.hoisted(() => ({
  mockFs: {
    existsSync: vi.fn(() => true),
    statSync: vi.fn(() => ({
      isDirectory: () => false,
      isFile: () => true,
      size: 100,
      mtime: new Date('2026-01-15T00:00:00Z')
    })),
    readFileSync: vi.fn(() => 'line1\nline2\nline3\nline4\nline5'),
    readdirSync: vi.fn(() => [])
  },
  mockCp: {
    spawnSync: vi.fn(() => ({
      stdout: '',
      stderr: '',
      status: 0
    }))
  }
}));

// ── Module mocks ────────────────────────────────────────────────────

vi.mock('fs', () => ({
  default: mockFs,
  ...mockFs
}));

vi.mock('child_process', () => ({
  default: mockCp,
  ...mockCp
}));

// Use real path (it's pure computation, no side effects)
vi.mock('path', async () => {
  // Use posix path for consistent cross-platform test behavior
  const posix = await vi.importActual<typeof import('path')>('path');
  return {
    ...posix,
    default: posix,
    join: (...args: string[]) => posix.join(...args),
    resolve: (...args: string[]) => posix.resolve(...args),
    relative: (from: string, to: string) => posix.relative(from, to),
    isAbsolute: (p: string) => posix.isAbsolute(p),
    extname: (p: string) => posix.extname(p)
  };
});

vi.mock('vscode', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    workspace: {
      ...(original as any).workspace,
      workspaceFolders: [{ uri: { fsPath: '/workspace' } }],
      findFiles: vi.fn(async () => [])
    }
  };
});

vi.mock('../../../src/utils/logger', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

vi.mock('../../../src/tracing', () => ({
  tracer: { event: vi.fn(), setLogOutput: vi.fn() }
}));

import { workspaceTools, executeToolCall, webSearchTool, applyCodeEditTool, createFileTool, deleteFileTool, deleteDirectoryTool } from '../../../src/tools/workspaceTools';
import type { ToolCall } from '../../../src/deepseekClient';
import * as vscode from 'vscode';

// ── Helpers ─────────────────────────────────────────────────────────

function makeToolCall(name: string, args: Record<string, string>): ToolCall {
  return {
    id: `call_${name}_1`,
    type: 'function',
    function: {
      name,
      arguments: JSON.stringify(args)
    }
  };
}

// ── Tests ───────────────────────────────────────────────────────────

describe('workspaceTools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset workspace folders
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: '/workspace' } }];

    // Reset fs mocks to defaults
    mockFs.existsSync.mockReturnValue(true);
    mockFs.statSync.mockReturnValue({
      isDirectory: () => false,
      isFile: () => true,
      size: 100,
      mtime: new Date('2026-01-15T00:00:00Z')
    });
    mockFs.readFileSync.mockReturnValue('line1\nline2\nline3\nline4\nline5');
    mockFs.readdirSync.mockReturnValue([]);
  });

  // ── Tool definitions ─────────────────────────────────────────────

  describe('tool definitions', () => {
    it('exports an array of tool definitions', () => {
      expect(Array.isArray(workspaceTools)).toBe(true);
      expect(workspaceTools.length).toBeGreaterThan(0);
    });

    it('has read_file tool', () => {
      const readFile = workspaceTools.find(t => t.function.name === 'read_file');
      expect(readFile).toBeDefined();
      expect(readFile!.type).toBe('function');
      expect(readFile!.function.parameters.required).toContain('path');
    });

    it('has find_files tool', () => {
      const searchFiles = workspaceTools.find(t => t.function.name === 'find_files');
      expect(searchFiles).toBeDefined();
      expect(searchFiles!.function.parameters.required).toContain('pattern');
    });

    it('has grep tool', () => {
      const grep = workspaceTools.find(t => t.function.name === 'grep');
      expect(grep).toBeDefined();
      expect(grep!.function.parameters.required).toContain('query');
    });

    it('has list_directory tool', () => {
      const listDir = workspaceTools.find(t => t.function.name === 'list_directory');
      expect(listDir).toBeDefined();
    });

    it('has file_metadata tool', () => {
      const info = workspaceTools.find(t => t.function.name === 'file_metadata');
      expect(info).toBeDefined();
      expect(info!.function.parameters.required).toContain('path');
    });

    it('has web_search tool as separate export', () => {
      expect(webSearchTool).toBeDefined();
      expect(webSearchTool.function.name).toBe('web_search');
    });

    it('has edit_file tool as separate export', () => {
      expect(applyCodeEditTool).toBeDefined();
      expect(applyCodeEditTool.function.name).toBe('edit_file');
    });

    it('has write_file tool with path + content required', () => {
      expect(createFileTool).toBeDefined();
      expect(createFileTool.function.name).toBe('write_file');
      expect(createFileTool.function.parameters.required).toEqual(
        expect.arrayContaining(['path', 'content'])
      );
    });

    it('has delete_file tool with path required', () => {
      expect(deleteFileTool).toBeDefined();
      expect(deleteFileTool.function.name).toBe('delete_file');
      expect(deleteFileTool.function.parameters.required).toContain('path');
    });

    it('has delete_directory tool with path required + optional recursive flag', () => {
      expect(deleteDirectoryTool).toBeDefined();
      expect(deleteDirectoryTool.function.name).toBe('delete_directory');
      expect(deleteDirectoryTool.function.parameters.required).toContain('path');
      expect(deleteDirectoryTool.function.parameters.properties.recursive).toBeDefined();
      expect(deleteDirectoryTool.function.parameters.properties.recursive.enum).toEqual(['true', 'false']);
    });
  });

  // ── executeToolCall dispatch ─────────────────────────────────────

  describe('executeToolCall()', () => {
    it('returns error for invalid JSON arguments', async () => {
      const tc: ToolCall = {
        id: 'call_1',
        type: 'function',
        function: { name: 'read_file', arguments: 'not valid json' }
      };

      const result = await executeToolCall(tc);
      expect(result).toContain('Error: Invalid arguments');
    });

    it('returns error when no workspace folder is open', async () => {
      (vscode.workspace as any).workspaceFolders = undefined;

      const result = await executeToolCall(makeToolCall('read_file', { path: 'test.ts' }));
      expect(result).toContain('Error: No workspace folder is open');
    });

    it('returns error for unknown function name', async () => {
      const result = await executeToolCall(makeToolCall('nonexistent_tool', {}));
      expect(result).toContain('Error: Unknown function');
      expect(result).toContain('nonexistent_tool');
    });

    it('dispatches read_file to the correct handler', async () => {
      const result = await executeToolCall(makeToolCall('read_file', { path: 'src/index.ts' }));
      expect(result).toContain('File: src/index.ts');
    });

    it('dispatches edit_file and returns acknowledgment', async () => {
      const result = await executeToolCall(makeToolCall('edit_file', {
        file: 'src/main.ts',
        code: 'console.log("hi")',
        description: 'Add logging'
      }));
      expect(result).toContain('Acknowledged');
      expect(result).toContain('src/main.ts');
      expect(result).toContain('Add logging');
    });

    it('dispatches write_file and returns acknowledgment', async () => {
      const result = await executeToolCall(makeToolCall('write_file', {
        path: 'src/new.ts',
        content: 'export const x = 1;',
        description: 'Add utility'
      }));
      expect(result).toContain('Acknowledged');
      expect(result).toContain('src/new.ts');
      expect(result).toContain('Add utility');
    });

    it('dispatches delete_file and returns acknowledgment', async () => {
      const result = await executeToolCall(makeToolCall('delete_file', {
        path: 'src/old.ts',
        description: 'Remove unused file'
      }));
      expect(result).toContain('Acknowledged');
      expect(result).toContain('src/old.ts');
      expect(result).toContain('Remove unused file');
    });

    it('dispatches delete_directory (recursive) and returns acknowledgment', async () => {
      const result = await executeToolCall(makeToolCall('delete_directory', {
        path: 'lib',
        recursive: 'true',
        description: 'Clean up elixir code'
      }));
      expect(result).toContain('Acknowledged');
      expect(result).toContain('lib');
      expect(result).toContain('recursive');
      expect(result).toContain('Clean up elixir code');
    });

    it('dispatches delete_directory (empty-only) with a different label', async () => {
      const result = await executeToolCall(makeToolCall('delete_directory', {
        path: 'empty_dir'
      }));
      expect(result).toContain('Acknowledged');
      expect(result).toContain('empty-only');
    });
  });

  // ── readFile ─────────────────────────────────────────────────────

  describe('read_file', () => {
    it('reads a file and returns numbered lines', async () => {
      mockFs.readFileSync.mockReturnValue('alpha\nbeta\ngamma');

      const result = await executeToolCall(makeToolCall('read_file', { path: 'test.txt' }));

      expect(result).toContain('File: test.txt');
      expect(result).toContain('1: alpha');
      expect(result).toContain('2: beta');
      expect(result).toContain('3: gamma');
    });

    it('reads a specific line range', async () => {
      mockFs.readFileSync.mockReturnValue('a\nb\nc\nd\ne');

      const result = await executeToolCall(makeToolCall('read_file', {
        path: 'test.txt',
        startLine: '2',
        endLine: '4'
      }));

      expect(result).toContain('lines 2-4');
      expect(result).toContain('2: b');
      expect(result).toContain('3: c');
      expect(result).toContain('4: d');
      expect(result).not.toContain('1: a');
      expect(result).not.toContain('5: e');
    });

    it('returns error when file does not exist', async () => {
      mockFs.existsSync.mockReturnValue(false);

      const result = await executeToolCall(makeToolCall('read_file', { path: 'missing.ts' }));
      expect(result).toContain('Error: File not found');
    });

    it('returns error when path is a directory', async () => {
      mockFs.statSync.mockReturnValue({
        isDirectory: () => true,
        isFile: () => false,
        size: 0,
        mtime: new Date()
      });

      const result = await executeToolCall(makeToolCall('read_file', { path: 'src' }));
      expect(result).toContain('is a directory');
    });

    it('returns error when file is too large (>500KB)', async () => {
      mockFs.statSync.mockReturnValue({
        isDirectory: () => false,
        isFile: () => true,
        size: 600 * 1024,
        mtime: new Date()
      });

      const result = await executeToolCall(makeToolCall('read_file', { path: 'big.bin' }));
      expect(result).toContain('File is too large');
    });

    it('returns error when startLine exceeds file length', async () => {
      mockFs.readFileSync.mockReturnValue('only one line');

      const result = await executeToolCall(makeToolCall('read_file', {
        path: 'short.txt',
        startLine: '999'
      }));
      expect(result).toContain('exceeds file length');
    });

    it('prevents reading files outside the workspace (path traversal)', async () => {
      // When path.join('/workspace', '../../etc/passwd') is resolved,
      // it should not start with /workspace
      const result = await executeToolCall(makeToolCall('read_file', {
        path: '../../etc/passwd'
      }));
      expect(result).toContain('Error: Cannot read files outside the workspace');
    });

    it('accepts absolute paths inside the workspace (V4 emits absolute paths)', async () => {
      // Pre-fix bug: path.join('/workspace', '/workspace/src/x.ts') →
      // '/workspace/workspace/src/x.ts' (POSIX path.join doesn't reset on
      // absolute second arg). path.resolve does, so this now reads correctly.
      mockFs.existsSync.mockReturnValue(true);
      mockFs.statSync.mockReturnValue({
        isDirectory: () => false, isFile: () => true, size: 100, mtime: new Date()
      } as any);
      mockFs.readFileSync.mockReturnValue('content');

      const result = await executeToolCall(makeToolCall('read_file', {
        path: '/workspace/src/x.ts'
      }));
      expect(result).not.toContain('Error');
      expect(result).toContain('content');
    });

    it('rejects absolute paths outside the workspace', async () => {
      const result = await executeToolCall(makeToolCall('read_file', {
        path: '/etc/passwd'
      }));
      expect(result).toContain('Error: Cannot read files outside the workspace');
    });
  });

  // ── searchFiles ──────────────────────────────────────────────────

  describe('find_files', () => {
    it('uses vscode.workspace.findFiles with the pattern', async () => {
      (vscode.workspace.findFiles as any).mockResolvedValue([
        { fsPath: '/workspace/src/a.ts' },
        { fsPath: '/workspace/src/b.ts' }
      ]);

      const result = await executeToolCall(makeToolCall('find_files', { pattern: '**/*.ts' }));

      expect(vscode.workspace.findFiles).toHaveBeenCalledWith(
        '**/*.ts',
        '**/node_modules/**',
        20
      );
      expect(result).toContain('Found 2 file(s)');
    });

    it('respects custom maxResults', async () => {
      (vscode.workspace.findFiles as any).mockResolvedValue([]);

      await executeToolCall(makeToolCall('find_files', { pattern: '*.js', maxResults: '5' }));

      expect(vscode.workspace.findFiles).toHaveBeenCalledWith('*.js', '**/node_modules/**', 5);
    });

    it('returns "No files found" when no matches', async () => {
      (vscode.workspace.findFiles as any).mockResolvedValue([]);

      const result = await executeToolCall(makeToolCall('find_files', { pattern: '*.xyz' }));
      expect(result).toContain('No files found');
    });
  });

  // ── listDirectory ────────────────────────────────────────────────

  describe('list_directory', () => {
    it('lists files and directories', async () => {
      mockFs.readdirSync.mockReturnValue(['src', 'README.md']);
      mockFs.existsSync.mockReturnValue(true);

      // path.join('/workspace', '.') = '/workspace'
      // path.join('/workspace', 'src') ends with '/src'
      // path.join('/workspace', 'README.md') ends with '/README.md'
      mockFs.statSync.mockImplementation((p: string) => {
        if (typeof p === 'string' && (p.endsWith('/src') || p === '/workspace')) {
          return { isDirectory: () => true, isFile: () => false, size: 0, mtime: new Date() };
        }
        return { isDirectory: () => false, isFile: () => true, size: 512, mtime: new Date() };
      });

      const result = await executeToolCall(makeToolCall('list_directory', { path: '.' }));

      expect(result).toContain('Directory: ./');
      expect(result).toContain('src/');
      expect(result).toContain('README.md');
    });

    it('returns error when directory does not exist', async () => {
      mockFs.existsSync.mockReturnValue(false);

      const result = await executeToolCall(makeToolCall('list_directory', { path: 'nope' }));
      expect(result).toContain('Error: Directory not found');
    });

    it('returns error when path is a file', async () => {
      mockFs.statSync.mockReturnValue({
        isDirectory: () => false,
        isFile: () => true,
        size: 100,
        mtime: new Date()
      });

      const result = await executeToolCall(makeToolCall('list_directory', { path: 'file.txt' }));
      expect(result).toContain('is a file, not a directory');
    });

    it('prevents listing directories outside the workspace', async () => {
      const result = await executeToolCall(makeToolCall('list_directory', { path: '../../' }));
      expect(result).toContain('Error: Cannot list directories outside the workspace');
    });

    it('accepts absolute paths inside the workspace', async () => {
      mockFs.readdirSync.mockReturnValue(['src']);
      mockFs.existsSync.mockReturnValue(true);
      mockFs.statSync.mockReturnValue({
        isDirectory: () => true, isFile: () => false, size: 0, mtime: new Date()
      } as any);

      const result = await executeToolCall(makeToolCall('list_directory', {
        path: '/workspace'
      }));
      expect(result).not.toContain('Error');
      expect(result).toContain('Directory:');
    });

    it('rejects absolute paths outside the workspace', async () => {
      const result = await executeToolCall(makeToolCall('list_directory', { path: '/etc' }));
      expect(result).toContain('Error: Cannot list directories outside the workspace');
    });

    it('skips node_modules and .git directories', async () => {
      mockFs.readdirSync.mockReturnValue(['node_modules', '.git', 'src']);

      // All items are directories in this test
      mockFs.statSync.mockImplementation(() => ({
        isDirectory: () => true,
        isFile: () => false,
        size: 0,
        mtime: new Date()
      }));

      const result = await executeToolCall(makeToolCall('list_directory', { path: '.' }));
      expect(result).toContain('node_modules/ (skipped)');
      expect(result).toContain('.git/ (skipped)');
      expect(result).toContain('src/');
    });
  });

  // ── getFileInfo ──────────────────────────────────────────────────

  describe('file_metadata', () => {
    it('returns file metadata', async () => {
      mockFs.statSync.mockImplementation(() => ({
        isDirectory: () => false,
        isFile: () => true,
        size: 2048,
        mtime: new Date('2026-01-15T00:00:00Z')
      }));
      mockFs.readFileSync.mockReturnValue('const x = 1;\nconst y = 2;');

      const result = await executeToolCall(makeToolCall('file_metadata', { path: 'src/index.ts' }));

      expect(result).toContain('File: src/index.ts');
      expect(result).toContain('Size: 2048 bytes');
      expect(result).toContain('Extension: .ts');
      expect(result).toContain('Modified:');
    });

    it('returns error when file does not exist', async () => {
      mockFs.existsSync.mockReturnValue(false);

      const result = await executeToolCall(makeToolCall('file_metadata', { path: 'nope.ts' }));
      expect(result).toContain('Error: File not found');
    });

    it('prevents access outside workspace', async () => {
      const result = await executeToolCall(makeToolCall('file_metadata', { path: '../../etc/shadow' }));
      expect(result).toContain('Error: Cannot access files outside the workspace');
    });

    it('shows preview for small files', async () => {
      mockFs.statSync.mockReturnValue({
        isDirectory: () => false,
        isFile: () => true,
        size: 50,
        mtime: new Date('2026-01-15T00:00:00Z')
      });
      mockFs.readFileSync.mockReturnValue('hello\nworld');

      const result = await executeToolCall(makeToolCall('file_metadata', { path: 'small.txt' }));

      expect(result).toContain('Preview');
      expect(result).toContain('hello');
    });
  });

  // ── grepContent ──────────────────────────────────────────────────

  describe('grep', () => {
    it('calls ripgrep with correct arguments', async () => {
      mockCp.spawnSync.mockReturnValue({
        stdout: 'src/index.ts:5:const foo = "bar";\n',
        stderr: '',
        status: 0
      });

      const result = await executeToolCall(makeToolCall('grep', { query: 'foo' }));

      expect(mockCp.spawnSync).toHaveBeenCalledWith(
        'rg',
        expect.arrayContaining(['-n', 'foo']),
        expect.objectContaining({
          cwd: '/workspace',
          encoding: 'utf-8',
          timeout: 10000
        })
      );
      expect(result).toContain('Search results for "foo"');
    });

    it('returns "No matches found" when no results', async () => {
      mockCp.spawnSync.mockReturnValue({ stdout: '', stderr: '', status: 1 });

      const result = await executeToolCall(makeToolCall('grep', { query: 'nonexistent' }));
      expect(result).toContain('No matches found');
    });

    it('passes filePattern as glob filter', async () => {
      mockCp.spawnSync.mockReturnValue({ stdout: 'match\n', stderr: '', status: 0 });

      await executeToolCall(makeToolCall('grep', {
        query: 'test',
        filePattern: '*.ts'
      }));

      const args = mockCp.spawnSync.mock.calls[0][1];
      expect(args).toContain('-g');
      expect(args).toContain('*.ts');
    });
  });

  // ── Path security ────────────────────────────────────────────────

  describe('path security', () => {
    it('read_file blocks workspace escape via ../', async () => {
      const result = await executeToolCall(makeToolCall('read_file', { path: '../../../etc/passwd' }));
      expect(result).toContain('Error: Cannot read files outside the workspace');
    });

    it('list_directory blocks workspace escape via ../', async () => {
      const result = await executeToolCall(makeToolCall('list_directory', { path: '../../../' }));
      expect(result).toContain('Error: Cannot list directories outside the workspace');
    });

    it('file_metadata blocks workspace escape via ../', async () => {
      const result = await executeToolCall(makeToolCall('file_metadata', { path: '../../../etc/shadow' }));
      expect(result).toContain('Error: Cannot access files outside the workspace');
    });
  });
});
