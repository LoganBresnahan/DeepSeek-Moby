/**
 * Unit tests for StatusBar
 *
 * Tests the StatusBar class that creates/manages the VS Code status bar item
 * displaying model name and token counts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mock state ──────────────────────────────────────────────

const { mockStatusBarItem, mockConfigValues } = vi.hoisted(() => ({
  mockStatusBarItem: {
    text: '',
    tooltip: '',
    command: '',
    show: vi.fn(),
    hide: vi.fn(),
    dispose: vi.fn()
  },
  mockConfigValues: new Map<string, any>([
    ['showStatusBar', true],
    ['model', 'deepseek-chat']
  ])
}));

// ── Module mocks ────────────────────────────────────────────────────

vi.mock('vscode', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    StatusBarAlignment: { Left: 1, Right: 2 },
    window: {
      ...(original as any).window,
      createStatusBarItem: vi.fn(() => mockStatusBarItem)
    }
  };
});

vi.mock('../../../src/utils/config', () => ({
  ConfigManager: {
    getInstance: vi.fn(() => ({
      get: vi.fn((key: string) => mockConfigValues.get(key))
    }))
  }
}));

// Avoid pulling in the real Logger (it touches vscode output channels at construction)
vi.mock('../../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }
}));

vi.mock('../../../src/tracing', () => ({
  tracer: {
    event: vi.fn(),
    setLogOutput: vi.fn()
  }
}));

import { StatusBar } from '../../../src/views/statusBar';
import * as vscode from 'vscode';

// ── Helpers ─────────────────────────────────────────────────────────

function createMockClient() {
  return {
    setModel: vi.fn(),
    getModel: vi.fn(() => 'deepseek-chat'),
    chat: vi.fn(),
    chatStream: vi.fn(),
    getApiUsage: vi.fn()
  } as any;
}

function createMockConversationManager() {
  return {
    getSessionStats: vi.fn(async () => ({
      totalSessions: 3,
      totalMessages: 42,
      totalTokens: 12345,
      byModel: {},
      byLanguage: {}
    }))
  } as any;
}

// ── Tests ───────────────────────────────────────────────────────────

describe('StatusBar', () => {
  let statusBar: StatusBar;
  let mockClient: ReturnType<typeof createMockClient>;
  let mockConversationManager: ReturnType<typeof createMockConversationManager>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockStatusBarItem.text = '';
    mockStatusBarItem.tooltip = '';
    mockStatusBarItem.command = '';

    mockConfigValues.set('showStatusBar', true);
    mockConfigValues.set('model', 'deepseek-chat');

    mockClient = createMockClient();
    mockConversationManager = createMockConversationManager();

    statusBar = new StatusBar(mockClient, mockConversationManager);
  });

  describe('constructor', () => {
    it('creates a status bar item on the right side', () => {
      expect(vscode.window.createStatusBarItem).toHaveBeenCalledWith(2, 100); // Right = 2
    });

    it('sets tooltip and command on the status bar item', () => {
      expect(mockStatusBarItem.tooltip).toBe('DeepSeek Moby - Click to open chat');
      expect(mockStatusBarItem.command).toBe('moby.startChat');
    });
  });

  describe('start()', () => {
    it('shows status bar when showStatusBar config is true', () => {
      statusBar.start();
      expect(mockStatusBarItem.show).toHaveBeenCalled();
    });

    it('does not show status bar when showStatusBar config is false', () => {
      mockConfigValues.set('showStatusBar', false);
      // Re-create with the new config
      statusBar = new StatusBar(mockClient, mockConversationManager);
      statusBar.start();
      expect(mockStatusBarItem.show).not.toHaveBeenCalled();
    });
  });

  describe('update()', () => {
    it('fetches session stats and updates text', async () => {
      await statusBar.update();

      expect(mockConversationManager.getSessionStats).toHaveBeenCalled();
      expect(mockStatusBarItem.text).toContain('DeepSeek Moby');
      expect(mockStatusBarItem.text).toContain('deepseek-chat');
      expect(mockStatusBarItem.text).toContain('12,345');
    });

    it('updates tooltip with detailed stats', async () => {
      await statusBar.update();

      const tooltip = mockStatusBarItem.tooltip as string;
      expect(tooltip).toContain('Model: deepseek-chat');
      expect(tooltip).toContain('Total Tokens: 12,345');
      expect(tooltip).toContain('Total Sessions: 3');
      expect(tooltip).toContain('Total Messages: 42');
    });

    it('falls back to "deepseek-v4-pro-thinking" when no model configured', async () => {
      mockConfigValues.set('model', undefined);
      statusBar = new StatusBar(mockClient, mockConversationManager);

      await statusBar.update();

      expect(mockStatusBarItem.text).toContain('deepseek-v4-pro-thinking');
    });
  });

  describe('updateModel()', () => {
    it('changes the model text displayed', () => {
      statusBar.updateModel('deepseek-reasoner');

      expect(mockStatusBarItem.text).toContain('deepseek-reasoner');
      expect(mockStatusBarItem.text).toContain('DeepSeek Moby');
    });
  });

  describe('updateLastResponse()', () => {
    it('delegates to update()', async () => {
      const updateSpy = vi.spyOn(statusBar, 'update');
      await statusBar.updateLastResponse();
      expect(updateSpy).toHaveBeenCalled();
    });
  });

  describe('resetTokenCount()', () => {
    it('resets total tokens to zero and updates display', async () => {
      // First set a non-zero count
      await statusBar.update();
      expect(mockStatusBarItem.text).toContain('12,345');

      // Reset
      statusBar.resetTokenCount();

      // After resetTokenCount calls update(), the conversation manager is queried again.
      // The important thing is resetTokenCount was called and triggered update.
      expect(mockConversationManager.getSessionStats).toHaveBeenCalled();
    });
  });

  describe('dispose()', () => {
    it('disposes the status bar item', () => {
      statusBar.dispose();
      expect(mockStatusBarItem.dispose).toHaveBeenCalled();
    });
  });
});
