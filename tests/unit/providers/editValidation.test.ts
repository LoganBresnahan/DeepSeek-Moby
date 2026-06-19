/**
 * Edit-safety validation engine (ADR 0006 layer 5) — discoverCheckCommand +
 * classifyCheckOutcome. Pure functions; the vscode.workspace.fs mock serves a
 * configurable directory listing + file contents per test.
 *
 * Spec: docs/architecture/integration/edit-safety.md
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { fsState } = vi.hoisted(() => ({
  fsState: { dir: [] as [string, number][], files: new Map<string, string>() },
}));

vi.mock('vscode', () => ({
  FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
  Uri: {
    joinPath: (base: any, rel: string) => ({ fsPath: `${base.fsPath}/${rel}`, _rel: rel }),
  },
  workspace: {
    fs: {
      readDirectory: vi.fn(async () => fsState.dir),
      readFile: vi.fn(async (uri: any) => {
        const content = fsState.files.get(uri._rel);
        if (content === undefined) throw new Error('ENOENT');
        return Buffer.from(content);
      }),
    },
  },
}));

import * as vscode from 'vscode';
import { discoverCheckCommand, classifyCheckOutcome } from '../../../src/providers/editValidation';

const ROOT = { fsPath: '/workspace' } as any as vscode.Uri;

/** Seed the mock fs. value = file content, or null for "present but unread marker". */
function setProject(files: Record<string, string | null>) {
  fsState.dir = Object.keys(files).map(name => [name, 1]); // FileType.File
  fsState.files = new Map(
    Object.entries(files).filter(([, v]) => v !== null) as [string, string][]
  );
}

describe('editValidation — discoverCheckCommand (ADR 0006, Phase 2)', () => {
  beforeEach(() => setProject({}));

  it('maps a .csproj to `dotnet build`', async () => {
    setProject({ 'App.csproj': null });
    expect((await discoverCheckCommand(ROOT))?.command).toBe('dotnet build');
  });

  it('maps a .sln to `dotnet build`', async () => {
    setProject({ 'App.sln': null });
    expect((await discoverCheckCommand(ROOT))?.command).toBe('dotnet build');
  });

  it('maps package.json with a build script to `npm run build`', async () => {
    setProject({ 'package.json': JSON.stringify({ scripts: { build: 'tsc', test: 'vitest' } }) });
    expect((await discoverCheckCommand(ROOT))?.command).toBe('npm run build');
  });

  it('falls back to the next npm script in priority order (test) when build/typecheck absent', async () => {
    setProject({ 'package.json': JSON.stringify({ scripts: { test: 'vitest', lint: 'eslint' } }) });
    expect((await discoverCheckCommand(ROOT))?.command).toBe('npm run test');
  });

  it('does not select npm when package.json has no runnable check script', async () => {
    setProject({ 'package.json': JSON.stringify({ scripts: { start: 'node .' } }) });
    expect(await discoverCheckCommand(ROOT)).toBeNull();
  });

  it('maps a Makefile with a check target to `make check`', async () => {
    setProject({ 'Makefile': 'check:\n\tgo vet ./...\nbuild:\n\tgo build\n' });
    expect((await discoverCheckCommand(ROOT))?.command).toBe('make check');
  });

  it('falls back to `make build` when no check target exists', async () => {
    setProject({ 'Makefile': 'build:\n\tgo build\n' });
    expect((await discoverCheckCommand(ROOT))?.command).toBe('make build');
  });

  it('maps Cargo.toml to `cargo check`', async () => {
    setProject({ 'Cargo.toml': null });
    expect((await discoverCheckCommand(ROOT))?.command).toBe('cargo check');
  });

  it('maps go.mod to `go build ./...`', async () => {
    setProject({ 'go.mod': null });
    expect((await discoverCheckCommand(ROOT))?.command).toBe('go build ./...');
  });

  it('prefers .NET over package.json when both are present', async () => {
    setProject({ 'App.csproj': null, 'package.json': JSON.stringify({ scripts: { build: 'tsc' } }) });
    expect((await discoverCheckCommand(ROOT))?.command).toBe('dotnet build');
  });

  it('returns null for an unrecognised project', async () => {
    setProject({ 'README.md': null, 'LICENSE': null });
    expect(await discoverCheckCommand(ROOT)).toBeNull();
  });

  it('returns null when the directory cannot be read', async () => {
    vi.mocked(vscode.workspace.fs.readDirectory).mockRejectedValueOnce(new Error('EACCES'));
    expect(await discoverCheckCommand(ROOT)).toBeNull();
  });

  it('tolerates a malformed package.json (returns null, no throw)', async () => {
    setProject({ 'package.json': '{ not valid json' });
    expect(await discoverCheckCommand(ROOT)).toBeNull();
  });
});

describe('editValidation — classifyCheckOutcome (ADR 0006, Phase 2)', () => {
  it('clean baseline + passing check → clean', () => {
    expect(classifyCheckOutcome({ baselineClean: true, after: { ran: true, exitCode: 0 } })).toBe('clean');
  });

  it('clean baseline + failing check → regression', () => {
    expect(classifyCheckOutcome({ baselineClean: true, after: { ran: true, exitCode: 1 } })).toBe('regression');
  });

  it('broken baseline + failing check → inconclusive (cannot attribute)', () => {
    expect(classifyCheckOutcome({ baselineClean: false, after: { ran: true, exitCode: 1 } })).toBe('inconclusive');
  });

  it('check did not run → inconclusive', () => {
    expect(classifyCheckOutcome({ baselineClean: true, after: { ran: false } })).toBe('inconclusive');
  });

  it('check timed out → inconclusive (not a regression)', () => {
    expect(classifyCheckOutcome({ baselineClean: true, after: { ran: true, timedOut: true } })).toBe('inconclusive');
  });
});
