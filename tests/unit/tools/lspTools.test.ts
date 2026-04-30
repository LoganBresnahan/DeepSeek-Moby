/**
 * Tests for LSP-backed tools (Phase 1: outline + get_symbol_source).
 *
 * Mocks `vscode.commands.executeCommand` to return synthetic DocumentSymbol
 * trees. Mocks `vscode.workspace.openTextDocument` to return a synthetic
 * document whose `getText(range)` slices a fixture string by Range. Real
 * filesystem access is NOT used — Phase 1 logic is purely "what the LSP
 * gave us, formatted for the model."
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as vscode from 'vscode';

import { executeLspTool } from '../../../src/tools/lspTools';

const WORKSPACE = '/workspace';

interface SymStub {
  name: string;
  kind: number;
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  children?: SymStub[];
}

function range(startLine: number, startChar: number, endLine: number, endChar: number) {
  return {
    start: { line: startLine, character: startChar },
    end: { line: endLine, character: endChar }
  };
}

function makeCall(name: string, args: Record<string, unknown>) {
  return {
    id: 'call_test',
    type: 'function' as const,
    function: { name, arguments: JSON.stringify(args) }
  };
}

function mockSymbolsResponse(symbols: SymStub[] | undefined) {
  (vscode.commands.executeCommand as any).mockImplementation(
    async (cmd: string) => {
      if (cmd === 'vscode.executeDocumentSymbolProvider') return symbols;
      return undefined;
    }
  );
}

function mockOpenDocument(text: string) {
  const lines = text.split('\n');
  (vscode.workspace.openTextDocument as any).mockImplementation(async () => ({
    getText: (r?: { start: { line: number; character: number }; end: { line: number; character: number } }) => {
      if (!r) return text;
      const startLine = r.start.line;
      const endLine = r.end.line;
      if (startLine === endLine) {
        return lines[startLine].slice(r.start.character, r.end.character);
      }
      const out: string[] = [];
      out.push(lines[startLine].slice(r.start.character));
      for (let i = startLine + 1; i < endLine; i++) out.push(lines[i]);
      out.push(lines[endLine].slice(0, r.end.character));
      return out.join('\n');
    }
  }));
}

describe('executeLspTool — outline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns formatted symbol tree with kind labels and 1-indexed line numbers', async () => {
    mockSymbolsResponse([
      { name: 'handleClick', kind: vscode.SymbolKind.Function, range: range(41, 0, 50, 1) },
      {
        name: 'User',
        kind: vscode.SymbolKind.Class,
        range: range(87, 0, 120, 1),
        children: [
          { name: 'save', kind: vscode.SymbolKind.Method, range: range(94, 2, 105, 3) },
          { name: 'validate', kind: vscode.SymbolKind.Method, range: range(109, 2, 119, 3) }
        ]
      }
    ]);

    const result = await executeLspTool(WORKSPACE, makeCall('outline', { path: 'src/foo.ts' }));

    expect(result).toContain('File: src/foo.ts');
    expect(result).toContain('- function handleClick (line 42)');
    expect(result).toContain('- class User (line 88)');
    expect(result).toContain('  - method save (line 95)');
    expect(result).toContain('  - method validate (line 110)');
  });

  it('returns a no-symbols hint when LSP returns undefined (no language server)', async () => {
    mockSymbolsResponse(undefined);

    const result = await executeLspTool(WORKSPACE, makeCall('outline', { path: 'src/bar.ts' }));
    expect(result).toMatch(/No symbols found/);
    expect(result).toMatch(/language server may not be installed/);
  });

  it('rejects paths that escape the workspace', async () => {
    mockSymbolsResponse([]);
    const result = await executeLspTool(WORKSPACE, makeCall('outline', { path: '../outside.ts' }));
    expect(result).toMatch(/Cannot read files outside the workspace/);
  });

  it('returns descriptive error when LSP throws', async () => {
    (vscode.commands.executeCommand as any).mockRejectedValue(new Error('LSP timeout'));
    const result = await executeLspTool(WORKSPACE, makeCall('outline', { path: 'src/foo.ts' }));
    expect(result).toMatch(/LSP request failed/);
    expect(result).toMatch(/LSP timeout/);
  });

  it('returns error on missing required arg', async () => {
    const result = await executeLspTool(WORKSPACE, makeCall('outline', {}));
    expect(result).toMatch(/Missing required argument "path"/);
  });
});

describe('executeLspTool — get_symbol_source', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the sliced source for a single match', async () => {
    const fileText = [
      'import x from "y";',                      // line 0
      '',                                         // line 1
      'export function validateToken(t: string) {', // line 2
      '  return t.length > 0;',                  // line 3
      '}',                                        // line 4
      ''                                          // line 5
    ].join('\n');

    mockSymbolsResponse([
      { name: 'validateToken', kind: vscode.SymbolKind.Function, range: range(2, 0, 4, 1) }
    ]);
    mockOpenDocument(fileText);

    const result = await executeLspTool(
      WORKSPACE,
      makeCall('get_symbol_source', { path: 'src/auth.ts', symbol: 'validateToken' })
    );

    expect(result).toContain('src/auth.ts:3-5 (function)');
    expect(result).toContain('export function validateToken(t: string) {');
    expect(result).toContain('return t.length > 0;');
  });

  it('returns all matches when symbol name appears multiple times', async () => {
    const fileText = [
      'class A { save() { return 1; } }',     // line 0
      'class B { save() { return 2; } }'      // line 1
    ].join('\n');

    mockSymbolsResponse([
      {
        name: 'A',
        kind: vscode.SymbolKind.Class,
        range: range(0, 0, 0, 33),
        children: [{ name: 'save', kind: vscode.SymbolKind.Method, range: range(0, 10, 0, 30) }]
      },
      {
        name: 'B',
        kind: vscode.SymbolKind.Class,
        range: range(1, 0, 1, 33),
        children: [{ name: 'save', kind: vscode.SymbolKind.Method, range: range(1, 10, 1, 30) }]
      }
    ]);
    mockOpenDocument(fileText);

    const result = await executeLspTool(
      WORKSPACE,
      makeCall('get_symbol_source', { path: 'src/models.ts', symbol: 'save' })
    );

    expect(result).toContain('Found 2 symbols named "save"');
    expect(result).toContain('src/models.ts:1-1');
    expect(result).toContain('src/models.ts:2-2');
  });

  it('returns "did you mean" hint when symbol not found', async () => {
    mockSymbolsResponse([
      { name: 'handleClick', kind: vscode.SymbolKind.Function, range: range(0, 0, 5, 1) },
      { name: 'handleSubmit', kind: vscode.SymbolKind.Function, range: range(7, 0, 12, 1) }
    ]);

    const result = await executeLspTool(
      WORKSPACE,
      makeCall('get_symbol_source', { path: 'src/handlers.ts', symbol: 'handleHover' })
    );

    expect(result).toContain('No symbol named "handleHover"');
    expect(result).toContain('handleClick');
    expect(result).toContain('handleSubmit');
  });

  it('returns no-symbols hint when LSP gives empty array', async () => {
    mockSymbolsResponse([]);
    const result = await executeLspTool(
      WORKSPACE,
      makeCall('get_symbol_source', { path: 'src/empty.ts', symbol: 'anything' })
    );
    expect(result).toMatch(/No symbols found/);
  });

  it('returns error on missing symbol arg', async () => {
    const result = await executeLspTool(
      WORKSPACE,
      makeCall('get_symbol_source', { path: 'src/foo.ts' })
    );
    expect(result).toMatch(/Missing required argument "symbol"/);
  });
});

describe('executeLspTool — dispatch', () => {
  it('returns null for unhandled tool names so parent dispatcher proceeds', async () => {
    const result = await executeLspTool(WORKSPACE, makeCall('read_file', { path: 'src/foo.ts' }));
    expect(result).toBeNull();
  });
});
