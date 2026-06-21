/**
 * workspacePaths
 *
 * Shared helpers for reasoning about where things live in a workspace when the
 * workspace root is NOT the project root (ADR 0012). Two concerns:
 *
 *  1. Ignoring dependency/build/cache directories (`shouldIgnoreWatcherPath`) —
 *     used to keep generated files (e.g. `obj/`, `bin/Debug/`, `node_modules/`)
 *     out of the file-change pipeline, the Modified Files UI, and the
 *     verification gate.
 *  2. Finding the actual project root(s) under a workspace (`findProjectRoots`)
 *     and resolving a path against them (`resolveWorkspacePath`) — used by the
 *     edit-safety check-command discovery and file-context attachment so they
 *     work when the project sits in a subdirectory.
 */

import * as vscode from 'vscode';
import * as path from 'path';

// ============================================
// Ignore lists (moved from requestOrchestrator)
// ============================================

/**
 * Directories ignored at ANY depth — dependency caches and tooling output that
 * are never source, wherever they appear in the tree.
 * Covers dependency, cache, and tooling directories across all major languages.
 */
const WATCHER_IGNORE_SEGMENTS = new Set([
  // VCS
  '.git', '.svn', '.hg', 'CVS',
  // JavaScript/TypeScript
  'node_modules', '.next', '.nuxt', '.svelte-kit', '.turbo',
  '.parcel-cache', '.cache', '.vite', '.npm', 'bower_components',
  'jspm_packages', 'web_modules', '.yarn', '.pnpm-store',
  'coverage', '.nyc_output', '.eslintcache', 'storybook-static',
  // Python
  '__pycache__', '.venv', 'venv', '.tox', '.nox',
  '.mypy_cache', '.pytest_cache', '.ruff_cache', '.hypothesis',
  '.pybuilder', '.eggs', 'htmlcov', '.ipynb_checkpoints',
  // Java/Kotlin
  '.gradle', '.idea', '.kotlin', '.konan',
  // C/C++
  'CMakeFiles', '.ccache', 'vcpkg_installed', '_deps',
  // C#/.NET — `obj/` is unambiguously build output at any depth; `bin/` is
  // ignored only when followed by a build config (see BUILD_CONFIG_RE below),
  // because `bin/` can be a legitimate scripts directory.
  '.vs', 'TestResults', 'packages', 'obj',
  // Go (module cache is global, not in-project)
  // Rust
  // (target/ is root-only below)
  // PHP
  '.phpunit.cache',
  // Ruby
  '.bundle', '.yardoc', '_yardoc',
  // Swift/Objective-C
  'Pods', 'Carthage', 'DerivedData', '.swiftpm', 'xcuserdata',
  // Dart/Flutter
  '.dart_tool',
  // Elixir/Erlang
  'deps', '_build', '.elixir_ls', '.fetch', 'ebin',
  '_checkouts', '.rebar', '.rebar3', '.eunit',
  // Haskell
  '.stack-work', '.cabal-sandbox', '.hpc',
  // Scala
  '.bloop', '.metals', '.bsp',
  // Perl
  'blib', 'cover_db',
  // Lua
  'lua_modules', '.luarocks',
  // R
  'renv', 'packrat', '.Rproj.user', 'rsconnect',
  // Lisp/Scheme
  'compiled',
  // OS
  '.DS_Store',
]);

/**
 * Directories ignored only at the **root of a project** (the workspace root, or
 * a discovered nested project root). These names can be legitimate source
 * subdirectories deeper in a tree (`src/build/`, `docs/`, `inc/`), so they are
 * only ignored when they sit directly at a project root.
 */
const WATCHER_IGNORE_ROOT_DIRS = new Set([
  'dist', 'build', 'Build', 'out', 'output',
  'target', 'vendor', 'bin', 'obj',
  'Debug', 'Release', 'artifacts',
  'tmp', 'pkg', 'doc', 'docs',
  'local', 'inc',
]);

/** A `bin/` child segment that marks the parent `bin/` as build output (a .NET
 *  TFM/config) rather than a scripts directory. */
const BUILD_CONFIG_RE = /^(Debug|Release|net\d|netstandard|netcoreapp|x64|x86|AnyCPU|win-|linux-|osx-|browser-)/i;

/** Project marker files that identify a directory as a project root. Matched by
 *  exact name, except `.csproj`/`.sln` which match by suffix. */
const PROJECT_MARKER_NAMES = new Set([
  'package.json', 'Cargo.toml', 'go.mod', 'Makefile', 'GNUmakefile',
  'pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle',
  'pyproject.toml', 'setup.py', 'composer.json', 'Gemfile',
  'mix.exs', 'pubspec.yaml', 'CMakeLists.txt',
]);

function hasProjectMarker(fileNames: string[]): boolean {
  return fileNames.some(n =>
    n.endsWith('.csproj') || n.endsWith('.sln') || PROJECT_MARKER_NAMES.has(n));
}

function splitSegments(relativePath: string): string[] {
  return relativePath.split(/[\\/]/).filter(Boolean);
}

/** True if the build-output dir name at `segments[idx]` should be ignored —
 *  the `WATCHER_IGNORE_ROOT_DIRS` rule anchored at an arbitrary index. */
function isBuildDirAt(segments: string[], idx: number): boolean {
  return idx < segments.length && WATCHER_IGNORE_ROOT_DIRS.has(segments[idx]);
}

/**
 * Whether a workspace-relative path is generated/ignorable and should be kept
 * out of the file-change pipeline.
 *
 * `projectRoots` (workspace-relative, e.g. `["app", "service"]`) lets root-only
 * build dirs (`dist/`, `build/`, `out/`, `target/`, `bin/`) be recognised when
 * they sit at a *nested* project root, not just the workspace root — the case
 * that previously leaked `obj/` and `bin/Debug/` from a subdirectory project.
 * The `.NET` artifacts (`obj/`, `bin/<config>/`) are caught structurally at any
 * depth, so they are filtered even before a project root is resolved.
 */
export function shouldIgnoreWatcherPath(relativePath: string, projectRoots: string[] = []): boolean {
  const segments = splitSegments(relativePath);
  if (segments.length === 0) return false;

  // Any-depth: dependency/cache/tooling dirs (incl. `obj/`).
  for (let i = 0; i < segments.length; i++) {
    if (WATCHER_IGNORE_SEGMENTS.has(segments[i])) return true;
    // `bin/` followed by a build config (Debug/Release/net*/RID) is build output.
    if (segments[i] === 'bin' && i + 1 < segments.length && BUILD_CONFIG_RE.test(segments[i + 1])) {
      return true;
    }
  }

  // Root-only build dirs at the workspace root.
  if (isBuildDirAt(segments, 0)) return true;

  // Root-only build dirs anchored at a discovered (nested) project root.
  for (const root of projectRoots) {
    const rootSegs = splitSegments(root);
    if (rootSegs.length === 0) continue; // workspace root already handled above
    if (rootSegs.every((s, i) => segments[i] === s)) {
      if (isBuildDirAt(segments, rootSegs.length)) return true;
    }
  }

  return false;
}

// ============================================
// Project-root discovery
// ============================================

/**
 * Find the nearest project root(s) under a workspace via a bounded breadth-first
 * search. A directory is a project root if it contains a recognised marker
 * (`.csproj`/`.sln`/`package.json`/`Cargo.toml`/`go.mod`/`Makefile`/…). The
 * search does not descend into a found root (its subtree belongs to it) nor into
 * ignored directories, and stops at `maxDepth`.
 *
 * Fast path: a marker at the workspace root returns immediately with just the
 * root — zero behavioural change for conventionally-structured repos. Returned
 * nearest-first (shallower roots before deeper).
 */
export async function findProjectRoots(
  workspaceRoot: vscode.Uri,
  opts?: { maxDepth?: number }
): Promise<vscode.Uri[]> {
  const maxDepth = opts?.maxDepth ?? 3;
  const roots: vscode.Uri[] = [];
  const queue: Array<{ uri: vscode.Uri; depth: number }> = [{ uri: workspaceRoot, depth: 0 }];

  while (queue.length > 0) {
    const { uri, depth } = queue.shift()!;
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(uri);
    } catch {
      continue;
    }

    const fileNames = entries
      .filter(([, type]) => (type & vscode.FileType.File) !== 0)
      .map(([name]) => name);

    if (hasProjectMarker(fileNames)) {
      roots.push(uri);
      continue; // a found root owns its subtree — don't descend further
    }

    if (depth < maxDepth) {
      for (const [name, type] of entries) {
        if ((type & vscode.FileType.Directory) === 0) continue;
        if (WATCHER_IGNORE_SEGMENTS.has(name) || WATCHER_IGNORE_ROOT_DIRS.has(name)) continue;
        if (name.startsWith('.')) continue;
        queue.push({ uri: vscode.Uri.joinPath(uri, name), depth: depth + 1 });
      }
    }
  }

  return roots;
}

/** Convert project-root URIs to workspace-relative path strings (for
 *  `shouldIgnoreWatcherPath`). The workspace root itself maps to `''`. */
export function toWorkspaceRelativeRoots(roots: vscode.Uri[]): string[] {
  return roots.map(uri => vscode.workspace.asRelativePath(uri, false))
    // asRelativePath returns the fsPath unchanged when the uri IS the workspace
    // root; normalise that to '' so callers treat it as the root anchor.
    .map(rel => (rel.includes(path.sep) || rel.length > 0 ? rel : ''));
}

/**
 * Resolve a (possibly project-root-relative) path to an existing file URI,
 * trying the workspace root first and then each discovered project root. Returns
 * null if nothing matches. Absolute paths are returned if they exist.
 *
 * This is why attaching `Program.cs` works even when the `.csproj` lives in a
 * subdirectory: the path resolves against the project root, not just the
 * workspace root.
 */
export async function resolveWorkspacePath(filePath: string): Promise<vscode.Uri | null> {
  const ws = vscode.workspace.workspaceFolders?.[0];
  if (!ws) return null;

  const tryStat = async (uri: vscode.Uri): Promise<vscode.Uri | null> => {
    try {
      await vscode.workspace.fs.stat(uri);
      return uri;
    } catch {
      return null;
    }
  };

  if (path.isAbsolute(filePath)) {
    return tryStat(vscode.Uri.file(filePath));
  }

  // Workspace root first (the common case), then nested project roots.
  const direct = await tryStat(vscode.Uri.joinPath(ws.uri, filePath));
  if (direct) return direct;

  for (const root of await findProjectRoots(ws.uri)) {
    const hit = await tryStat(vscode.Uri.joinPath(root, filePath));
    if (hit) return hit;
  }

  return null;
}
