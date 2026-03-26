/**
 * Mock VS Code API for testing extension-side code
 */

import { vi } from 'vitest';

// Mock output channel
export const mockOutputChannel = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  trace: vi.fn(),
  show: vi.fn(),
  clear: vi.fn(),
  dispose: vi.fn(),
  append: vi.fn(),
  appendLine: vi.fn(),
  replace: vi.fn(),
  name: 'DeepSeek Moby',
  logLevel: 1
};

// Mock configuration
export const mockConfiguration = {
  get: vi.fn().mockReturnValue('INFO'),
  has: vi.fn().mockReturnValue(true),
  inspect: vi.fn(),
  update: vi.fn()
};

// Mock disposable
export const mockDisposable = {
  dispose: vi.fn()
};

// Exported VS Code namespace mock
export const window = {
  createOutputChannel: vi.fn(() => mockOutputChannel),
  showInformationMessage: vi.fn(),
  showWarningMessage: vi.fn(),
  showErrorMessage: vi.fn(),
  showInputBox: vi.fn(),
  showQuickPick: vi.fn(),
  createTextEditorDecorationType: vi.fn(),
  activeTextEditor: undefined,
  visibleTextEditors: [],
  onDidChangeActiveTextEditor: vi.fn(() => mockDisposable),
  onDidChangeTextEditorSelection: vi.fn(() => mockDisposable)
};

export const workspace = {
  getConfiguration: vi.fn(() => mockConfiguration),
  onDidChangeConfiguration: vi.fn(() => mockDisposable),
  workspaceFolders: [],
  fs: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    delete: vi.fn(),
    createDirectory: vi.fn()
  },
  openTextDocument: vi.fn(),
  applyEdit: vi.fn(),
  createFileSystemWatcher: vi.fn(() => ({
    onDidChange: vi.fn(),
    onDidCreate: vi.fn(),
    onDidDelete: vi.fn(),
    dispose: vi.fn()
  })),
  asRelativePath: vi.fn((uri: any) => typeof uri === 'string' ? uri : uri?.fsPath || '')
};

export const commands = {
  registerCommand: vi.fn(),
  executeCommand: vi.fn(),
  getCommands: vi.fn()
};

export const Uri = {
  file: vi.fn((path: string) => ({ fsPath: path, scheme: 'file', path })),
  parse: vi.fn((uri: string) => ({ fsPath: uri, scheme: 'file', path: uri })),
  joinPath: vi.fn()
};

export class RelativePattern {
  constructor(public base: string, public pattern: string) {}
}

export const Range = vi.fn().mockImplementation((startLine: number, startChar: number, endLine: number, endChar: number) => ({
  start: { line: startLine, character: startChar },
  end: { line: endLine, character: endChar }
}));

export const Position = vi.fn().mockImplementation((line: number, character: number) => ({
  line,
  character
}));

export const Selection = vi.fn().mockImplementation((startLine: number, startChar: number, endLine: number, endChar: number) => ({
  start: { line: startLine, character: startChar },
  end: { line: endLine, character: endChar },
  anchor: { line: startLine, character: startChar },
  active: { line: endLine, character: endChar }
}));

export const TextEdit = {
  replace: vi.fn(),
  insert: vi.fn(),
  delete: vi.fn()
};

export const WorkspaceEdit = vi.fn().mockImplementation(() => ({
  replace: vi.fn(),
  insert: vi.fn(),
  delete: vi.fn(),
  entries: vi.fn(() => [])
}));

export const EventEmitter = vi.fn().mockImplementation(() => ({
  event: vi.fn(),
  fire: vi.fn(),
  dispose: vi.fn()
}));

export const Disposable = {
  from: vi.fn(() => mockDisposable)
};

export enum ExtensionMode {
  Production = 1,
  Development = 2,
  Test = 3
}

export enum DiagnosticSeverity {
  Error = 0,
  Warning = 1,
  Information = 2,
  Hint = 3
}

export const languages = {
  registerCompletionItemProvider: vi.fn(),
  registerCodeActionsProvider: vi.fn(),
  registerHoverProvider: vi.fn(),
  createDiagnosticCollection: vi.fn(() => ({
    set: vi.fn(),
    delete: vi.fn(),
    clear: vi.fn(),
    dispose: vi.fn()
  }))
};

export const env = {
  clipboard: {
    readText: vi.fn(),
    writeText: vi.fn()
  },
  openExternal: vi.fn(),
  machineId: 'test-machine-id'
};

// Helper to reset all mocks
export function resetAllMocks(): void {
  mockOutputChannel.debug.mockClear();
  mockOutputChannel.info.mockClear();
  mockOutputChannel.warn.mockClear();
  mockOutputChannel.error.mockClear();
  mockOutputChannel.show.mockClear();
  mockOutputChannel.clear.mockClear();
  mockOutputChannel.dispose.mockClear();
  mockConfiguration.get.mockClear();
  window.createOutputChannel.mockClear();
  workspace.getConfiguration.mockClear();
}
