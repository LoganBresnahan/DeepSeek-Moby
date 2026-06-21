/**
 * Unit tests for workspacePaths (ADR 0012).
 *
 * Covers the project-root awareness that fixes build-artifact pollution (#1) and
 * dormant edit-safety / file-path resolution on nested projects (#2):
 *  - shouldIgnoreWatcherPath: nested obj/bin filtering + project-root anchoring
 *  - findProjectRoots: bounded BFS, fast path, ignore-skipping, depth bound
 *  - resolveWorkspacePath: workspace root then nested project roots
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// In-memory tree: dir fsPath -> [name, FileType][]; and a set of existing paths.
const { tree, existing } = vi.hoisted(() => ({
  tree: new Map<string, Array<[string, number]>>(),
  existing: new Set<string>(),
}));

function join(base: any, ...segs: string[]) {
  const basePath = typeof base === 'string' ? base : (base.fsPath ?? base.path ?? '');
  const p = [basePath.replace(/\/$/, ''), ...segs].join('/');
  return { fsPath: p, path: p, scheme: 'file' };
}

vi.mock('vscode', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
    Uri: {
      file: (p: string) => ({ fsPath: p, path: p, scheme: 'file' }),
      joinPath: (base: any, ...segs: string[]) => join(base, ...segs),
    },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: '/ws', path: '/ws', scheme: 'file' } }],
      asRelativePath: (uri: any, _includeFolder?: boolean) => {
        const p = typeof uri === 'string' ? uri : uri.fsPath;
        if (p === '/ws') return '/ws';
        return p.startsWith('/ws/') ? p.slice('/ws/'.length) : p;
      },
      fs: {
        readDirectory: vi.fn(async (uri: any) => {
          const key = uri.fsPath ?? uri.path;
          if (!tree.has(key)) throw new Error(`ENOENT ${key}`);
          return tree.get(key)!;
        }),
        stat: vi.fn(async (uri: any) => {
          const key = uri.fsPath ?? uri.path;
          if (existing.has(key)) return { type: 1 };
          throw new Error(`ENOENT ${key}`);
        }),
      },
    },
  };
});

import {
  shouldIgnoreWatcherPath,
  findProjectRoots,
  resolveWorkspacePath,
} from '../../../src/utils/workspacePaths';
import * as vscode from 'vscode';

const FILE = 1, DIR = 2;

beforeEach(() => {
  tree.clear();
  existing.clear();
});

describe('shouldIgnoreWatcherPath', () => {
  it('ignores nested .NET obj/ at any depth (the subdirectory-project leak)', () => {
    expect(shouldIgnoreWatcherPath('worldCupWebApp/obj/Debug/net10.0/x.cache')).toBe(true);
    expect(shouldIgnoreWatcherPath('a/b/c/obj/project.assets.json')).toBe(true);
  });

  it('ignores nested bin/ only when followed by a build config', () => {
    expect(shouldIgnoreWatcherPath('worldCupWebApp/bin/Debug/net10.0/app.dll')).toBe(true);
    expect(shouldIgnoreWatcherPath('app/bin/Release/x.dll')).toBe(true);
    // A `bin/` that is NOT a build dir (e.g. a scripts dir) is preserved.
    expect(shouldIgnoreWatcherPath('src/bin/deploy.sh')).toBe(false);
  });

  it('still ignores root-level build dirs and any-depth dep caches', () => {
    expect(shouldIgnoreWatcherPath('obj/Debug/x.cache')).toBe(true);
    expect(shouldIgnoreWatcherPath('dist/bundle.js')).toBe(true);
    expect(shouldIgnoreWatcherPath('node_modules/foo/index.js')).toBe(true);
    expect(shouldIgnoreWatcherPath('app/node_modules/foo/index.js')).toBe(true);
  });

  it('does not ignore source files', () => {
    expect(shouldIgnoreWatcherPath('src/components/Button.tsx')).toBe(false);
    expect(shouldIgnoreWatcherPath('worldCupWebApp/Components/Pages/Home.razor')).toBe(false);
  });

  it('anchors root-only build dirs (dist/build/out/target) at a nested project root', () => {
    // Without a known project root, `app/dist/...` is NOT ignored — `dist` is a
    // root-only dir and segments[0] is `app`.
    expect(shouldIgnoreWatcherPath('app/dist/bundle.js')).toBe(false);
    // With `app` known as a project root, the dir is anchored there and ignored.
    expect(shouldIgnoreWatcherPath('app/dist/bundle.js', ['app'])).toBe(true);
    expect(shouldIgnoreWatcherPath('services/api/target/out.bin', ['services/api'])).toBe(true);
    // A non-matching project root prefix doesn't false-ignore.
    expect(shouldIgnoreWatcherPath('app/src/index.ts', ['app'])).toBe(false);
  });
});

describe('findProjectRoots', () => {
  function dir(path: string, entries: Array<[string, number]>) {
    tree.set(path, entries);
  }

  it('fast path: a marker at the workspace root returns just the root', async () => {
    dir('/ws', [['app.csproj', FILE], ['src', DIR]]);
    const roots = await findProjectRoots(vscode.Uri.file('/ws'));
    expect(roots.map(r => r.fsPath)).toEqual(['/ws']);
  });

  it('finds a project one level down (the dotnet-new-in-subdir case)', async () => {
    dir('/ws', [['worldCupWebApp', DIR], ['.moby-plans', DIR]]);
    dir('/ws/worldCupWebApp', [['worldCupWebApp.csproj', FILE], ['Program.cs', FILE]]);
    dir('/ws/.moby-plans', [['website.md', FILE]]);
    const roots = await findProjectRoots(vscode.Uri.file('/ws'));
    expect(roots.map(r => r.fsPath)).toEqual(['/ws/worldCupWebApp']);
  });

  it('finds a doubly-nested project root', async () => {
    dir('/ws', [['proj', DIR]]);
    dir('/ws/proj', [['proj', DIR]]);
    dir('/ws/proj/proj', [['proj.sln', FILE]]);
    const roots = await findProjectRoots(vscode.Uri.file('/ws'));
    expect(roots.map(r => r.fsPath)).toEqual(['/ws/proj/proj']);
  });

  it('does not descend into ignored directories', async () => {
    dir('/ws', [['node_modules', DIR], ['obj', DIR], ['src', DIR]]);
    dir('/ws/node_modules', [['pkg', DIR]]);
    dir('/ws/node_modules/pkg', [['package.json', FILE]]); // should NOT be discovered
    dir('/ws/src', [['util.ts', FILE]]);
    const roots = await findProjectRoots(vscode.Uri.file('/ws'));
    expect(roots).toEqual([]);
  });

  it('respects the maxDepth bound', async () => {
    dir('/ws', [['a', DIR]]);
    dir('/ws/a', [['b', DIR]]);
    dir('/ws/a/b', [['c', DIR]]);
    dir('/ws/a/b/c', [['deep.csproj', FILE]]); // depth 3 from root
    expect((await findProjectRoots(vscode.Uri.file('/ws'), { maxDepth: 2 }))).toEqual([]);
    expect((await findProjectRoots(vscode.Uri.file('/ws'), { maxDepth: 3 })).map(r => r.fsPath))
      .toEqual(['/ws/a/b/c']);
  });

  it('returns empty when no project marker exists', async () => {
    dir('/ws', [['notes.txt', FILE], ['data', DIR]]);
    dir('/ws/data', [['x.json', FILE]]);
    expect(await findProjectRoots(vscode.Uri.file('/ws'))).toEqual([]);
  });
});

describe('resolveWorkspacePath', () => {
  it('resolves a file at the workspace root', async () => {
    tree.set('/ws', [['README.md', FILE]]);
    existing.add('/ws/README.md');
    const uri = await resolveWorkspacePath('README.md');
    expect(uri?.fsPath).toBe('/ws/README.md');
  });

  it('resolves a path relative to a nested project root', async () => {
    // `Program.cs` exists only under the nested project, not at the workspace root.
    tree.set('/ws', [['worldCupWebApp', DIR]]);
    tree.set('/ws/worldCupWebApp', [['worldCupWebApp.csproj', FILE], ['Program.cs', FILE]]);
    existing.add('/ws/worldCupWebApp/Program.cs');
    const uri = await resolveWorkspacePath('Program.cs');
    expect(uri?.fsPath).toBe('/ws/worldCupWebApp/Program.cs');
  });

  it('returns an existing absolute path', async () => {
    existing.add('/elsewhere/file.ts');
    const uri = await resolveWorkspacePath('/elsewhere/file.ts');
    expect(uri?.fsPath).toBe('/elsewhere/file.ts');
  });

  it('returns null when nothing matches', async () => {
    tree.set('/ws', [['src', DIR]]);
    expect(await resolveWorkspacePath('missing.ts')).toBeNull();
  });
});
