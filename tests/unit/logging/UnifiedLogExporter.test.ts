/**
 * Unit tests for UnifiedLogExporter
 *
 * Tests the two export modes (AI vs Human) and formatting helpers.
 * Mocks all three log sources (tracer, logger, webviewLogStore) as module-level singletons.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LogBufferEntry } from '../../../src/utils/logger';
import type { WebviewLogEntry } from '../../../src/logging/WebviewLogStore';

// ── Hoisted mock state ──────────────────────────────────────────────

const { mockTracer, mockLogger, mockWebviewLogStore, mockDoc } = vi.hoisted(() => ({
  mockTracer: {
    getAll: vi.fn(() => []),
    exportForAI: vi.fn(() => ''),
    export: vi.fn(() => ''),
    size: 0,
    setLogOutput: vi.fn()
  },
  mockLogger: {
    getLogBuffer: vi.fn((): LogBufferEntry[] => []),
    logBufferSize: 0
  },
  mockWebviewLogStore: {
    getAll: vi.fn((): WebviewLogEntry[] => []),
    size: 0
  },
  mockDoc: { uri: 'mock-doc' }
}));

// ── Module mocks ────────────────────────────────────────────────────

vi.mock('../../../src/tracing', () => ({
  tracer: mockTracer
}));

vi.mock('../../../src/utils/logger', () => ({
  logger: mockLogger
}));

vi.mock('../../../src/logging/WebviewLogStore', () => ({
  webviewLogStore: mockWebviewLogStore
}));

vi.mock('vscode', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    workspace: {
      ...(original as any).workspace,
      openTextDocument: vi.fn(async () => mockDoc)
    },
    window: {
      ...(original as any).window,
      showTextDocument: vi.fn(async () => {}),
      showInformationMessage: vi.fn()
    }
  };
});

import { UnifiedLogExporter } from '../../../src/logging/UnifiedLogExporter';
import * as vscode from 'vscode';

// ── Helpers ─────────────────────────────────────────────────────────

function makeExtLogEntry(overrides: Partial<LogBufferEntry> = {}): LogBufferEntry {
  return {
    timestamp: '2026-01-15T10:30:45.123Z',
    level: 'INFO',
    message: 'test message',
    ...overrides
  };
}

function makeWebviewLogEntry(overrides: Partial<WebviewLogEntry> = {}): WebviewLogEntry {
  return {
    timestamp: '2026-01-15T10:30:45.456Z',
    level: 'info',
    component: 'TestComponent',
    message: 'webview log',
    ...overrides
  };
}

// ── Tests ───────────────────────────────────────────────────────────

describe('UnifiedLogExporter', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Reset mock state to empty
    mockTracer.getAll.mockReturnValue([]);
    mockTracer.exportForAI.mockReturnValue('');
    mockTracer.export.mockReturnValue('');
    mockTracer.size = 0;
    mockLogger.getLogBuffer.mockReturnValue([]);
    mockLogger.logBufferSize = 0;
    mockWebviewLogStore.getAll.mockReturnValue([]);
    mockWebviewLogStore.size = 0;
  });

  // ── exportForAI ──────────────────────────────────────────────────

  describe('exportForAI()', () => {
    it('produces output with three sections', async () => {
      await UnifiedLogExporter.exportForAI();

      const call = (vscode.workspace.openTextDocument as any).mock.calls[0][0];
      const content: string = call.content;

      expect(content).toContain('MOBY UNIFIED LOG EXPORT (AI)');
      expect(content).toContain('## TRACES');
      expect(content).toContain('## EXTENSION LOGS');
      expect(content).toContain('## WEBVIEW LOGS');
      expect(content).toContain('END OF EXPORT');
    });

    it('shows "no trace events" when tracer is empty', async () => {
      await UnifiedLogExporter.exportForAI();

      const content: string = (vscode.workspace.openTextDocument as any).mock.calls[0][0].content;
      expect(content).toContain('(no trace events)');
    });

    it('calls tracer.exportForAI when trace events exist', async () => {
      mockTracer.getAll.mockReturnValue([{ id: 'evt-1' }]);
      mockTracer.exportForAI.mockReturnValue('TRACE: request started');

      await UnifiedLogExporter.exportForAI();

      expect(mockTracer.exportForAI).toHaveBeenCalledWith({ maxEvents: 500, groupByFlow: true });
      const content: string = (vscode.workspace.openTextDocument as any).mock.calls[0][0].content;
      expect(content).toContain('TRACE: request started');
    });

    it('only includes WARN/ERROR extension logs', async () => {
      mockLogger.getLogBuffer.mockReturnValue([
        makeExtLogEntry({ level: 'DEBUG', message: 'debug stuff' }),
        makeExtLogEntry({ level: 'INFO', message: 'info stuff' }),
        makeExtLogEntry({ level: 'WARN', message: 'warning happened' }),
        makeExtLogEntry({ level: 'ERROR', message: 'error occurred' })
      ]);

      await UnifiedLogExporter.exportForAI();

      const content: string = (vscode.workspace.openTextDocument as any).mock.calls[0][0].content;
      expect(content).toContain('warning happened');
      expect(content).toContain('error occurred');
      expect(content).not.toContain('debug stuff');
      expect(content).not.toContain('info stuff');
    });

    it('shows summary when all extension logs are DEBUG/INFO', async () => {
      mockLogger.getLogBuffer.mockReturnValue([
        makeExtLogEntry({ level: 'DEBUG', message: 'x' }),
        makeExtLogEntry({ level: 'INFO', message: 'y' })
      ]);

      await UnifiedLogExporter.exportForAI();

      const content: string = (vscode.workspace.openTextDocument as any).mock.calls[0][0].content;
      expect(content).toContain('2 entries, all DEBUG/INFO - no warnings or errors');
    });

    it('only includes warn/error webview logs', async () => {
      mockWebviewLogStore.getAll.mockReturnValue([
        makeWebviewLogEntry({ level: 'debug', message: 'dbg' }),
        makeWebviewLogEntry({ level: 'info', message: 'nfo' }),
        makeWebviewLogEntry({ level: 'warn', message: 'webview warning' }),
        makeWebviewLogEntry({ level: 'error', message: 'webview error' })
      ]);

      await UnifiedLogExporter.exportForAI();

      const content: string = (vscode.workspace.openTextDocument as any).mock.calls[0][0].content;
      expect(content).toContain('webview warning');
      expect(content).toContain('webview error');
      expect(content).not.toContain('[DEBUG]');
      expect(content).not.toContain('nfo');
    });

    it('shows summary when all webview logs are debug/info', async () => {
      mockWebviewLogStore.getAll.mockReturnValue([
        makeWebviewLogEntry({ level: 'info', message: 'fine' })
      ]);

      await UnifiedLogExporter.exportForAI();

      const content: string = (vscode.workspace.openTextDocument as any).mock.calls[0][0].content;
      expect(content).toContain('1 entries, all debug/info - no warnings or errors');
    });

    it('includes extension log details when present', async () => {
      mockLogger.getLogBuffer.mockReturnValue([
        makeExtLogEntry({ level: 'ERROR', message: 'crash', details: 'stack trace here' })
      ]);

      await UnifiedLogExporter.exportForAI();

      const content: string = (vscode.workspace.openTextDocument as any).mock.calls[0][0].content;
      expect(content).toContain('crash | stack trace here');
    });

    it('opens document in editor with "log" language', async () => {
      await UnifiedLogExporter.exportForAI();

      expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith(
        expect.objectContaining({ language: 'log' })
      );
      expect(vscode.window.showTextDocument).toHaveBeenCalledWith(
        mockDoc,
        { preview: false }
      );
    });

    it('shows information message with line count', async () => {
      await UnifiedLogExporter.exportForAI();

      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('Moby logs exported:')
      );
    });
  });

  // ── exportForHuman ───────────────────────────────────────────────

  describe('exportForHuman()', () => {
    it('produces output with three sections and summary counts', async () => {
      mockTracer.size = 5;
      mockLogger.logBufferSize = 3;
      mockWebviewLogStore.size = 2;

      await UnifiedLogExporter.exportForHuman();

      const content: string = (vscode.workspace.openTextDocument as any).mock.calls[0][0].content;
      expect(content).toContain('MOBY UNIFIED LOG EXPORT (FULL)');
      expect(content).toContain('Traces: 5');
      expect(content).toContain('Extension Logs: 3');
      expect(content).toContain('Webview Logs: 2');
    });

    it('calls tracer.export("pretty") when trace events exist', async () => {
      mockTracer.size = 2;
      mockTracer.export.mockReturnValue('PRETTY TRACE OUTPUT');

      await UnifiedLogExporter.exportForHuman();

      expect(mockTracer.export).toHaveBeenCalledWith('pretty');
      const content: string = (vscode.workspace.openTextDocument as any).mock.calls[0][0].content;
      expect(content).toContain('PRETTY TRACE OUTPUT');
    });

    it('shows "no trace events" when tracer is empty', async () => {
      mockTracer.size = 0;

      await UnifiedLogExporter.exportForHuman();

      const content: string = (vscode.workspace.openTextDocument as any).mock.calls[0][0].content;
      expect(content).toContain('(no trace events)');
    });

    it('includes ALL extension log levels (not just WARN/ERROR)', async () => {
      mockLogger.getLogBuffer.mockReturnValue([
        makeExtLogEntry({ level: 'DEBUG', message: 'debug message' }),
        makeExtLogEntry({ level: 'INFO', message: 'info message' }),
        makeExtLogEntry({ level: 'WARN', message: 'warn message' }),
        makeExtLogEntry({ level: 'ERROR', message: 'error message' })
      ]);

      await UnifiedLogExporter.exportForHuman();

      const content: string = (vscode.workspace.openTextDocument as any).mock.calls[0][0].content;
      expect(content).toContain('debug message');
      expect(content).toContain('info message');
      expect(content).toContain('warn message');
      expect(content).toContain('error message');
    });

    it('includes ALL webview log levels', async () => {
      mockWebviewLogStore.getAll.mockReturnValue([
        makeWebviewLogEntry({ level: 'debug', message: 'wv debug' }),
        makeWebviewLogEntry({ level: 'info', message: 'wv info' }),
        makeWebviewLogEntry({ level: 'warn', message: 'wv warn' }),
        makeWebviewLogEntry({ level: 'error', message: 'wv error' })
      ]);

      await UnifiedLogExporter.exportForHuman();

      const content: string = (vscode.workspace.openTextDocument as any).mock.calls[0][0].content;
      expect(content).toContain('wv debug');
      expect(content).toContain('wv info');
      expect(content).toContain('wv warn');
      expect(content).toContain('wv error');
    });

    it('shows extension log details indented', async () => {
      mockLogger.getLogBuffer.mockReturnValue([
        makeExtLogEntry({ level: 'ERROR', message: 'fail', details: 'stack info' })
      ]);

      await UnifiedLogExporter.exportForHuman();

      const content: string = (vscode.workspace.openTextDocument as any).mock.calls[0][0].content;
      expect(content).toContain('fail');
      expect(content).toContain('stack info');
    });

    it('shows "no extension log entries" when empty', async () => {
      mockLogger.getLogBuffer.mockReturnValue([]);

      await UnifiedLogExporter.exportForHuman();

      const content: string = (vscode.workspace.openTextDocument as any).mock.calls[0][0].content;
      expect(content).toContain('(no extension log entries)');
    });

    it('shows "no webview log entries" when empty', async () => {
      mockWebviewLogStore.getAll.mockReturnValue([]);

      await UnifiedLogExporter.exportForHuman();

      const content: string = (vscode.workspace.openTextDocument as any).mock.calls[0][0].content;
      expect(content).toContain('(no webview log entries)');
    });
  });

  // ── Edge cases ───────────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles all three sources being empty', async () => {
      await UnifiedLogExporter.exportForAI();

      const content: string = (vscode.workspace.openTextDocument as any).mock.calls[0][0].content;
      expect(content).toContain('(no trace events)');
      expect(content).toContain('(no extension log entries)');
      expect(content).toContain('(no webview log entries)');
    });

    it('AI format shows count header for filtered extension logs', async () => {
      mockLogger.getLogBuffer.mockReturnValue([
        makeExtLogEntry({ level: 'INFO', message: 'ignored1' }),
        makeExtLogEntry({ level: 'INFO', message: 'ignored2' }),
        makeExtLogEntry({ level: 'ERROR', message: 'kept' })
      ]);

      await UnifiedLogExporter.exportForAI();

      const content: string = (vscode.workspace.openTextDocument as any).mock.calls[0][0].content;
      expect(content).toContain('showing 1 warnings/errors of 3 total');
    });

    it('AI format shows count header for filtered webview logs', async () => {
      mockWebviewLogStore.getAll.mockReturnValue([
        makeWebviewLogEntry({ level: 'info', message: 'a' }),
        makeWebviewLogEntry({ level: 'warn', message: 'b' }),
        makeWebviewLogEntry({ level: 'error', message: 'c' })
      ]);

      await UnifiedLogExporter.exportForAI();

      const content: string = (vscode.workspace.openTextDocument as any).mock.calls[0][0].content;
      expect(content).toContain('showing 2 warnings/errors of 3 total');
    });

    it('formats webview log entries with component name in human mode', async () => {
      mockWebviewLogStore.getAll.mockReturnValue([
        makeWebviewLogEntry({ level: 'error', component: 'ScrollActor', message: 'scroll fail' })
      ]);

      await UnifiedLogExporter.exportForHuman();

      const content: string = (vscode.workspace.openTextDocument as any).mock.calls[0][0].content;
      expect(content).toContain('[ScrollActor]');
      expect(content).toContain('scroll fail');
    });

    it('formats webview log entries with component name in AI mode', async () => {
      mockWebviewLogStore.getAll.mockReturnValue([
        makeWebviewLogEntry({ level: 'error', component: 'ChatActor', message: 'err' })
      ]);

      await UnifiedLogExporter.exportForAI();

      const content: string = (vscode.workspace.openTextDocument as any).mock.calls[0][0].content;
      expect(content).toContain('[ChatActor]');
    });
  });
});
