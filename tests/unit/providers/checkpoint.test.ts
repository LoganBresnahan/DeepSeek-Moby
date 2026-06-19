/**
 * Edit-safety Phase 1 — checkpoint / EditTransaction (the keystone).
 *
 * Real tests for the snapshot + revert primitive on DiffManager (ADR 0006
 * layer 3). A small stateful `vscode` mock simulates file content so the full
 * apply → revert cycle can be asserted end to end: a checkpointed file goes
 * original → applied → (revert) → original.
 *
 * Spec: docs/architecture/decisions/0006-edit-safety-checkpoint-and-validation.md (Layer 3)
 *       docs/architecture/integration/edit-safety.md (test matrix)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Shared, stateful "filesystem": fsPath → current content. The vscode mock
// reads/writes through this so revert can be observed against real content.
const { WorkingEventEmitter, fileStore } = vi.hoisted(() => ({
  WorkingEventEmitter: class WorkingEventEmitter {
    private _listeners: Array<(e: any) => void> = [];
    event = (listener: (e: any) => void) => {
      this._listeners.push(listener);
      return { dispose: () => { this._listeners = this._listeners.filter(l => l !== listener); } };
    };
    fire = (data: any) => { for (const l of this._listeners) l(data); };
    dispose = () => { this._listeners = []; };
  },
  fileStore: new Map<string, string>(),
}));

vi.mock('vscode', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    EventEmitter: WorkingEventEmitter,
    window: {
      ...(original as any).window,
      createStatusBarItem: vi.fn(() => ({
        text: '', tooltip: '', command: '', backgroundColor: null,
        show: vi.fn(), hide: vi.fn(), dispose: vi.fn(),
      })),
      tabGroups: { all: [], close: vi.fn() },
      onDidChangeActiveTextEditor: vi.fn(() => ({ dispose: vi.fn() })),
      showWarningMessage: vi.fn(),
    },
    workspace: {
      ...(original as any).workspace,
      onDidCloseTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
      workspaceFolders: [{ uri: { toString: () => 'file:///workspace', fsPath: '/workspace' } }],
      getConfiguration: vi.fn(() => ({ get: vi.fn(), update: vi.fn() })),
      openTextDocument: vi.fn(async (uriOrOpts: any) => {
        const fsPath = uriOrOpts?.fsPath ?? String(uriOrOpts);
        return {
          uri: uriOrOpts,
          getText: () => fileStore.get(fsPath) ?? '',
          fileName: fsPath,
          positionAt: (offset: number) => ({ line: 0, character: offset }),
          offsetAt: (pos: any) => pos.character || 0,
          save: vi.fn(async () => {}),
        };
      }),
      applyEdit: vi.fn(async (edit: any) => {
        for (const e of edit._edits ?? []) fileStore.set(e.fsPath, e.text);
        return true;
      }),
      fs: {
        // stat / readFile resolve only for files that "exist" in the store.
        stat: vi.fn(async (uri: any) => {
          if (fileStore.has(uri?.fsPath)) return {};
          throw new Error('ENOENT');
        }),
        readFile: vi.fn(async (uri: any) => {
          if (!fileStore.has(uri?.fsPath)) throw new Error('ENOENT');
          return Buffer.from(fileStore.get(uri.fsPath) as string);
        }),
        writeFile: vi.fn(async () => {}),
        delete: vi.fn(async (uri: any) => { fileStore.delete(uri?.fsPath); }),
        createDirectory: vi.fn(async () => {}),
      },
    },
    Uri: {
      file: (s: string) => ({ toString: () => `file://${s}`, fsPath: s, scheme: 'file' }),
      joinPath: (_base: any, rel: string) => ({ toString: () => `file:///workspace/${rel}`, fsPath: `/workspace/${rel}`, scheme: 'file' }),
    },
    Range: class Range { constructor(public start: any, public end: any) {} },
    WorkspaceEdit: class WorkspaceEdit {
      _edits: Array<{ fsPath: string; text: string }> = [];
      replace = (uri: any, _range: any, text: string) => { this._edits.push({ fsPath: uri.fsPath, text }); };
    },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ThemeColor: class ThemeColor { constructor(public id: string) {} },
  };
});

vi.mock('../../../src/utils/logger', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), diffShown: vi.fn(), codeApplied: vi.fn() },
}));

import { DiffManager } from '../../../src/providers/diffManager';
import * as vscode from 'vscode';

// diffEngine: applyChanges(current, code) writes `code` as the new full content.
function createMockDiffEngine() {
  return {
    applyChanges: vi.fn((_original: string, newCode: string) => ({
      content: newCode, success: true, message: 'Applied',
    })),
  };
}
function createMockFileContextManager() {
  return { inferFilePath: vi.fn(() => null), resolveFilePath: vi.fn(async () => null), dispose: vi.fn() };
}
function createManager() {
  return new DiffManager(createMockDiffEngine() as any, createMockFileContextManager() as any, 'auto');
}

const A = '/workspace/a.ts';
const B = '/workspace/b.ts';

describe('DiffManager — checkpoint / EditTransaction (ADR 0006, Phase 1)', () => {
  let manager: DiffManager;

  beforeEach(() => {
    fileStore.clear();
    fileStore.set(A, 'A-original');
    fileStore.set(B, 'B-original');
    manager = createManager();
  });

  afterEach(() => manager.dispose());

  it('snapshots original content before the first write to a file', async () => {
    manager.beginEditTransaction();
    await manager.applyCodeDirectlyForAutoMode(A, 'A-edited', undefined, true);

    expect(manager.checkpointedPaths).toEqual([A]);
    expect(fileStore.get(A)).toBe('A-edited'); // write happened
  });

  it('snapshot is idempotent per file across multiple edits in one batch', async () => {
    manager.beginEditTransaction();
    await manager.applyCodeDirectlyForAutoMode(A, 'A-edit-1', undefined, true);
    await manager.applyCodeDirectlyForAutoMode(A, 'A-edit-2', undefined, true);

    expect(manager.checkpointedPaths).toEqual([A]); // still one snapshot

    await manager.revertEditTransaction();
    expect(fileStore.get(A)).toBe('A-original'); // restored to FIRST snapshot, not A-edit-1
  });

  it('multiple files in one batch are each snapshotted independently', async () => {
    manager.beginEditTransaction();
    await manager.applyCodeDirectlyForAutoMode(A, 'A-edited', undefined, true);
    await manager.applyCodeDirectlyForAutoMode(B, 'B-edited', undefined, true);

    expect(manager.checkpointedPaths).toEqual([A, B]);
  });

  it('revert restores exact original bytes for every checkpointed file', async () => {
    manager.beginEditTransaction();
    await manager.applyCodeDirectlyForAutoMode(A, 'A-edited', undefined, true);
    await manager.applyCodeDirectlyForAutoMode(B, 'B-edited', undefined, true);
    expect(fileStore.get(A)).toBe('A-edited');
    expect(fileStore.get(B)).toBe('B-edited');

    const reverted = await manager.revertEditTransaction();

    expect(fileStore.get(A)).toBe('A-original');
    expect(fileStore.get(B)).toBe('B-original');
    expect(reverted.sort()).toEqual([A, B].sort());
    expect(manager.hasOpenEditTransaction).toBe(false);
  });

  it('revert is a no-op after a committed batch', async () => {
    manager.beginEditTransaction();
    await manager.applyCodeDirectlyForAutoMode(A, 'A-edited', undefined, true);
    manager.commitEditTransaction();

    const reverted = await manager.revertEditTransaction();

    expect(reverted).toEqual([]);
    expect(fileStore.get(A)).toBe('A-edited'); // commit kept the write
    expect(manager.hasOpenEditTransaction).toBe(false);
  });

  it('checkpoint is discarded after a successful commit (no cross-batch leak)', async () => {
    manager.beginEditTransaction();
    await manager.applyCodeDirectlyForAutoMode(A, 'A-edited', undefined, true);
    manager.commitEditTransaction();

    // New batch touches only B; reverting it must not roll A back.
    manager.beginEditTransaction();
    await manager.applyCodeDirectlyForAutoMode(B, 'B-edited', undefined, true);
    expect(manager.checkpointedPaths).toEqual([B]);

    await manager.revertEditTransaction();

    expect(fileStore.get(A)).toBe('A-edited');   // committed, untouched
    expect(fileStore.get(B)).toBe('B-original'); // reverted
  });

  it('snapshot survives the per-edit writes that happen within the batch', async () => {
    manager.beginEditTransaction();
    await manager.applyCodeDirectlyForAutoMode(A, 'A-edit-1', undefined, true);
    expect(manager.checkpointedPaths).toEqual([A]);
    await manager.applyCodeDirectlyForAutoMode(A, 'A-edit-2', undefined, true);
    expect(fileStore.get(A)).toBe('A-edit-2');

    await manager.revertEditTransaction();
    expect(fileStore.get(A)).toBe('A-original');
  });

  it('snapshot capture is a no-op when no transaction is open (apply path unchanged)', async () => {
    // No beginEditTransaction(): the apply path must behave exactly as before.
    await manager.applyCodeDirectlyForAutoMode(A, 'A-edited', undefined, true);

    expect(manager.hasOpenEditTransaction).toBe(false);
    expect(manager.checkpointedPaths).toEqual([]);
    expect(fileStore.get(A)).toBe('A-edited');
    expect(await manager.revertEditTransaction()).toEqual([]);
  });

  // write_file path (ADR 0006): snapshotPathForCheckpoint detects existence so a
  // revert restores an overwritten file or deletes a newly created one.
  it('snapshotPathForCheckpoint restores an overwritten existing file on revert', async () => {
    manager.beginEditTransaction();
    await manager.snapshotPathForCheckpoint(A);   // A exists → snapshot content
    fileStore.set(A, 'A-overwritten');            // simulate write_file overwrite
    expect(manager.checkpointedPaths).toEqual([A]);

    await manager.revertEditTransaction();
    expect(fileStore.get(A)).toBe('A-original');
  });

  it('snapshotPathForCheckpoint deletes a newly created file on revert', async () => {
    const NEW = '/workspace/new.ts';
    manager.beginEditTransaction();
    await manager.snapshotPathForCheckpoint(NEW); // NEW does not exist → existed:false
    fileStore.set(NEW, 'created content');        // simulate write_file create
    expect(manager.checkpointedPaths).toEqual([NEW]);

    await manager.revertEditTransaction();
    expect(fileStore.has(NEW)).toBe(false); // deleted, restoring "absent"
  });

  it('snapshotPathForCheckpoint is a no-op when no transaction is open', async () => {
    await manager.snapshotPathForCheckpoint(A);
    expect(manager.checkpointedPaths).toEqual([]);
  });

  it('fails the edit without saving or false success when applyEdit is rejected', async () => {
    // Simulate the editor rejecting the WorkspaceEdit (file locked / out of sync).
    vi.mocked(vscode.workspace.applyEdit).mockResolvedValueOnce(false as any);
    const before = manager.getFailedAutoApplyCount();

    const ok = await manager.applyCodeDirectlyForAutoMode(A, 'A-edited', undefined, true);

    expect(ok).toBe(false);
    expect(fileStore.get(A)).toBe('A-original'); // not written
    expect(manager.getFailedAutoApplyCount()).toBe(before + 1);
  });
});
