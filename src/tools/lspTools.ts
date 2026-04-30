/**
 * LSP-backed navigation tools (Phase 1: outline + get_symbol_source).
 *
 * Both tools delegate to VS Code's `executeDocumentSymbolProvider` command,
 * which proxies to whatever language server is registered for the file's
 * language. No custom indexer; no daemon. The LSP is already running for
 * any language the user has installed.
 *
 * Phase 1 scope is single-file only — no `find_definition`, `find_references`,
 * or workspace-wide `find_symbol`. See [docs/plans/lsp-integration.md].
 */

import * as vscode from 'vscode';
import * as path from 'path';

import { Tool, ToolCall } from '../deepseekClient';

/** Minimal shape we depend on. VS Code's DocumentSymbol type matches. */
interface DocumentSymbolLike {
  name: string;
  kind: number;
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  children?: DocumentSymbolLike[];
}

export const outlineTool: Tool = {
  type: 'function',
  function: {
    name: 'outline',
    description:
      'List the symbol structure of a file (functions, classes, methods, exports) using the language server. ' +
      'Use this before reading a large file to see what is in it without paying for the full body. ' +
      'Returns a tree of symbols with line numbers. Faster and cheaper than read_file when you only need orientation.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative path to the file from the workspace root (e.g., "src/auth/middleware.ts").'
        }
      },
      required: ['path']
    }
  }
};

export const getSymbolSourceTool: Tool = {
  type: 'function',
  function: {
    name: 'get_symbol_source',
    description:
      'Read the source of a specific symbol (function, class, method) from a file using the language server. ' +
      'Use this when you need the body of one symbol without reading the rest of the file. ' +
      'If the symbol name appears more than once (overloads, multiple of the same name), all matches are returned.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative path to the file from the workspace root.'
        },
        symbol: {
          type: 'string',
          description: 'The symbol name to retrieve (e.g., "validateToken", "User", "handleClick").'
        }
      },
      required: ['path', 'symbol']
    }
  }
};

/** Bundle of LSP tools that get conditionally attached to the request. */
export const lspTools: Tool[] = [outlineTool, getSymbolSourceTool];

/**
 * Map VS Code's SymbolKind enum (numeric) to a short readable label.
 * Mirror of `vscode.SymbolKind` values — kept local so tests and runtime
 * agree without depending on the live enum (which is a regular enum,
 * not numeric-only across versions).
 */
const SYMBOL_KIND_LABELS: Record<number, string> = {
  0: 'file',
  1: 'module',
  2: 'namespace',
  3: 'package',
  4: 'class',
  5: 'method',
  6: 'property',
  7: 'field',
  8: 'constructor',
  9: 'enum',
  10: 'interface',
  11: 'function',
  12: 'variable',
  13: 'constant',
  14: 'string',
  15: 'number',
  16: 'boolean',
  17: 'array',
  18: 'object',
  19: 'key',
  20: 'null',
  21: 'enum-member',
  22: 'struct',
  23: 'event',
  24: 'operator',
  25: 'type-parameter'
};

function kindLabel(kind: number): string {
  return SYMBOL_KIND_LABELS[kind] ?? `kind-${kind}`;
}

/** Resolve a workspace-relative path to an absolute fsPath; reject escapes. */
function resolveWorkspacePath(workspacePath: string, relPath: string): string | null {
  const abs = path.resolve(workspacePath, relPath);
  const normalizedRoot = path.resolve(workspacePath);
  if (!abs.startsWith(normalizedRoot + path.sep) && abs !== normalizedRoot) {
    return null;
  }
  return abs;
}

/** Recursively walk a symbol tree, calling `visit` on each node. */
function walkSymbols(
  symbols: DocumentSymbolLike[],
  visit: (sym: DocumentSymbolLike, depth: number) => void,
  depth = 0
): void {
  for (const sym of symbols) {
    visit(sym, depth);
    if (sym.children?.length) {
      walkSymbols(sym.children, visit, depth + 1);
    }
  }
}

/** Find every symbol matching `name` (recursive). Returns empty array on no match. */
function findSymbols(symbols: DocumentSymbolLike[], name: string): DocumentSymbolLike[] {
  const matches: DocumentSymbolLike[] = [];
  walkSymbols(symbols, (sym) => {
    if (sym.name === name) matches.push(sym);
  });
  return matches;
}

/** Collect all top-level symbol names for "did you mean" hints on no match. */
function collectAllNames(symbols: DocumentSymbolLike[]): string[] {
  const names: string[] = [];
  walkSymbols(symbols, (sym) => names.push(sym.name));
  return names;
}

async function fetchDocumentSymbols(uri: vscode.Uri): Promise<DocumentSymbolLike[] | null> {
  const result = await vscode.commands.executeCommand<DocumentSymbolLike[] | undefined>(
    'vscode.executeDocumentSymbolProvider',
    uri
  );
  if (!result) return null;
  return result;
}

async function outline(workspacePath: string, relPath: string): Promise<string> {
  const abs = resolveWorkspacePath(workspacePath, relPath);
  if (!abs) return 'Error: Cannot read files outside the workspace';

  const uri = vscode.Uri.file(abs);
  let symbols: DocumentSymbolLike[] | null;
  try {
    symbols = await fetchDocumentSymbols(uri);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return `Error: LSP request failed for ${relPath}: ${msg}`;
  }

  if (!symbols || symbols.length === 0) {
    return `No symbols found in ${relPath}. The language server may not be installed for this file's language, or the file may be empty. Falling back to read_file may help.`;
  }

  const lines: string[] = [`File: ${relPath}`];
  walkSymbols(symbols, (sym, depth) => {
    const indent = '  '.repeat(depth);
    const line = sym.range.start.line + 1;
    lines.push(`${indent}- ${kindLabel(sym.kind)} ${sym.name} (line ${line})`);
  });

  return lines.join('\n');
}

async function getSymbolSource(
  workspacePath: string,
  relPath: string,
  symbolName: string
): Promise<string> {
  const abs = resolveWorkspacePath(workspacePath, relPath);
  if (!abs) return 'Error: Cannot read files outside the workspace';

  const uri = vscode.Uri.file(abs);
  let symbols: DocumentSymbolLike[] | null;
  try {
    symbols = await fetchDocumentSymbols(uri);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return `Error: LSP request failed for ${relPath}: ${msg}`;
  }

  if (!symbols || symbols.length === 0) {
    return `No symbols found in ${relPath}. The language server may not be installed for this file's language. Falling back to read_file may help.`;
  }

  const matches = findSymbols(symbols, symbolName);
  if (matches.length === 0) {
    const available = collectAllNames(symbols).slice(0, 20);
    return (
      `No symbol named "${symbolName}" in ${relPath}. ` +
      `Available symbols (up to 20): ${available.join(', ')}.`
    );
  }

  let doc: vscode.TextDocument;
  try {
    doc = await vscode.workspace.openTextDocument(uri);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return `Error: Cannot open ${relPath}: ${msg}`;
  }

  const sections: string[] = [];
  if (matches.length > 1) {
    sections.push(`Found ${matches.length} symbols named "${symbolName}" in ${relPath}:`);
  }

  for (const sym of matches) {
    const startLine = sym.range.start.line + 1;
    const endLine = sym.range.end.line + 1;
    const range = new vscode.Range(
      sym.range.start.line,
      sym.range.start.character,
      sym.range.end.line,
      sym.range.end.character
    );
    const source = doc.getText(range);
    sections.push(
      `${relPath}:${startLine}-${endLine} (${kindLabel(sym.kind)})\n` +
      '─'.repeat(50) + '\n' +
      source
    );
  }

  return sections.join('\n\n');
}

/**
 * Dispatch an LSP tool call. Returns null if the tool name isn't handled
 * here, so the parent dispatcher (workspaceTools.executeToolCall) knows to
 * try its own switch.
 */
export async function executeLspTool(
  workspacePath: string,
  toolCall: ToolCall
): Promise<string | null> {
  const name = toolCall.function.name;
  if (name !== 'outline' && name !== 'get_symbol_source') return null;

  let args: Record<string, string>;
  try {
    args = JSON.parse(toolCall.function.arguments);
  } catch (e) {
    return `Error: Invalid arguments - ${e instanceof Error ? e.message : String(e)}`;
  }

  if (!args.path) return 'Error: Missing required argument "path"';

  if (name === 'outline') {
    return outline(workspacePath, args.path);
  }

  if (!args.symbol) return 'Error: Missing required argument "symbol"';
  return getSymbolSource(workspacePath, args.path, args.symbol);
}
