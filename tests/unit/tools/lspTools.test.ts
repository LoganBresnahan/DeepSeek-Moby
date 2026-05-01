/**
 * Tests for LSP-backed tools (Phase 1: outline + get_symbol_source).
 *
 * Mocks `vscode.commands.executeCommand` to return synthetic DocumentSymbol
 * trees. Mocks `vscode.workspace.openTextDocument` to return a synthetic
 * document whose `getText(range)` slices a fixture string by Range. Real
 * filesystem access is NOT used — Phase 1 logic is purely "what the LSP
 * gave us, formatted for the model."
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as vscode from 'vscode';

import { executeLspTool } from '../../../src/tools/lspTools';
import { LspAvailability } from '../../../src/services/lspAvailability';

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

// ── Phase 2 tests ────────────────────────────────────────────────────────

interface FakeLocation {
  uri: { fsPath: string };
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
}

function loc(fsPath: string, startLine: number, startChar: number, endLine = startLine, endChar = startChar + 5): FakeLocation {
  return {
    uri: { fsPath },
    range: { start: { line: startLine, character: startChar }, end: { line: endLine, character: endChar } }
  };
}

/**
 * Mock command dispatcher dispatches by command name. Each command name
 * maps to a function that receives the rest of the args and returns a
 * value (or throws). Lets one test set up multiple LSP responses
 * (e.g. document symbols for resolvePosition, then references).
 */
function mockCommands(handlers: Record<string, (...args: any[]) => any>) {
  (vscode.commands.executeCommand as any).mockImplementation(async (cmd: string, ...rest: any[]) => {
    const handler = handlers[cmd];
    if (!handler) return undefined;
    return handler(...rest);
  });
}

describe('executeLspTool — find_symbol', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('formats workspace symbol matches with kind, container, absolute path', async () => {
    mockCommands({
      'vscode.executeWorkspaceSymbolProvider': () => ([
        {
          name: 'authMiddleware',
          kind: vscode.SymbolKind.Function,
          location: { uri: { fsPath: '/workspace/src/auth/middleware.ts' }, range: { start: { line: 127, character: 0 } } }
        },
        {
          name: 'authMiddleware',
          kind: vscode.SymbolKind.Variable,
          location: { uri: { fsPath: '/workspace/src/api/routes.ts' }, range: { start: { line: 13, character: 4 } } },
          containerName: 'Router'
        }
      ])
    });

    const result = await executeLspTool(WORKSPACE, makeCall('find_symbol', { name: 'authMiddleware' }));

    expect(result).toContain('Workspace symbols matching "authMiddleware" (2)');
    expect(result).toContain('/workspace/src/auth/middleware.ts:128 (function) authMiddleware');
    expect(result).toContain('/workspace/src/api/routes.ts:14 (variable) authMiddleware in Router');
  });

  it('truncates results past maxResults with hint', async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      name: 'foo',
      kind: vscode.SymbolKind.Function,
      location: { uri: { fsPath: `/workspace/file-${i}.ts` }, range: { start: { line: 0, character: 0 } } }
    }));
    mockCommands({ 'vscode.executeWorkspaceSymbolProvider': () => many });

    const result = await executeLspTool(WORKSPACE, makeCall('find_symbol', { name: 'foo' }));

    expect(result).toContain('(20 of 30)');
    expect(result).toContain('10 more truncated');
  });

  it('respects custom maxResults arg', async () => {
    const many = Array.from({ length: 50 }, (_, i) => ({
      name: 'foo',
      kind: vscode.SymbolKind.Function,
      location: { uri: { fsPath: `/workspace/file-${i}.ts` }, range: { start: { line: 0, character: 0 } } }
    }));
    mockCommands({ 'vscode.executeWorkspaceSymbolProvider': () => many });

    const result = await executeLspTool(WORKSPACE, makeCall('find_symbol', { name: 'foo', maxResults: '5' }));
    expect(result).toContain('(5 of 50)');
  });

  it('returns no-results hint when LSP gives empty', async () => {
    mockCommands({ 'vscode.executeWorkspaceSymbolProvider': () => [] });
    const result = await executeLspTool(WORKSPACE, makeCall('find_symbol', { name: 'doesNotExist' }));
    expect(result).toMatch(/No workspace symbols/);
  });

  it('returns error on missing name arg', async () => {
    const result = await executeLspTool(WORKSPACE, makeCall('find_symbol', {}));
    expect(result).toMatch(/Missing required argument "name"/);
  });
});

describe('executeLspTool — find_definition', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves position by line + returns formatted definition with snippet', async () => {
    const callerText = [
      'import { validateToken } from "./middleware";',  // line 0
      'app.use(validateToken);'                          // line 1
    ].join('\n');
    const targetText = [
      '// header',                                                            // line 0
      'export function validateToken(token: string): boolean {',              // line 1
      '  return token.length > 0;'                                            // line 2
    ].join('\n');

    mockCommands({
      'vscode.executeDefinitionProvider': () => ([
        loc('/workspace/src/middleware.ts', 1, 16, 1, 29)
      ])
    });
    // openTextDocument is called for both line resolution AND snippet extraction.
    (vscode.workspace.openTextDocument as any).mockImplementation(async (uri: any) => {
      const text = uri.fsPath.includes('middleware.ts') ? targetText : callerText;
      const fileLines = text.split('\n');
      return {
        getText: (r?: any) => {
          if (!r) return text;
          return fileLines.slice(r.start.line, r.end.line + 1).join('\n');
        }
      };
    });

    const result = await executeLspTool(
      WORKSPACE,
      makeCall('find_definition', { path: 'src/caller.ts', line: '2' })
    );

    expect(result).toContain('Definitions (1):');
    expect(result).toContain('/workspace/src/middleware.ts:2: export function validateToken');
  });

  it('resolves position by symbol name via documentSymbolProvider', async () => {
    mockCommands({
      'vscode.executeDocumentSymbolProvider': () => ([
        { name: 'handleClick', kind: vscode.SymbolKind.Function, range: range(41, 0, 50, 1) }
      ]),
      'vscode.executeDefinitionProvider': () => ([
        loc('/workspace/src/handlers.ts', 41, 0, 41, 11)
      ])
    });
    (vscode.workspace.openTextDocument as any).mockImplementation(async () => ({
      getText: () => 'function handleClick() {\n  return 1;\n}'
    }));

    const result = await executeLspTool(
      WORKSPACE,
      makeCall('find_definition', { path: 'src/handlers.ts', symbol: 'handleClick' })
    );

    expect(result).toContain('Definitions (1):');
    expect(result).toContain('/workspace/src/handlers.ts:42:');
  });

  it('handles LocationLink shape from modern LSPs', async () => {
    mockCommands({
      'vscode.executeDocumentSymbolProvider': () => ([
        { name: 'foo', kind: vscode.SymbolKind.Function, range: range(0, 0, 5, 1) }
      ]),
      'vscode.executeDefinitionProvider': () => ([
        {
          targetUri: { fsPath: '/workspace/src/lib.ts' },
          targetRange: { start: { line: 9, character: 0 }, end: { line: 12, character: 1 } }
        }
      ])
    });
    (vscode.workspace.openTextDocument as any).mockImplementation(async () => ({
      getText: () => 'line0\nline1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nfunction foo() {\nbody\n}'
    }));

    const result = await executeLspTool(
      WORKSPACE,
      makeCall('find_definition', { path: 'src/main.ts', symbol: 'foo' })
    );

    expect(result).toContain('/workspace/src/lib.ts:10:');
    expect(result).toContain('function foo()');
  });

  it('returns error when neither line nor symbol provided', async () => {
    const result = await executeLspTool(
      WORKSPACE,
      makeCall('find_definition', { path: 'src/foo.ts' })
    );
    expect(result).toMatch(/Must provide either "line" or "symbol"/);
  });

  it('returns error on invalid line', async () => {
    const result = await executeLspTool(
      WORKSPACE,
      makeCall('find_definition', { path: 'src/foo.ts', line: 'abc' })
    );
    expect(result).toMatch(/Invalid line number/);
  });

  it('returns no-definitions hint when LSP returns empty', async () => {
    mockCommands({
      'vscode.executeDefinitionProvider': () => []
    });
    (vscode.workspace.openTextDocument as any).mockImplementation(async () => ({
      getText: () => '  somecall();'
    }));

    const result = await executeLspTool(
      WORKSPACE,
      makeCall('find_definition', { path: 'src/foo.ts', line: '1' })
    );
    expect(result).toMatch(/No definitions found/);
  });
});

describe('executeLspTool — find_references', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns reference list with snippets and absolute paths', async () => {
    const targetText = [
      'export function validateToken(t: string) { return true; }',  // line 0
      ''                                                              // line 1
    ].join('\n');
    const routesText = [
      'import { validateToken } from "./middleware";',  // line 0
      'app.use(validateToken);',                         // line 1
      'validateToken(req.headers.authorization);'        // line 2
    ].join('\n');

    mockCommands({
      'vscode.executeReferenceProvider': () => ([
        loc('/workspace/src/api/routes.ts', 1, 8),
        loc('/workspace/src/api/routes.ts', 2, 0)
      ])
    });
    (vscode.workspace.openTextDocument as any).mockImplementation(async (uri: any) => {
      const text = uri.fsPath.includes('routes.ts') ? routesText : targetText;
      return {
        getText: () => text
      };
    });

    const result = await executeLspTool(
      WORKSPACE,
      makeCall('find_references', { path: 'src/middleware.ts', line: '1' })
    );

    expect(result).toContain('References (2):');
    expect(result).toContain('/workspace/src/api/routes.ts:2: app.use(validateToken);');
    expect(result).toContain('/workspace/src/api/routes.ts:3: validateToken(req.headers.authorization);');
  });

  it('truncates long reference lists', async () => {
    const many = Array.from({ length: 35 }, (_, i) => loc(`/workspace/file-${i}.ts`, 0, 0));
    mockCommands({ 'vscode.executeReferenceProvider': () => many });
    (vscode.workspace.openTextDocument as any).mockImplementation(async () => ({
      getText: () => 'something'
    }));

    const result = await executeLspTool(
      WORKSPACE,
      makeCall('find_references', { path: 'src/foo.ts', line: '1' })
    );

    expect(result).toContain('(20 of 35)');
    expect(result).toContain('15 more truncated');
  });

  it('returns no-references hint when LSP returns empty', async () => {
    mockCommands({ 'vscode.executeReferenceProvider': () => [] });
    (vscode.workspace.openTextDocument as any).mockImplementation(async () => ({
      getText: () => '  foo();'
    }));

    const result = await executeLspTool(
      WORKSPACE,
      makeCall('find_references', { path: 'src/foo.ts', line: '1' })
    );
    expect(result).toMatch(/No references found/);
  });
});

// ── Timeout safety tests ─────────────────────────────────────────────────
//
// A misbehaving LSP (cold rust-analyzer, deadlocked Pylance, hung indexer)
// must not stall the request indefinitely. Every executeCommand call into
// the LSP is wrapped with `withLspTimeout` (5s). On timeout the tool
// surfaces a descriptive error so the model can fall back to grep/read_file.

describe('executeLspTool — timeout safety', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Make every LSP executeCommand call hang forever — exercises the timer. */
  function makeAllCommandsHang() {
    (vscode.commands.executeCommand as any).mockImplementation(
      () => new Promise(() => { /* never resolves */ })
    );
  }

  it('outline: surfaces a timeout error when documentSymbolProvider hangs', async () => {
    makeAllCommandsHang();
    const promise = executeLspTool(WORKSPACE, makeCall('outline', { path: 'src/foo.ts' }));
    await vi.advanceTimersByTimeAsync(5_001);
    const result = await promise;
    expect(result).toMatch(/LSP request timed out after 5s/);
    expect(result).toMatch(/grep \+ read_file/);
  });

  it('get_symbol_source: surfaces a timeout error when documentSymbolProvider hangs', async () => {
    makeAllCommandsHang();
    const promise = executeLspTool(
      WORKSPACE,
      makeCall('get_symbol_source', { path: 'src/foo.ts', symbol: 'handleClick' })
    );
    await vi.advanceTimersByTimeAsync(5_001);
    const result = await promise;
    expect(result).toMatch(/LSP request timed out after 5s/);
  });

  it('find_symbol: surfaces a timeout error when workspaceSymbolProvider hangs', async () => {
    makeAllCommandsHang();
    const promise = executeLspTool(WORKSPACE, makeCall('find_symbol', { name: 'handleClick' }));
    await vi.advanceTimersByTimeAsync(5_001);
    const result = await promise;
    expect(result).toMatch(/LSP request timed out after 5s/);
  });

  it('find_definition: surfaces a timeout error when definitionProvider hangs', async () => {
    // resolvePosition uses the line path → openTextDocument is called, then
    // executeDefinitionProvider hangs. Mock openTextDocument to succeed
    // synchronously so we can isolate the LSP-side hang.
    (vscode.workspace.openTextDocument as any).mockImplementation(async () => ({
      getText: () => '  validateToken(req);'
    }));
    (vscode.commands.executeCommand as any).mockImplementation(
      (cmd: string) => {
        if (cmd === 'vscode.executeDefinitionProvider') return new Promise(() => {});
        return undefined;
      }
    );

    const promise = executeLspTool(
      WORKSPACE,
      makeCall('find_definition', { path: 'src/foo.ts', line: '1' })
    );
    await vi.advanceTimersByTimeAsync(5_001);
    const result = await promise;
    expect(result).toMatch(/LSP request timed out after 5s/);
  });

  it('find_references: surfaces a timeout error when referenceProvider hangs', async () => {
    (vscode.workspace.openTextDocument as any).mockImplementation(async () => ({
      getText: () => '  validateToken(req);'
    }));
    (vscode.commands.executeCommand as any).mockImplementation(
      (cmd: string) => {
        if (cmd === 'vscode.executeReferenceProvider') return new Promise(() => {});
        return undefined;
      }
    );

    const promise = executeLspTool(
      WORKSPACE,
      makeCall('find_references', { path: 'src/foo.ts', line: '1' })
    );
    await vi.advanceTimersByTimeAsync(5_001);
    const result = await promise;
    expect(result).toMatch(/LSP request timed out after 5s/);
  });

  it('find_definition (symbol path): surfaces a distinct error when documentSymbolProvider hangs during position resolution', async () => {
    (vscode.commands.executeCommand as any).mockImplementation(
      (cmd: string) => {
        if (cmd === 'vscode.executeDocumentSymbolProvider') return new Promise(() => {});
        return undefined;
      }
    );

    const promise = executeLspTool(
      WORKSPACE,
      makeCall('find_definition', { path: 'src/foo.ts', symbol: 'handleClick' })
    );
    await vi.advanceTimersByTimeAsync(5_001);
    const result = await promise;
    // Position-resolution timeout has its own message — it suggests passing a line as a workaround.
    expect(result).toMatch(/timed out resolving "handleClick"/);
    expect(result).toMatch(/pass an explicit line/);
  });

  it('outline: distinguishes a non-timeout LSP error from a timeout', async () => {
    (vscode.commands.executeCommand as any).mockImplementation(async () => {
      throw new Error('rust-analyzer: provider crashed');
    });
    const result = await executeLspTool(WORKSPACE, makeCall('outline', { path: 'src/foo.rs' }));
    expect(result).toMatch(/LSP request failed/);
    expect(result).toMatch(/rust-analyzer: provider crashed/);
    expect(result).not.toMatch(/timed out/);
  });
});

// ── Adaptive availability feedback ───────────────────────────────────────
//
// Tools call `LspAvailability.reportToolResult` after every LSP query so
// the per-language map self-corrects from real observations. These tests
// pin the contract: success upgrades, failures don't poison on a single
// stub file (handled by the service's threshold), and the right languageId
// is fed in.

describe('executeLspTool — adaptive availability feedback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    LspAvailability.getInstance().invalidate();
    (vscode.workspace.openTextDocument as any).mockImplementation(async () => ({
      languageId: 'ruby',
      getText: () => 'class Foo; end\n'
    }));
  });

  it('outline: reports tool-success with the file languageId on non-empty symbols', async () => {
    const reportSpy = vi.spyOn(LspAvailability.getInstance(), 'reportToolResult');
    mockSymbolsResponse([
      { name: 'Foo', kind: vscode.SymbolKind.Class, range: range(0, 0, 0, 14) }
    ]);

    await executeLspTool(WORKSPACE, makeCall('outline', { path: 'src/foo.rb' }));

    expect(reportSpy).toHaveBeenCalledWith('ruby', true, expect.stringContaining('foo.rb'));
    reportSpy.mockRestore();
  });

  it('outline: reports tool-failure when LSP returns empty array', async () => {
    const reportSpy = vi.spyOn(LspAvailability.getInstance(), 'reportToolResult');
    mockSymbolsResponse([]);

    await executeLspTool(WORKSPACE, makeCall('outline', { path: 'src/foo.rb' }));

    expect(reportSpy).toHaveBeenCalledWith('ruby', false, expect.stringContaining('foo.rb'));
    reportSpy.mockRestore();
  });

  it('does NOT call reportToolResult when LSP throws (avoids feedback poisoning on transient errors)', async () => {
    const reportSpy = vi.spyOn(LspAvailability.getInstance(), 'reportToolResult');
    (vscode.commands.executeCommand as any).mockRejectedValue(new Error('bang'));

    const result = await executeLspTool(WORKSPACE, makeCall('outline', { path: 'src/foo.rb' }));
    expect(result).toMatch(/LSP request failed/);
    expect(reportSpy).not.toHaveBeenCalled();
    reportSpy.mockRestore();
  });

  it('find_definition: reports tool-success on non-empty results', async () => {
    const reportSpy = vi.spyOn(LspAvailability.getInstance(), 'reportToolResult');
    mockCommands({
      'vscode.executeDefinitionProvider': () => ([
        loc('/workspace/src/foo.rb', 5, 0)
      ])
    });
    (vscode.workspace.openTextDocument as any).mockImplementation(async () => ({
      languageId: 'ruby',
      getText: () => 'def foo\n  1\nend\n'
    }));

    await executeLspTool(
      WORKSPACE,
      makeCall('find_definition', { path: 'src/foo.rb', line: '1' })
    );

    expect(reportSpy).toHaveBeenCalledWith('ruby', true, expect.stringContaining('foo.rb'));
    reportSpy.mockRestore();
  });
});

// ── maxResults edge cases ────────────────────────────────────────────────

describe('executeLspTool — maxResults edge cases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('falls back to default 20 when maxResults is non-numeric', async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      name: 'foo',
      kind: vscode.SymbolKind.Function,
      location: { uri: { fsPath: `/workspace/file-${i}.ts` }, range: { start: { line: 0, character: 0 } } }
    }));
    mockCommands({ 'vscode.executeWorkspaceSymbolProvider': () => many });

    const result = await executeLspTool(
      WORKSPACE,
      makeCall('find_symbol', { name: 'foo', maxResults: 'not-a-number' })
    );
    expect(result).toContain('(20 of 30)');
  });

  it('falls back to default 20 when maxResults is 0 or negative', async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      name: 'foo',
      kind: vscode.SymbolKind.Function,
      location: { uri: { fsPath: `/workspace/file-${i}.ts` }, range: { start: { line: 0, character: 0 } } }
    }));
    mockCommands({ 'vscode.executeWorkspaceSymbolProvider': () => many });

    const result = await executeLspTool(
      WORKSPACE,
      makeCall('find_symbol', { name: 'foo', maxResults: '-5' })
    );
    expect(result).toContain('(20 of 30)');
  });

  it('caps maxResults at MAX_RESULTS_CAP (100) even if a much larger value is passed', async () => {
    const many = Array.from({ length: 200 }, (_, i) => ({
      name: 'foo',
      kind: vscode.SymbolKind.Function,
      location: { uri: { fsPath: `/workspace/file-${i}.ts` }, range: { start: { line: 0, character: 0 } } }
    }));
    mockCommands({ 'vscode.executeWorkspaceSymbolProvider': () => many });

    const result = await executeLspTool(
      WORKSPACE,
      makeCall('find_symbol', { name: 'foo', maxResults: '500' })
    );
    expect(result).toContain('(100 of 200)');
  });
});

// ── find_references missing-coverage gap-fillers ─────────────────────────

describe('executeLspTool — find_references additional shapes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves position by symbol name (not just line)', async () => {
    mockCommands({
      'vscode.executeDocumentSymbolProvider': () => ([
        { name: 'validateToken', kind: vscode.SymbolKind.Function, range: range(10, 0, 20, 1) }
      ]),
      'vscode.executeReferenceProvider': () => ([
        loc('/workspace/src/api.ts', 5, 0)
      ])
    });
    (vscode.workspace.openTextDocument as any).mockImplementation(async () => ({
      getText: () => 'line0\nline1\nline2\nline3\nline4\nvalidateToken()\n'
    }));

    const result = await executeLspTool(
      WORKSPACE,
      makeCall('find_references', { path: 'src/middleware.ts', symbol: 'validateToken' })
    );

    expect(result).toContain('References (1):');
    expect(result).toContain('/workspace/src/api.ts:6: validateToken()');
  });
});

describe('executeLspTool — find_definition position resolution edge cases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns error when line exceeds file length', async () => {
    (vscode.workspace.openTextDocument as any).mockImplementation(async () => ({
      getText: () => 'one\ntwo\nthree' // 3 lines
    }));

    const result = await executeLspTool(
      WORKSPACE,
      makeCall('find_definition', { path: 'src/short.ts', line: '99' })
    );
    expect(result).toMatch(/Line 99 exceeds file length/);
  });
});
