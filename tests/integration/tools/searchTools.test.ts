import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as cp from 'child_process';
import * as vscode from 'vscode';

import { executeToolCall } from '../../../src/tools/workspaceTools';
import type { ToolCall } from '../../../src/deepseekClient';

/**
 * The `grep` tool against REAL search binaries on a REAL directory.
 *
 * The unit tier mocks `child_process` wholesale, which is why it happily
 * passed for months while the tool returned "No matches found" for every
 * query in production: a mock never rejects bad arguments and never reports
 * ENOENT. Only an actually-spawned searcher can show that.
 *
 * Whichever of ripgrep/grep this machine has is the one that runs — the
 * assertions are about the tool's contract, not about which binary served it.
 */

let fixtureDir: string;

function makeToolCall(name: string, args: Record<string, string>): ToolCall {
  return {
    id: 'call_1',
    type: 'function',
    function: { name, arguments: JSON.stringify(args) }
  } as ToolCall;
}

function has(bin: string): boolean {
  const r = cp.spawnSync(bin, ['--version'], { encoding: 'utf-8', timeout: 3000 });
  return !r.error && r.status === 0;
}

beforeAll(() => {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moby-grep-'));
  fs.mkdirSync(path.join(fixtureDir, 'src'));
  fs.mkdirSync(path.join(fixtureDir, 'node_modules', 'pkg'), { recursive: true });

  fs.writeFileSync(
    path.join(fixtureDir, 'src', 'alpha.ts'),
    'const needleOne = 1;\nexport function reachable() {}\n'
  );
  fs.writeFileSync(
    path.join(fixtureDir, 'src', 'beta.js'),
    'const needleTwo = 2;\n'
  );
  // Must never appear in results — the exclude globs are load-bearing.
  fs.writeFileSync(
    path.join(fixtureDir, 'node_modules', 'pkg', 'index.js'),
    'const needleOne = "from node_modules";\n'
  );

  (vscode.workspace as { workspaceFolders: unknown[] }).workspaceFolders = [
    { uri: { fsPath: fixtureDir }, name: 'fixture', index: 0 }
  ];
});

afterAll(() => {
  fs.rmSync(fixtureDir, { recursive: true, force: true });
  (vscode.workspace as { workspaceFolders: unknown[] }).workspaceFolders = [];
});

describe('grep against real search binaries', () => {
  it('at least one searcher is available on this machine', () => {
    // If this fails, every assertion below is vacuous rather than passing.
    expect(has('rg') || has('grep')).toBe(true);
  });

  it('finds a literal match and never reports a clean miss for one', async () => {
    const result = await executeToolCall(makeToolCall('grep', { query: 'needleOne' }));

    expect(result).not.toContain('No matches found');
    expect(result).not.toContain('Error:');
    expect(result).toContain('alpha.ts');
  });

  it('honours the extended-regex syntax the model actually writes', async () => {
    // `(a|b)` and `+` are the exact constructs plain BRE silently drops.
    const result = await executeToolCall(makeToolCall('grep', { query: 'needle(One|Two)' }));

    expect(result).not.toContain('No matches found');
    expect(result).toContain('alpha.ts');
    expect(result).toContain('beta.js');
  });

  it('excludes node_modules', async () => {
    const result = await executeToolCall(makeToolCall('grep', { query: 'from node_modules' }));

    expect(result).toContain('No matches found');
  });

  it('scopes to filePattern', async () => {
    const result = await executeToolCall(makeToolCall('grep', {
      query: 'needle',
      filePattern: '*.ts'
    }));

    expect(result).toContain('alpha.ts');
    expect(result).not.toContain('beta.js');
  });

  it('reports a genuine miss as a miss', async () => {
    const result = await executeToolCall(makeToolCall('grep', { query: 'zzz_no_such_token_zzz' }));

    expect(result).toContain('No matches found');
    expect(result).not.toContain('Error:');
  });

  it('treats a leading-dash query as a pattern, not a flag', async () => {
    const result = await executeToolCall(makeToolCall('grep', { query: '-needle' }));

    // No match in the fixture, but it must be a clean miss, not a usage error.
    expect(result).toContain('No matches found');
  });

  it('ripgrep accepts the exact argument vector the tool builds', () => {
    if (!has('rg')) return;

    // The regression that started this: `--type-not binary` is not a
    // ripgrep type, so every invocation exited 2 before matching anything.
    const r = cp.spawnSync('rg', [
      '-n', '--max-count', '3', '-C', '1',
      '-g', '!node_modules', '-g', '!.git',
      '-g', '!*.min.js', '-g', '!*.min.css',
      '-g', '!package-lock.json', '-g', '!yarn.lock',
      '-e', 'needleOne', '.'
    ], { cwd: fixtureDir, encoding: 'utf-8', timeout: 10000 });

    expect(r.error).toBeUndefined();
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });
});
