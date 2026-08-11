/**
 * LSP-backed navigation tools.
 *
 * Phase 1: `outline`, `get_symbol_source` — single-file structural reads.
 * Phase 2: `find_symbol`, `find_definition`, `find_references` — workspace-
 * wide and cross-file queries via VS Code's command proxies. All tools call
 * the language server registered for the file's language; no custom indexer,
 * no daemon, no embeddings. See [docs/plans/lsp-integration.md].
 */

import * as vscode from 'vscode';
import * as path from 'path';

import { Tool, ToolCall } from '../deepseekClient';
import { LspAvailability } from '../services/lspAvailability';
import { withLspTimeout, LspTimeoutError } from '../utils/lspTimeout';

/** Per-call timeout for LSP `executeCommand` proxies. A misbehaving language
 *  server (cold rust-analyzer, deadlocked Pylance) would otherwise hang the
 *  request indefinitely. 5s matches the documented behaviour in
 *  [docs/plans/lsp-integration.md] §Risks. */
const LSP_TOOL_TIMEOUT_MS = 5_000;

const LSP_TIMEOUT_MESSAGE =
  'Error: LSP request timed out after 5s. The language server may be cold-starting, ' +
  'indexing, or hung. Try again in a few seconds, or fall back to grep + read_file for this query.';

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

export const findSymbolTool: Tool = {
  type: 'function',
  function: {
    name: 'find_symbol',
    description:
      'Search the entire workspace for symbols (functions, classes, methods) matching a name, using the language server. ' +
      'Use this when you know what you\'re looking for but not where it lives. ' +
      'More precise than grep for symbol names because it understands declarations vs references vs comments. ' +
      'Returns up to 20 matches by default (raise via maxResults).',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'The symbol name (or substring) to search for. Most LSPs support partial / fuzzy matching.'
        },
        maxResults: {
          type: 'string',
          description: 'Maximum number of results (default 20). Stringified integer.'
        }
      },
      required: ['name']
    }
  }
};

export const findDefinitionTool: Tool = {
  type: 'function',
  function: {
    name: 'find_definition',
    description:
      'Find where a symbol is defined, given a position in a file. ' +
      'Provide either `line` (1-indexed; column is auto-resolved to the first non-whitespace char) ' +
      'or `symbol` (a name to locate within the file via document symbols). ' +
      'Use this to follow a call to its declaration without grep, including across files and through interfaces.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative path to the file from the workspace root.'
        },
        line: {
          type: 'string',
          description: 'Line number where the symbol is referenced (1-indexed). Stringified integer. Provide this OR `symbol`.'
        },
        symbol: {
          type: 'string',
          description: 'Symbol name to locate inside the file (an alternative to providing a line). Useful when you have a name from outline.'
        },
        maxResults: {
          type: 'string',
          description: 'Maximum number of definition locations (default 20). Stringified integer.'
        }
      },
      required: ['path']
    }
  }
};

export const findReferencesTool: Tool = {
  type: 'function',
  function: {
    name: 'find_references',
    description:
      'Find all references to a symbol given a position in a file. ' +
      'Provide either `line` (1-indexed) or `symbol` (a name in the file). ' +
      'More accurate than grep — handles dynamic dispatch, interface implementations, and avoids matches in comments / similar names. ' +
      'Returns up to 20 matches by default (raise via maxResults).',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative path to the file from the workspace root where the symbol is declared/used.'
        },
        line: {
          type: 'string',
          description: 'Line number anchoring the symbol (1-indexed). Stringified integer. Provide this OR `symbol`.'
        },
        symbol: {
          type: 'string',
          description: 'Symbol name to locate inside the file (alternative to `line`).'
        },
        maxResults: {
          type: 'string',
          description: 'Maximum number of reference locations (default 20). Stringified integer.'
        }
      },
      required: ['path']
    }
  }
};

export const hoverTool: Tool = {
  type: 'function',
  function: {
    name: 'hover',
    description:
      'Get the type signature and documentation for a symbol, given a position in a file. ' +
      'Provide either `line` (1-indexed) or `symbol` (a name in the file). ' +
      'This is what the editor shows on mouse-over: resolved types, generics, inferred return values, and doc comments. ' +
      'Use it to learn a function\'s exact signature without reading its file, or to see what a type actually resolves to.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative path to the file from the workspace root.'
        },
        line: {
          type: 'string',
          description: 'Line number anchoring the symbol (1-indexed). Stringified integer. Provide this OR `symbol`.'
        },
        symbol: {
          type: 'string',
          description: 'Symbol name to locate inside the file (alternative to `line`).'
        }
      },
      required: ['path']
    }
  }
};

export const diagnosticsTool: Tool = {
  type: 'function',
  function: {
    name: 'get_diagnostics',
    description:
      'Get current errors and warnings (compiler, type checker, linter) for one file or the whole workspace. ' +
      'Omit `path` for every problem VS Code currently knows about; pass `path` to focus one file. ' +
      'Use this after editing to check your change actually compiles, and before editing to see what is already broken. ' +
      'Note: a file VS Code has not analyzed yet reports no diagnostics — that is not proof the file is clean.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative path to a single file from the workspace root. Omit for the whole workspace.'
        },
        severity: {
          type: 'string',
          description: 'Lowest severity to include: "error", "warning" (default), "info", or "hint".'
        },
        maxResults: {
          type: 'string',
          description: 'Maximum number of diagnostics (default 20). Stringified integer.'
        }
      },
      required: []
    }
  }
};

/** Bundle of LSP tools that get conditionally attached to the request. */
export const lspTools: Tool[] = [
  outlineTool,
  getSymbolSourceTool,
  findSymbolTool,
  findDefinitionTool,
  findReferencesTool,
  hoverTool,
  diagnosticsTool
];

const DEFAULT_MAX_RESULTS = 20;
const MAX_RESULTS_CAP = 100;

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
  const result = await withLspTimeout(
    vscode.commands.executeCommand<DocumentSymbolLike[] | undefined>(
      'vscode.executeDocumentSymbolProvider',
      uri
    ),
    LSP_TOOL_TIMEOUT_MS
  );
  if (!result) return null;
  return result;
}

/**
 * Resolve a file's languageId by opening the document. Used to feed
 * `LspAvailability.reportToolResult` after a tool call so the per-language
 * map self-corrects from real observations.
 */
async function getLanguageId(uri: vscode.Uri): Promise<string> {
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    return doc.languageId || '';
  } catch {
    return '';
  }
}

async function outline(workspacePath: string, relPath: string): Promise<string> {
  const abs = resolveWorkspacePath(workspacePath, relPath);
  if (!abs) return 'Error: Cannot read files outside the workspace';

  const uri = vscode.Uri.file(abs);
  let symbols: DocumentSymbolLike[] | null;
  try {
    symbols = await fetchDocumentSymbols(uri);
  } catch (e) {
    if (e instanceof LspTimeoutError) return LSP_TIMEOUT_MESSAGE;
    const msg = e instanceof Error ? e.message : String(e);
    return `Error: LSP request failed for ${relPath}: ${msg}`;
  }

  // Adaptive correction — feed back per-language availability based on
  // what we just observed. Empty results downgrade only after the
  // service's consecutive-empty threshold so a single stub file doesn't
  // poison the language.
  const langId = await getLanguageId(uri);
  if (langId) {
    LspAvailability.getInstance().reportToolResult(
      langId,
      Array.isArray(symbols) && symbols.length > 0,
      uri.fsPath
    );
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
    if (e instanceof LspTimeoutError) return LSP_TIMEOUT_MESSAGE;
    const msg = e instanceof Error ? e.message : String(e);
    return `Error: LSP request failed for ${relPath}: ${msg}`;
  }

  const langId = await getLanguageId(uri);
  if (langId) {
    LspAvailability.getInstance().reportToolResult(
      langId,
      Array.isArray(symbols) && symbols.length > 0,
      uri.fsPath
    );
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

// ── Phase 2 helpers — cross-file / workspace queries ──────────────────────

interface LocationLike {
  uri: { fsPath: string };
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
}

interface LocationLinkLike {
  targetUri: { fsPath: string };
  targetRange: { start: { line: number; character: number }; end: { line: number; character: number } };
}

interface SymbolInformationLike {
  name: string;
  kind: number;
  location: { uri: { fsPath: string }; range: { start: { line: number; character: number }; end?: { line: number; character: number } } };
  containerName?: string;
}

function normalizeLocation(loc: LocationLike | LocationLinkLike): LocationLike {
  if ('targetUri' in loc) {
    return { uri: loc.targetUri, range: loc.targetRange };
  }
  return loc;
}

function parseMaxResults(arg: string | undefined): number {
  if (!arg) return DEFAULT_MAX_RESULTS;
  const n = parseInt(arg, 10);
  if (Number.isNaN(n) || n < 1) return DEFAULT_MAX_RESULTS;
  return Math.min(n, MAX_RESULTS_CAP);
}

/** Resolve `(file, line)` or `(file, symbol)` to a concrete LSP position. */
async function resolvePosition(
  workspacePath: string,
  relPath: string,
  line: string | undefined,
  symbolName: string | undefined
): Promise<{ uri: vscode.Uri; line: number; character: number } | { error: string }> {
  const abs = resolveWorkspacePath(workspacePath, relPath);
  if (!abs) return { error: 'Cannot read files outside the workspace' };
  const uri = vscode.Uri.file(abs);

  // Symbol takes precedence — it's a more precise anchor than a bare line.
  if (symbolName) {
    let symbols: DocumentSymbolLike[] | null;
    try {
      symbols = await fetchDocumentSymbols(uri);
    } catch (e) {
      if (e instanceof LspTimeoutError) {
        return { error: `LSP request timed out resolving "${symbolName}" in ${relPath}. Try again or pass an explicit line.` };
      }
      const msg = e instanceof Error ? e.message : String(e);
      return { error: `LSP request failed for ${relPath}: ${msg}` };
    }
    if (!symbols || symbols.length === 0) {
      return { error: `No symbols found in ${relPath} (LSP may be unavailable for this language)` };
    }
    const matches = findSymbols(symbols, symbolName);
    if (matches.length === 0) {
      return { error: `No symbol named "${symbolName}" in ${relPath}` };
    }
    return {
      uri,
      line: matches[0].range.start.line,
      character: matches[0].range.start.character
    };
  }

  if (line !== undefined && line !== '') {
    const lineNum = parseInt(line, 10);
    if (Number.isNaN(lineNum) || lineNum < 1) {
      return { error: `Invalid line number "${line}" — must be a positive integer (1-indexed)` };
    }
    let doc: vscode.TextDocument;
    try {
      doc = await vscode.workspace.openTextDocument(uri);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { error: `Cannot open ${relPath}: ${msg}` };
    }
    const allLines = doc.getText().split('\n');
    const lineIdx = lineNum - 1;
    if (lineIdx >= allLines.length) {
      return { error: `Line ${lineNum} exceeds file length (${allLines.length} lines)` };
    }
    const lineText = allLines[lineIdx];
    const charIdx = lineText.search(/\S/);
    return { uri, line: lineIdx, character: charIdx >= 0 ? charIdx : 0 };
  }

  return { error: 'Must provide either "line" or "symbol" to anchor the position' };
}

/** Open each unique fsPath once, return map fsPath → split-by-line. */
async function loadDocLines(items: { uri: { fsPath: string } }[]): Promise<Map<string, string[]>> {
  const cache = new Map<string, string[]>();
  for (const item of items) {
    const fsPath = item.uri.fsPath;
    if (cache.has(fsPath)) continue;
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fsPath));
      cache.set(fsPath, doc.getText().split('\n'));
    } catch {
      cache.set(fsPath, []);
    }
  }
  return cache;
}

function formatLocationsWithSnippets(
  items: LocationLike[],
  docLines: Map<string, string[]>,
  label: string,
  truncatedFrom: number | null
): string {
  const header = truncatedFrom !== null
    ? `${label} (${items.length} of ${truncatedFrom}):`
    : `${label} (${items.length}):`;
  const lines: string[] = [header];
  for (const item of items) {
    const fsPath = item.uri.fsPath;
    const lineIdx = item.range.start.line;
    const oneLine = lineIdx + 1;
    const fileLines = docLines.get(fsPath) ?? [];
    const snippet = fileLines[lineIdx]?.trim() ?? '';
    lines.push(`  ${fsPath}:${oneLine}: ${snippet}`);
  }
  if (truncatedFrom !== null) {
    lines.push(`  ... ${truncatedFrom - items.length} more truncated. Narrow your query (or raise maxResults) for the rest.`);
  }
  return lines.join('\n');
}

async function findSymbol(query: string, maxResults: string | undefined): Promise<string> {
  let result: SymbolInformationLike[] | undefined;
  try {
    result = await withLspTimeout(
      vscode.commands.executeCommand<SymbolInformationLike[] | undefined>(
        'vscode.executeWorkspaceSymbolProvider',
        query
      ),
      LSP_TOOL_TIMEOUT_MS
    );
  } catch (e) {
    if (e instanceof LspTimeoutError) return LSP_TIMEOUT_MESSAGE;
    const msg = e instanceof Error ? e.message : String(e);
    return `Error: LSP request failed: ${msg}`;
  }

  if (!result || result.length === 0) {
    return `No workspace symbols match "${query}". The language server may still be indexing, or no servers are installed for the relevant languages.`;
  }

  const limit = parseMaxResults(maxResults);
  const truncated = result.length > limit;
  const items = result.slice(0, limit);

  const lines: string[] = [
    truncated
      ? `Workspace symbols matching "${query}" (${items.length} of ${result.length}):`
      : `Workspace symbols matching "${query}" (${items.length}):`
  ];
  for (const sym of items) {
    const oneLine = sym.location.range.start.line + 1;
    const container = sym.containerName ? ` in ${sym.containerName}` : '';
    lines.push(`  ${sym.location.uri.fsPath}:${oneLine} (${kindLabel(sym.kind)}) ${sym.name}${container}`);
  }
  if (truncated) {
    lines.push(`  ... ${result.length - limit} more truncated. Narrow query (or raise maxResults).`);
  }
  return lines.join('\n');
}

async function findDefinition(
  workspacePath: string,
  relPath: string,
  line: string | undefined,
  symbolName: string | undefined,
  maxResults: string | undefined
): Promise<string> {
  const resolved = await resolvePosition(workspacePath, relPath, line, symbolName);
  if ('error' in resolved) return `Error: ${resolved.error}`;

  let raw: (LocationLike | LocationLinkLike)[] | undefined;
  try {
    raw = await withLspTimeout(
      vscode.commands.executeCommand<(LocationLike | LocationLinkLike)[] | undefined>(
        'vscode.executeDefinitionProvider',
        resolved.uri,
        new vscode.Position(resolved.line, resolved.character)
      ),
      LSP_TOOL_TIMEOUT_MS
    );
  } catch (e) {
    if (e instanceof LspTimeoutError) return LSP_TIMEOUT_MESSAGE;
    const msg = e instanceof Error ? e.message : String(e);
    return `Error: LSP request failed: ${msg}`;
  }

  const langId = await getLanguageId(resolved.uri);
  if (langId) {
    LspAvailability.getInstance().reportToolResult(
      langId,
      Array.isArray(raw) && raw.length > 0,
      resolved.uri.fsPath
    );
  }

  if (!raw || raw.length === 0) {
    return `No definitions found for position ${relPath}:${resolved.line + 1}. The language server may not be installed for this file's language.`;
  }

  const limit = parseMaxResults(maxResults);
  const truncated = raw.length > limit;
  const normalized = raw.slice(0, limit).map(normalizeLocation);
  const docLines = await loadDocLines(normalized);
  return formatLocationsWithSnippets(normalized, docLines, 'Definitions', truncated ? raw.length : null);
}

async function findReferences(
  workspacePath: string,
  relPath: string,
  line: string | undefined,
  symbolName: string | undefined,
  maxResults: string | undefined
): Promise<string> {
  const resolved = await resolvePosition(workspacePath, relPath, line, symbolName);
  if ('error' in resolved) return `Error: ${resolved.error}`;

  let raw: LocationLike[] | undefined;
  try {
    raw = await withLspTimeout(
      vscode.commands.executeCommand<LocationLike[] | undefined>(
        'vscode.executeReferenceProvider',
        resolved.uri,
        new vscode.Position(resolved.line, resolved.character)
      ),
      LSP_TOOL_TIMEOUT_MS
    );
  } catch (e) {
    if (e instanceof LspTimeoutError) return LSP_TIMEOUT_MESSAGE;
    const msg = e instanceof Error ? e.message : String(e);
    return `Error: LSP request failed: ${msg}`;
  }

  const langId = await getLanguageId(resolved.uri);
  if (langId) {
    LspAvailability.getInstance().reportToolResult(
      langId,
      Array.isArray(raw) && raw.length > 0,
      resolved.uri.fsPath
    );
  }

  if (!raw || raw.length === 0) {
    return `No references found for position ${relPath}:${resolved.line + 1}. The language server may not be installed for this file's language.`;
  }

  const limit = parseMaxResults(maxResults);
  const truncated = raw.length > limit;
  const items = raw.slice(0, limit);
  const docLines = await loadDocLines(items);
  return formatLocationsWithSnippets(items, docLines, 'References', truncated ? raw.length : null);
}

/** VS Code's Hover: `contents` is markdown strings, plain strings, or
 *  `{language, value}` code blocks depending on the server. */
interface HoverLike {
  contents?: unknown;
  range?: { start: { line: number; character: number } };
}

/** Flatten one hover content entry to text. */
function hoverContentToText(entry: unknown): string {
  if (typeof entry === 'string') return entry;
  if (entry && typeof entry === 'object') {
    const value = (entry as { value?: unknown }).value;
    if (typeof value === 'string') return value;
  }
  return '';
}

async function hover(
  workspacePath: string,
  relPath: string,
  line: string | undefined,
  symbolName: string | undefined
): Promise<string> {
  const resolved = await resolvePosition(workspacePath, relPath, line, symbolName);
  if ('error' in resolved) return `Error: ${resolved.error}`;

  let raw: HoverLike[] | undefined;
  try {
    raw = await withLspTimeout(
      vscode.commands.executeCommand<HoverLike[] | undefined>(
        'vscode.executeHoverProvider',
        resolved.uri,
        new vscode.Position(resolved.line, resolved.character)
      ),
      LSP_TOOL_TIMEOUT_MS
    );
  } catch (e) {
    if (e instanceof LspTimeoutError) return LSP_TIMEOUT_MESSAGE;
    const msg = e instanceof Error ? e.message : String(e);
    return `Error: LSP request failed: ${msg}`;
  }

  const texts: string[] = [];
  for (const h of raw ?? []) {
    const contents = Array.isArray(h?.contents) ? h.contents : [h?.contents];
    for (const c of contents) {
      const text = hoverContentToText(c).trim();
      if (text) texts.push(text);
    }
  }

  const langId = await getLanguageId(resolved.uri);
  if (langId) {
    LspAvailability.getInstance().reportToolResult(langId, texts.length > 0, resolved.uri.fsPath);
  }

  if (texts.length === 0) {
    return `No hover information at ${relPath}:${resolved.line + 1}. The language server may not be installed for this file's language, or the position may not be on a symbol.`;
  }

  return `Hover at ${relPath}:${resolved.line + 1}\n\n${texts.join('\n\n')}`;
}

const SEVERITY_LABELS = ['Error', 'Warning', 'Info', 'Hint'];
const SEVERITY_ORDER: Record<string, number> = { error: 0, warning: 1, info: 2, hint: 3 };

/**
 * Current problems from VS Code's diagnostic collection.
 *
 * Deliberately NOT an LSP round trip — `vscode.languages.getDiagnostics` reads
 * the collection any extension may have published, so this works for linters
 * and type checkers that expose no symbol provider, and needs no timeout.
 *
 * The honest caveat, surfaced in the tool description: diagnostics for a file
 * VS Code has never analyzed are simply absent. We open the document first to
 * prompt analysis, but a cold server may still not have published by the time
 * we read, so "no diagnostics" is not proof of "no problems".
 */
async function getDiagnostics(
  workspacePath: string,
  relPath: string | undefined,
  severity: string | undefined,
  maxResults: string | undefined
): Promise<string> {
  const threshold = SEVERITY_ORDER[(severity ?? 'warning').toLowerCase()] ?? 1;

  let entries: Array<[vscode.Uri, readonly vscode.Diagnostic[]]>;
  if (relPath) {
    const abs = resolveWorkspacePath(workspacePath, relPath);
    if (!abs) return 'Error: Cannot read files outside the workspace';
    const uri = vscode.Uri.file(abs);
    try {
      // Opening prompts the language server to analyze a file the user
      // never touched; without it a closed file reports nothing.
      await vscode.workspace.openTextDocument(uri);
    } catch {
      return `Error: Cannot open ${relPath}`;
    }
    entries = [[uri, vscode.languages.getDiagnostics(uri) ?? []]];
  } else {
    entries = (vscode.languages.getDiagnostics() ?? []) as Array<[vscode.Uri, readonly vscode.Diagnostic[]]>;
  }

  const rows: string[] = [];
  let total = 0;
  const limit = parseMaxResults(maxResults);
  for (const [uri, diags] of entries) {
    for (const d of diags ?? []) {
      const sev = typeof d.severity === 'number' ? d.severity : 0;
      if (sev > threshold) continue;
      total++;
      if (rows.length >= limit) continue;
      const where = `${uri.fsPath}:${d.range.start.line + 1}:${d.range.start.character + 1}`;
      const source = d.source ? ` [${d.source}]` : '';
      const code = d.code !== undefined && d.code !== null
        ? ` (${typeof d.code === 'object' ? String((d.code as { value?: unknown }).value ?? '') : String(d.code)})`
        : '';
      rows.push(`  ${SEVERITY_LABELS[sev] ?? 'Error'}${source}${code} ${where}\n    ${d.message}`);
    }
  }

  const scope = relPath ? relPath : 'workspace';
  if (total === 0) {
    return `No diagnostics at or above "${severity ?? 'warning'}" for ${scope}. ` +
      `Note this can also mean the file has not been analyzed yet.`;
  }

  const header = rows.length < total
    ? `Diagnostics for ${scope} (${rows.length} of ${total}):`
    : `Diagnostics for ${scope} (${total}):`;
  const out = [header, ...rows];
  if (rows.length < total) {
    out.push(`  ... ${total - rows.length} more truncated. Narrow with path, or raise maxResults.`);
  }
  return out.join('\n');
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
  const isLspTool =
    name === 'outline' ||
    name === 'get_symbol_source' ||
    name === 'find_symbol' ||
    name === 'find_definition' ||
    name === 'find_references' ||
    name === 'hover' ||
    name === 'get_diagnostics';
  if (!isLspTool) return null;

  let args: Record<string, string>;
  try {
    args = JSON.parse(toolCall.function.arguments);
  } catch (e) {
    return `Error: Invalid arguments - ${e instanceof Error ? e.message : String(e)}`;
  }

  if (name === 'find_symbol') {
    if (!args.name) return 'Error: Missing required argument "name"';
    return findSymbol(args.name, args.maxResults);
  }

  // `path` is optional here — no argument means the whole workspace.
  if (name === 'get_diagnostics') {
    return getDiagnostics(workspacePath, args.path, args.severity, args.maxResults);
  }

  if (!args.path) return 'Error: Missing required argument "path"';

  switch (name) {
    case 'outline':
      return outline(workspacePath, args.path);
    case 'get_symbol_source':
      if (!args.symbol) return 'Error: Missing required argument "symbol"';
      return getSymbolSource(workspacePath, args.path, args.symbol);
    case 'find_definition':
      return findDefinition(workspacePath, args.path, args.line, args.symbol, args.maxResults);
    case 'find_references':
      return findReferences(workspacePath, args.path, args.line, args.symbol, args.maxResults);
    case 'hover':
      return hover(workspacePath, args.path, args.line, args.symbol);
  }

  return null;
}
