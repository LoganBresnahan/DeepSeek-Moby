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
import { discoverCheckCommand, classifyCheckOutcome, normalizeErrors, errorSetsEqual, recordRepairRegression, FileRepairState } from '../../../src/providers/editValidation';

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

describe('editValidation — classifyCheckOutcome (ADR 0006, Phase 2 — differential)', () => {
  const clean = { ran: true, exitCode: 0, errors: [] };

  it('clean baseline + passing check → clean', () => {
    expect(classifyCheckOutcome({ baseline: clean, after: { ran: true, exitCode: 0, errors: [] } })).toBe('clean');
  });

  it('passing check → clean even when the baseline was broken (a pass needs no baseline)', () => {
    const baseline = { ran: true, exitCode: 1, errors: ['error CS1002'] };
    expect(classifyCheckOutcome({ baseline, after: { ran: true, exitCode: 0, errors: [] } })).toBe('clean');
  });

  it('clean baseline + failing check → regression (exit-code floor, no parsing needed)', () => {
    expect(classifyCheckOutcome({ baseline: clean, after: { ran: true, exitCode: 1, errors: [] } })).toBe('regression');
  });

  it('no baseline measured + failing check → inconclusive (cannot attribute)', () => {
    expect(classifyCheckOutcome({ baseline: null, after: { ran: true, exitCode: 1, errors: ['error CS1002'] } })).toBe('inconclusive');
  });

  it('broken baseline + a NEW error → regression (the ratchet catches it even from a broken start)', () => {
    const baseline = { ran: true, exitCode: 1, errors: ['a.cs: error CS1002: ; expected'] };
    const after = { ran: true, exitCode: 1, errors: ['a.cs: error CS1002: ; expected', 'a.cs: error CS0103: missing'] };
    expect(classifyCheckOutcome({ baseline, after })).toBe('regression');
  });

  it('broken baseline + only pre-existing errors → held (no worse; kept)', () => {
    const baseline = { ran: true, exitCode: 1, errors: ['a.cs: error CS1002: ; expected', 'a.cs: error CS0103: missing'] };
    const after = { ran: true, exitCode: 1, errors: ['a.cs: error CS1002: ; expected'] }; // one fixed, none added
    expect(classifyCheckOutcome({ baseline, after })).toBe('held');
  });

  it('broken baseline + an unparseable failure (no error set) → inconclusive (do not guess)', () => {
    const baseline = { ran: true, exitCode: 1, errors: ['a.cs: error CS1002'] };
    const after = { ran: true, exitCode: 1, errors: [] }; // failed but nothing recognised
    expect(classifyCheckOutcome({ baseline, after })).toBe('inconclusive');
  });

  it('check did not run → inconclusive', () => {
    expect(classifyCheckOutcome({ baseline: clean, after: { ran: false } })).toBe('inconclusive');
  });

  it('check timed out → inconclusive (not a regression)', () => {
    expect(classifyCheckOutcome({ baseline: clean, after: { ran: true, timedOut: true } })).toBe('inconclusive');
  });
});

describe('editValidation — normalizeErrors (ADR 0006, Phase 2 — error-set diff)', () => {
  it('extracts a dotnet error and strips line/col so a shifted error compares equal', () => {
    const at82 = normalizeErrors('/p/Slide.razor(82,13): error CS0103: The name \'X\' does not exist');
    const at85 = normalizeErrors('/p/Slide.razor(85,13): error CS0103: The name \'X\' does not exist');
    expect(at82).toEqual(at85);                 // line shift is invisible
    expect(at82).toHaveLength(1);
    expect(at82[0]).toContain('CS0103');
    expect(at82[0]).not.toMatch(/\d+,\d+/);     // coordinates stripped
  });

  it('returns a SET — identical errors dedupe', () => {
    const out = 'a.cs(1,1): error CS1: x\nb.cs(9,9): error CS1: x'; // same code+msg, different files
    // Different files → distinct; same file+code+msg would collapse.
    expect(normalizeErrors(out)).toHaveLength(2);
    expect(normalizeErrors('a.cs(1,1): error CS1: x\na.cs(7,1): error CS1: x')).toHaveLength(1);
  });

  it('drops count/summary lines so a changing count is not a changing error', () => {
    expect(normalizeErrors('    5 Error(s)')).toEqual([]);
    expect(normalizeErrors('Found 3 errors in 2 files.')).toEqual([]);
    expect(normalizeErrors('error: could not compile `app` due to 2 previous errors')).toEqual([]);
  });

  it('ignores non-error lines (warnings, build chatter)', () => {
    const out = 'Determining projects to restore...\nwarning CS0168: unused\nBuild succeeded.';
    expect(normalizeErrors(out)).toEqual([]);
  });

  it('returns [] when no line contains the word "error" (e.g. go build) → caller stays inconclusive', () => {
    expect(normalizeErrors('./main.go:5:2: undefined: foo')).toEqual([]);
  });

  it('returns [] for empty output', () => {
    expect(normalizeErrors('')).toEqual([]);
  });

  it('normalizes clang/javac :line:col: coordinates too', () => {
    const a = normalizeErrors('foo.c:5:1: error: expected \';\'');
    const b = normalizeErrors('foo.c:9:1: error: expected \';\'');
    expect(a).toEqual(b);
  });
});

describe('editValidation — errorSetsEqual (ADR 0006, Phase 2 — repair tracking)', () => {
  it('is order-independent', () => {
    expect(errorSetsEqual(['a', 'b'], ['b', 'a'])).toBe(true);
  });
  it('differs on length', () => {
    expect(errorSetsEqual(['a'], ['a', 'b'])).toBe(false);
  });
  it('differs on members', () => {
    expect(errorSetsEqual(['a', 'b'], ['a', 'c'])).toBe(false);
  });
  it('two empty sets are equal', () => {
    expect(errorSetsEqual([], [])).toBe(true);
  });
});

describe('editValidation — recordRepairRegression (ADR 0006, Phase 2 — per-file halt)', () => {
  const LIMIT = 3;
  let tracker: Map<string, FileRepairState>;
  beforeEach(() => { tracker = new Map(); });

  it('three different files each failing ONCE never halts (the per-file fix)', () => {
    // The exact weird flow we set out to prevent under the old turn-global count.
    expect(recordRepairRegression(tracker, ['a.cs'], ['a.cs: error CS1'], LIMIT).stuck).toEqual([]);
    expect(recordRepairRegression(tracker, ['b.cs'], ['b.cs: error CS2'], LIMIT).stuck).toEqual([]);
    expect(recordRepairRegression(tracker, ['c.cs'], ['c.cs: error CS3'], LIMIT).stuck).toEqual([]);
  });

  it('one file failing with the SAME error `limit` times in a row is stuck', () => {
    const errs = ['a.cs: error CS1: x'];
    expect(recordRepairRegression(tracker, ['a.cs'], errs, LIMIT).stuck).toEqual([]); // streak 1
    expect(recordRepairRegression(tracker, ['a.cs'], errs, LIMIT).stuck).toEqual([]); // streak 2
    const third = recordRepairRegression(tracker, ['a.cs'], errs, LIMIT);
    expect(third.streaks['a.cs']).toBe(3);
    expect(third.stuck).toEqual(['a.cs']);                                            // streak 3 → halt
  });

  it('a CHANGING error set resets the streak — a file working through different bugs is never halted', () => {
    expect(recordRepairRegression(tracker, ['a.cs'], ['a.cs: error CS1'], LIMIT).stuck).toEqual([]);
    expect(recordRepairRegression(tracker, ['a.cs'], ['a.cs: error CS2'], LIMIT).stuck).toEqual([]); // changed → reset to 1
    const r = recordRepairRegression(tracker, ['a.cs'], ['a.cs: error CS3'], LIMIT);                 // changed again → 1
    expect(r.streaks['a.cs']).toBe(1);
    expect(r.stuck).toEqual([]);
  });

  it('keyed per file — an interleaved failure on another file does not break the streak', () => {
    const aErr = ['a.cs: error CS1'];
    recordRepairRegression(tracker, ['a.cs'], aErr, LIMIT);                 // a streak 1
    recordRepairRegression(tracker, ['b.cs'], ['b.cs: error CS9'], LIMIT);  // b streak 1 (between a's failures)
    recordRepairRegression(tracker, ['a.cs'], aErr, LIMIT);                 // a streak 2 (NOT reset by b)
    const r = recordRepairRegression(tracker, ['a.cs'], aErr, LIMIT);
    expect(r.streaks['a.cs']).toBe(3);
    expect(r.stuck).toEqual(['a.cs']);
  });

  it('order-independent error sets count as the SAME failure (streak continues)', () => {
    recordRepairRegression(tracker, ['a.cs'], ['e1', 'e2'], LIMIT);
    const r = recordRepairRegression(tracker, ['a.cs'], ['e2', 'e1'], LIMIT); // same set, reordered
    expect(r.streaks['a.cs']).toBe(2);
  });
});
