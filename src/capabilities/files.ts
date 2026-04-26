import * as vscode from 'vscode';
import * as path from 'path';
import { CapabilityResult } from './types';

/**
 * File capabilities: create, delete.
 *
 * These are thin wrappers around `vscode.workspace.fs` that:
 * - Resolve workspace-root-relative paths to absolute paths
 * - Enforce the workspace-contains-path security check
 * - Return a structured `CapabilityResult` so tool-result formatters can
 *   emit absolute-path ground truth (ADR 0004 B-pattern)
 *
 * These functions are approval-agnostic — the orchestrator decides whether
 * to prompt the user before invoking them based on the current edit mode.
 */

function resolveWorkspacePath(relativePath: string): { absolutePath: string; workspacePath: string } | string {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    return 'No workspace folder is open';
  }

  const workspacePath = workspaceFolder.uri.fsPath;
  const absolutePath = path.resolve(workspacePath, relativePath);

  if (!absolutePath.startsWith(workspacePath + path.sep) && absolutePath !== workspacePath) {
    return `Path escapes workspace: ${relativePath}`;
  }

  return { absolutePath, workspacePath };
}

/**
 * Write a file with the given content. Creates if missing, overwrites
 * entirely if it exists. The "create or overwrite" shape (instead of
 * fail-on-exists) lets callers express "I want this file to look like
 * this" without round-tripping through delete_file first.
 *
 * `action` distinguishes the two cases for downstream tracking
 * (`'created'` vs `'modified'`).
 */
export async function createFile(
  relativePath: string,
  content: string
): Promise<CapabilityResult> {
  const resolved = resolveWorkspacePath(relativePath);
  if (typeof resolved === 'string') {
    return { status: 'failure', error: resolved, filesAffected: [] };
  }
  const { absolutePath } = resolved;
  const uri = vscode.Uri.file(absolutePath);

  let existed = false;
  try {
    await vscode.workspace.fs.stat(uri);
    existed = true;
  } catch {
    // Stat failed — file does not exist; this is a fresh create.
  }

  try {
    const parentDir = vscode.Uri.file(path.dirname(absolutePath));
    await vscode.workspace.fs.createDirectory(parentDir);
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
    return {
      status: 'success',
      filesAffected: [{ absolutePath, relativePath, action: existed ? 'modified' : 'created' }],
    };
  } catch (error: any) {
    return {
      status: 'failure',
      error: `Failed to write ${relativePath}: ${error.message ?? String(error)}`,
      filesAffected: [],
    };
  }
}

/**
 * Delete a directory. By default only deletes empty directories; set
 * `recursive: true` to delete a populated directory and all its contents.
 * Moves to trash by default for recoverability, with the same WSL/remote
 * fallback as deleteFile.
 */
export async function deleteDirectory(
  relativePath: string,
  options: { recursive?: boolean; useTrash?: boolean } = {}
): Promise<CapabilityResult> {
  const resolved = resolveWorkspacePath(relativePath);
  if (typeof resolved === 'string') {
    return { status: 'failure', error: resolved, filesAffected: [] };
  }
  const { absolutePath } = resolved;
  const uri = vscode.Uri.file(absolutePath);

  let stat: vscode.FileStat;
  try {
    stat = await vscode.workspace.fs.stat(uri);
  } catch {
    return { status: 'failure', error: `Directory not found: ${relativePath}`, filesAffected: [] };
  }

  if (stat.type !== vscode.FileType.Directory) {
    return {
      status: 'failure',
      error: `Not a directory: ${relativePath}. Use delete_file for files.`,
      filesAffected: [],
    };
  }

  const recursive = options.recursive ?? false;

  if (!recursive) {
    // Empty-only delete — check contents before calling fs.delete so we can
    // surface a clear error rather than the provider's generic "not empty".
    try {
      const entries = await vscode.workspace.fs.readDirectory(uri);
      if (entries.length > 0) {
        return {
          status: 'failure',
          error: `Directory not empty: ${relativePath} contains ${entries.length} ${entries.length === 1 ? 'item' : 'items'}. Set recursive=true to delete all contents, or delete contents first.`,
          filesAffected: [],
        };
      }
    } catch (error: any) {
      return {
        status: 'failure',
        error: `Failed to read ${relativePath}: ${error.message ?? String(error)}`,
        filesAffected: [],
      };
    }
  }

  const useTrashRequested = options.useTrash ?? true;
  try {
    await vscode.workspace.fs.delete(uri, { useTrash: useTrashRequested, recursive });
    return {
      status: 'success',
      filesAffected: [{ absolutePath, relativePath, action: 'deleted' }],
    };
  } catch (error: any) {
    const message = error?.message ?? String(error);
    // Same WSL/remote fallback as deleteFile.
    const trashUnsupported = useTrashRequested && /provider does not support it|does not implement|not supported/i.test(message);
    if (trashUnsupported) {
      try {
        await vscode.workspace.fs.delete(uri, { useTrash: false, recursive });
        return {
          status: 'success',
          filesAffected: [{ absolutePath, relativePath, action: 'deleted' }],
        };
      } catch (retryError: any) {
        return {
          status: 'failure',
          error: `Failed to delete ${relativePath}: ${retryError.message ?? String(retryError)}`,
          filesAffected: [],
        };
      }
    }
    return {
      status: 'failure',
      error: `Failed to delete ${relativePath}: ${message}`,
      filesAffected: [],
    };
  }
}

/**
 * Delete a file. Moves to trash by default for recoverability.
 * Refuses to delete directories — use deleteDirectory with recursive=true.
 */
export async function deleteFile(
  relativePath: string,
  options: { useTrash?: boolean } = {}
): Promise<CapabilityResult> {
  const resolved = resolveWorkspacePath(relativePath);
  if (typeof resolved === 'string') {
    return { status: 'failure', error: resolved, filesAffected: [] };
  }
  const { absolutePath } = resolved;
  const uri = vscode.Uri.file(absolutePath);

  let stat: vscode.FileStat;
  try {
    stat = await vscode.workspace.fs.stat(uri);
  } catch {
    return {
      status: 'failure',
      error: `File not found: ${relativePath}`,
      filesAffected: [],
    };
  }

  if (stat.type === vscode.FileType.Directory) {
    return {
      status: 'failure',
      error: `Path is a directory: ${relativePath}. Use delete_directory instead.`,
      filesAffected: [],
    };
  }

  const useTrashRequested = options.useTrash ?? true;
  try {
    await vscode.workspace.fs.delete(uri, {
      useTrash: useTrashRequested,
      recursive: false,
    });
    return {
      status: 'success',
      filesAffected: [{ absolutePath, relativePath, action: 'deleted' }],
    };
  } catch (error: any) {
    const message = error?.message ?? String(error);
    // WSL / many remote fs providers (SSH, some containers) don't implement
    // the trash capability. Fall back to a hard delete when we detect that
    // specific failure, so deletes still work on remote workspaces.
    const trashUnsupported = useTrashRequested && /provider does not support it|does not implement|not supported/i.test(message);
    if (trashUnsupported) {
      try {
        await vscode.workspace.fs.delete(uri, { useTrash: false, recursive: false });
        return {
          status: 'success',
          filesAffected: [{ absolutePath, relativePath, action: 'deleted' }],
        };
      } catch (retryError: any) {
        return {
          status: 'failure',
          error: `Failed to delete ${relativePath}: ${retryError.message ?? String(retryError)}`,
          filesAffected: [],
        };
      }
    }
    return {
      status: 'failure',
      error: `Failed to delete ${relativePath}: ${message}`,
      filesAffected: [],
    };
  }
}
