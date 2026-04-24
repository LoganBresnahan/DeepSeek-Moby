import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as vscode from 'vscode';
import { createFile, deleteFile, deleteDirectory } from '../../../src/capabilities/files';
import { formatFilesAffected } from '../../../src/capabilities/types';

describe('file capabilities', () => {
  const WORKSPACE_PATH = '/test/workspace';

  beforeEach(() => {
    vi.clearAllMocks();
    (vscode.workspace as any).workspaceFolders = [
      { uri: { fsPath: WORKSPACE_PATH, scheme: 'file', path: WORKSPACE_PATH } }
    ];
  });

  describe('createFile', () => {
    it('creates a new file under workspace root and reports absolute path', async () => {
      // stat rejects (file does not exist), writeFile + createDirectory succeed
      (vscode.workspace.fs.stat as any).mockRejectedValue(new Error('ENOENT'));
      (vscode.workspace.fs.createDirectory as any).mockResolvedValue(undefined);
      (vscode.workspace.fs.writeFile as any).mockResolvedValue(undefined);

      const result = await createFile('src/newFile.ts', 'export const x = 1;');

      expect(result.status).toBe('success');
      expect(result.filesAffected).toHaveLength(1);
      expect(result.filesAffected[0].action).toBe('created');
      expect(result.filesAffected[0].relativePath).toBe('src/newFile.ts');
      expect(result.filesAffected[0].absolutePath).toContain('src/newFile.ts');
      expect(result.filesAffected[0].absolutePath).toContain(WORKSPACE_PATH);
      expect(vscode.workspace.fs.writeFile).toHaveBeenCalledOnce();
    });

    it('refuses to create a file that already exists', async () => {
      (vscode.workspace.fs.stat as any).mockResolvedValue({ type: vscode.FileType.File, size: 100 });

      const result = await createFile('existing.ts', 'content');

      expect(result.status).toBe('failure');
      expect(result.error).toMatch(/already exists/);
      expect(result.filesAffected).toEqual([]);
      expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
    });

    it('refuses paths that escape the workspace', async () => {
      const result = await createFile('../outside.ts', 'content');

      expect(result.status).toBe('failure');
      expect(result.error).toMatch(/escapes workspace/);
      expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
    });

    it('fails gracefully when no workspace is open', async () => {
      (vscode.workspace as any).workspaceFolders = [];

      const result = await createFile('foo.ts', 'content');

      expect(result.status).toBe('failure');
      expect(result.error).toMatch(/No workspace folder/);
    });

    it('surfaces fs errors in the result', async () => {
      (vscode.workspace.fs.stat as any).mockRejectedValue(new Error('ENOENT'));
      (vscode.workspace.fs.createDirectory as any).mockResolvedValue(undefined);
      (vscode.workspace.fs.writeFile as any).mockRejectedValue(new Error('EACCES: permission denied'));

      const result = await createFile('readonly.ts', 'content');

      expect(result.status).toBe('failure');
      expect(result.error).toMatch(/permission denied/);
    });
  });

  describe('deleteFile', () => {
    it('deletes an existing file using trash by default', async () => {
      (vscode.workspace.fs.stat as any).mockResolvedValue({ type: vscode.FileType.File, size: 100 });
      (vscode.workspace.fs.delete as any).mockResolvedValue(undefined);

      const result = await deleteFile('old.ts');

      expect(result.status).toBe('success');
      expect(result.filesAffected[0].action).toBe('deleted');
      expect(vscode.workspace.fs.delete).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ useTrash: true, recursive: false })
      );
    });

    it('supports disabling trash', async () => {
      (vscode.workspace.fs.stat as any).mockResolvedValue({ type: vscode.FileType.File, size: 10 });
      (vscode.workspace.fs.delete as any).mockResolvedValue(undefined);

      await deleteFile('old.ts', { useTrash: false });

      expect(vscode.workspace.fs.delete).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ useTrash: false })
      );
    });

    it('refuses to delete directories', async () => {
      (vscode.workspace.fs.stat as any).mockResolvedValue({ type: vscode.FileType.Directory, size: 0 });

      const result = await deleteFile('src');

      expect(result.status).toBe('failure');
      expect(result.error).toMatch(/directory/);
      expect(vscode.workspace.fs.delete).not.toHaveBeenCalled();
    });

    it('fails when the file does not exist', async () => {
      (vscode.workspace.fs.stat as any).mockRejectedValue(new Error('ENOENT'));

      const result = await deleteFile('missing.ts');

      expect(result.status).toBe('failure');
      expect(result.error).toMatch(/not found/);
    });

    it('refuses paths that escape the workspace', async () => {
      const result = await deleteFile('../outside.ts');

      expect(result.status).toBe('failure');
      expect(result.error).toMatch(/escapes workspace/);
    });

    it('falls back to hard delete when trash is unsupported (WSL / remote fs)', async () => {
      (vscode.workspace.fs.stat as any).mockResolvedValue({ type: vscode.FileType.File, size: 10 });
      (vscode.workspace.fs.delete as any)
        .mockRejectedValueOnce(new Error("Unable to delete file 'vscode-remote://...' via trash because provider does not support it."))
        .mockResolvedValueOnce(undefined);

      const result = await deleteFile('old.ts');

      expect(result.status).toBe('success');
      expect(vscode.workspace.fs.delete).toHaveBeenCalledTimes(2);
      // Second call should have useTrash: false
      expect(vscode.workspace.fs.delete).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({ useTrash: false })
      );
    });

    it('does not retry when the original error is unrelated to trash support', async () => {
      (vscode.workspace.fs.stat as any).mockResolvedValue({ type: vscode.FileType.File, size: 10 });
      (vscode.workspace.fs.delete as any).mockRejectedValue(new Error('EACCES: permission denied'));

      const result = await deleteFile('readonly.ts');

      expect(result.status).toBe('failure');
      expect(result.error).toMatch(/permission denied/);
      expect(vscode.workspace.fs.delete).toHaveBeenCalledTimes(1);
    });
  });

  describe('deleteDirectory', () => {
    it('deletes an empty directory (recursive=false default)', async () => {
      (vscode.workspace.fs.stat as any).mockResolvedValue({ type: vscode.FileType.Directory, size: 0 });
      (vscode.workspace.fs.readDirectory as any).mockResolvedValue([]);
      (vscode.workspace.fs.delete as any).mockResolvedValue(undefined);

      const result = await deleteDirectory('empty_dir');

      expect(result.status).toBe('success');
      expect(result.filesAffected[0].action).toBe('deleted');
      expect(vscode.workspace.fs.delete).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ useTrash: true, recursive: false })
      );
    });

    it('refuses non-recursive delete on a populated directory with a helpful error', async () => {
      (vscode.workspace.fs.stat as any).mockResolvedValue({ type: vscode.FileType.Directory, size: 0 });
      (vscode.workspace.fs.readDirectory as any).mockResolvedValue([['foo.txt', 1], ['bar.txt', 1]]);

      const result = await deleteDirectory('lib');

      expect(result.status).toBe('failure');
      expect(result.error).toMatch(/not empty.*2 items/);
      expect(result.error).toMatch(/recursive=true/);
      expect(vscode.workspace.fs.delete).not.toHaveBeenCalled();
    });

    it('recursively deletes a populated directory when recursive=true', async () => {
      (vscode.workspace.fs.stat as any).mockResolvedValue({ type: vscode.FileType.Directory, size: 0 });
      (vscode.workspace.fs.delete as any).mockResolvedValue(undefined);

      const result = await deleteDirectory('lib', { recursive: true });

      expect(result.status).toBe('success');
      expect(vscode.workspace.fs.readDirectory).not.toHaveBeenCalled();
      expect(vscode.workspace.fs.delete).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ useTrash: true, recursive: true })
      );
    });

    it('refuses to delete a path that is a file, not a directory', async () => {
      (vscode.workspace.fs.stat as any).mockResolvedValue({ type: vscode.FileType.File, size: 100 });

      const result = await deleteDirectory('foo.ts');

      expect(result.status).toBe('failure');
      expect(result.error).toMatch(/Not a directory/);
    });

    it('falls back to hard delete when trash unsupported (WSL / remote)', async () => {
      (vscode.workspace.fs.stat as any).mockResolvedValue({ type: vscode.FileType.Directory, size: 0 });
      (vscode.workspace.fs.readDirectory as any).mockResolvedValue([]);
      (vscode.workspace.fs.delete as any)
        .mockRejectedValueOnce(new Error('Unable to delete via trash because provider does not support it'))
        .mockResolvedValueOnce(undefined);

      const result = await deleteDirectory('empty_dir');

      expect(result.status).toBe('success');
      expect(vscode.workspace.fs.delete).toHaveBeenCalledTimes(2);
      expect(vscode.workspace.fs.delete).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({ useTrash: false })
      );
    });

    it('fails when the directory does not exist', async () => {
      (vscode.workspace.fs.stat as any).mockRejectedValue(new Error('ENOENT'));

      const result = await deleteDirectory('missing');

      expect(result.status).toBe('failure');
      expect(result.error).toMatch(/not found/i);
    });

    it('refuses paths that escape the workspace', async () => {
      const result = await deleteDirectory('../outside');

      expect(result.status).toBe('failure');
      expect(result.error).toMatch(/escapes workspace/);
    });
  });

  describe('formatFilesAffected', () => {
    it('returns empty string for empty array', () => {
      expect(formatFilesAffected([])).toBe('');
    });

    it('formats a single created file', () => {
      const out = formatFilesAffected([
        { absolutePath: '/abs/path/foo.ts', relativePath: 'foo.ts', action: 'created' }
      ]);
      expect(out).toContain('Files touched');
      expect(out).toContain('Created: /abs/path/foo.ts');
    });

    it('formats multiple files with their actions', () => {
      const out = formatFilesAffected([
        { absolutePath: '/a.ts', relativePath: 'a.ts', action: 'created' },
        { absolutePath: '/b.ts', relativePath: 'b.ts', action: 'deleted' },
        { absolutePath: '/c.ts', relativePath: 'c.ts', action: 'modified' }
      ]);
      expect(out).toContain('Created: /a.ts');
      expect(out).toContain('Deleted: /b.ts');
      expect(out).toContain('Modified: /c.ts');
    });
  });
});
