/**
 * Unit tests for CommandProvider
 *
 * Tests model switching, chat history export/import/clear/search,
 * and current session export.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Track config values so get() can reflect update() calls
const { configStore } = vi.hoisted(() => ({
  configStore: new Map<string, any>()
}));

vi.mock('vscode', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    window: {
      showInformationMessage: vi.fn(),
      showWarningMessage: vi.fn(),
      showErrorMessage: vi.fn(),
      showInputBox: vi.fn(),
      showQuickPick: vi.fn(),
      showTextDocument: vi.fn(),
      showOpenDialog: vi.fn(),
      createOutputChannel: vi.fn(() => ({
        appendLine: vi.fn(), append: vi.fn(), show: vi.fn(),
        clear: vi.fn(), dispose: vi.fn(), info: vi.fn(),
        warn: vi.fn(), error: vi.fn(), debug: vi.fn()
      }))
    },
    workspace: {
      getConfiguration: vi.fn(() => ({
        get: vi.fn((key: string, defaultValue?: any) => {
          if (configStore.has(key)) return configStore.get(key);
          const defaults: Record<string, any> = { 'model': 'deepseek-v4-pro-thinking' };
          return defaults[key] ?? defaultValue;
        }),
        update: vi.fn(async (key: string, value: any) => {
          if (value === undefined) configStore.delete(key);
          else configStore.set(key, value);
        }),
        has: vi.fn().mockReturnValue(true),
        inspect: vi.fn()
      })),
      openTextDocument: vi.fn().mockResolvedValue({ getText: vi.fn() }),
      fs: {
        readFile: vi.fn()
      }
    },
    commands: {
      executeCommand: vi.fn()
    },
    Uri: {
      file: vi.fn((p: string) => ({ fsPath: p, scheme: 'file', path: p })),
      parse: vi.fn((u: string) => ({ fsPath: u, scheme: 'file', path: u }))
    }
  };
});

vi.mock('../../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn()
  }
}));

import * as vscode from 'vscode';
import { CommandProvider } from '../../../src/providers/commandProvider';

// ── Mock factories ──

function createMockClient() {
  return {
    setModel: vi.fn(),
    getModel: vi.fn(() => 'deepseek-chat'),
    chat: vi.fn(),
    chatStream: vi.fn(),
    getApiUsage: vi.fn()
  };
}

function createMockStatusBar() {
  return {
    updateModel: vi.fn(),
    dispose: vi.fn()
  };
}

function createMockConversationManager() {
  return {
    exportAllSessions: vi.fn().mockResolvedValue('exported content'),
    exportSession: vi.fn().mockResolvedValue('{"session":"data"}'),
    importSession: vi.fn().mockResolvedValue({ id: 's1', title: 'Imported' }),
    clearAllHistory: vi.fn().mockResolvedValue(undefined),
    searchHistory: vi.fn().mockResolvedValue([]),
    getSession: vi.fn().mockResolvedValue(null)
  };
}

describe('CommandProvider', () => {
  let provider: CommandProvider;
  let mockClient: ReturnType<typeof createMockClient>;
  let mockStatusBar: ReturnType<typeof createMockStatusBar>;
  let mockConvManager: ReturnType<typeof createMockConversationManager>;
  let getCurrentSessionId: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    configStore.clear();

    mockClient = createMockClient();
    mockStatusBar = createMockStatusBar();
    mockConvManager = createMockConversationManager();
    getCurrentSessionId = vi.fn(() => null);

    provider = new CommandProvider(
      mockClient as any,
      mockStatusBar as any,
      mockConvManager as any,
      getCurrentSessionId
    );
  });

  // ── Constructor ──

  describe('constructor', () => {
    it('should accept required dependencies', () => {
      expect(provider).toBeDefined();
    });
  });

  // ── switchModel ──

  describe('switchModel', () => {
    // switchModel cycles through `getRegisteredModelIds()` in declaration
    // order. As of the V4 launch the built-in order is:
    //   deepseek-chat → deepseek-reasoner → deepseek-v4-flash →
    //   deepseek-v4-flash-thinking → deepseek-v4-pro → deepseek-v4-pro-thinking
    // and then wraps back to deepseek-chat. The cases below pin the head, an
    // interior step, and the wrap.
    it('cycles from deepseek-chat to deepseek-reasoner (next in registration order)', async () => {
      configStore.set('model', 'deepseek-chat');
      await provider.switchModel();

      expect(mockClient.setModel).toHaveBeenCalledWith('deepseek-reasoner');
      expect(mockStatusBar.updateModel).toHaveBeenCalledWith('deepseek-reasoner');
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'Switched to deepseek-reasoner model'
      );
    });

    it('cycles from deepseek-reasoner to the first V4 entry', async () => {
      configStore.set('model', 'deepseek-reasoner');
      await provider.switchModel();

      expect(mockClient.setModel).toHaveBeenCalledWith('deepseek-v4-flash');
      expect(mockStatusBar.updateModel).toHaveBeenCalledWith('deepseek-v4-flash');
    });

    it('wraps from the last registered model back to deepseek-chat', async () => {
      configStore.set('model', 'deepseek-v4-pro-thinking');
      await provider.switchModel();

      expect(mockClient.setModel).toHaveBeenCalledWith('deepseek-chat');
      expect(mockStatusBar.updateModel).toHaveBeenCalledWith('deepseek-chat');
    });

    it('defaults to deepseek-v4-pro-thinking when no config is set, then advances to deepseek-chat', async () => {
      // No config override — defaults to 'deepseek-v4-pro-thinking' (DEFAULT_MODEL_ID)
      await provider.switchModel();
      expect(mockClient.setModel).toHaveBeenCalledWith('deepseek-chat');
    });
  });

  // ── exportChatHistory ──

  describe('exportChatHistory', () => {
    it('should show format picker and export', async () => {
      vi.mocked(vscode.window.showQuickPick).mockResolvedValue('JSON' as any);

      await provider.exportChatHistory();

      expect(vscode.window.showQuickPick).toHaveBeenCalledWith(
        ['JSON', 'Markdown', 'Text'],
        { placeHolder: 'Select export format' }
      );
      expect(mockConvManager.exportAllSessions).toHaveBeenCalledWith('json');
      expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith({
        content: 'exported content',
        language: 'json'
      });
      expect(vscode.window.showTextDocument).toHaveBeenCalled();
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'Chat history exported as JSON'
      );
    });

    it('should export as markdown', async () => {
      vi.mocked(vscode.window.showQuickPick).mockResolvedValue('Markdown' as any);

      await provider.exportChatHistory();

      expect(mockConvManager.exportAllSessions).toHaveBeenCalledWith('markdown');
      expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith({
        content: 'exported content',
        language: 'markdown'
      });
    });

    it('should export as text', async () => {
      vi.mocked(vscode.window.showQuickPick).mockResolvedValue('Text' as any);

      await provider.exportChatHistory();

      expect(mockConvManager.exportAllSessions).toHaveBeenCalledWith('text');
      expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith({
        content: 'exported content',
        language: 'plaintext'
      });
    });

    it('should do nothing when user cancels format picker', async () => {
      vi.mocked(vscode.window.showQuickPick).mockResolvedValue(undefined as any);

      await provider.exportChatHistory();

      expect(mockConvManager.exportAllSessions).not.toHaveBeenCalled();
      expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled();
    });
  });

  // ── clearChatHistory ──

  describe('clearChatHistory', () => {
    it('should show confirmation dialog', async () => {
      vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(undefined as any);

      await provider.clearChatHistory();

      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        'Delete ALL chat history? This cannot be undone.',
        { modal: true },
        'Delete All',
        'Cancel'
      );
    });

    it('should delete all history when user confirms', async () => {
      vi.mocked(vscode.window.showWarningMessage).mockResolvedValue('Delete All' as any);

      await provider.clearChatHistory();

      expect(mockConvManager.clearAllHistory).toHaveBeenCalled();
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'All chat history deleted'
      );
    });

    it('should not delete when user cancels', async () => {
      vi.mocked(vscode.window.showWarningMessage).mockResolvedValue('Cancel' as any);

      await provider.clearChatHistory();

      expect(mockConvManager.clearAllHistory).not.toHaveBeenCalled();
    });

    it('should not delete when user dismisses dialog', async () => {
      vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(undefined as any);

      await provider.clearChatHistory();

      expect(mockConvManager.clearAllHistory).not.toHaveBeenCalled();
    });
  });

  // ── searchChatHistory ──

  describe('searchChatHistory', () => {
    it('should show search input box', async () => {
      vi.mocked(vscode.window.showInputBox).mockResolvedValue(undefined);

      await provider.searchChatHistory();

      expect(vscode.window.showInputBox).toHaveBeenCalledWith({
        prompt: 'Search chat history',
        placeHolder: 'Enter search keywords'
      });
    });

    it('should do nothing when user cancels input', async () => {
      vi.mocked(vscode.window.showInputBox).mockResolvedValue(undefined);

      await provider.searchChatHistory();

      expect(mockConvManager.searchHistory).not.toHaveBeenCalled();
    });

    it('should show "no results" when search returns empty', async () => {
      vi.mocked(vscode.window.showInputBox).mockResolvedValue('test query');
      mockConvManager.searchHistory.mockResolvedValue([]);

      await provider.searchChatHistory();

      expect(mockConvManager.searchHistory).toHaveBeenCalledWith('test query');
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'No matching chat sessions found'
      );
    });

    it('should show quick pick when sessions found', async () => {
      vi.mocked(vscode.window.showInputBox).mockResolvedValue('test');
      mockConvManager.searchHistory.mockResolvedValue([
        {
          id: 's1',
          title: 'Test Session',
          eventCount: 5,
          lastActivityPreview: 'Hello there',
          firstUserMessage: 'Hi'
        }
      ]);
      vi.mocked(vscode.window.showQuickPick).mockResolvedValue(undefined as any);

      await provider.searchChatHistory();

      expect(vscode.window.showQuickPick).toHaveBeenCalledWith(
        [
          {
            label: 'Test Session',
            description: '5 events',
            detail: 'Hello there',
            session: expect.objectContaining({ id: 's1' })
          }
        ],
        { placeHolder: 'Select a chat session to open' }
      );
    });

    it('should execute showChatHistory command when session selected', async () => {
      vi.mocked(vscode.window.showInputBox).mockResolvedValue('test');
      mockConvManager.searchHistory.mockResolvedValue([
        { id: 's1', title: 'Session', eventCount: 1, lastActivityPreview: '', firstUserMessage: '' }
      ]);
      vi.mocked(vscode.window.showQuickPick).mockResolvedValue({ session: { id: 's1' } } as any);

      await provider.searchChatHistory();

      expect(vscode.commands.executeCommand).toHaveBeenCalledWith('moby.showChatHistory');
    });
  });

  // ── exportCurrentSession ──

  describe('exportCurrentSession', () => {
    it('should warn when no active session', async () => {
      getCurrentSessionId.mockReturnValue(null);

      await provider.exportCurrentSession();

      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith('No active chat session');
    });

    it('should warn when session not found', async () => {
      getCurrentSessionId.mockReturnValue('s-missing');
      mockConvManager.getSession.mockResolvedValue(null);

      await provider.exportCurrentSession();

      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith('No active chat session');
    });

    it('should export current session as JSON', async () => {
      getCurrentSessionId.mockReturnValue('s1');
      mockConvManager.getSession.mockResolvedValue({ id: 's1', title: 'My Session' });

      await provider.exportCurrentSession();

      expect(mockConvManager.exportSession).toHaveBeenCalledWith('s1');
      expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith({
        content: '{"session":"data"}',
        language: 'json'
      });
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'Session "My Session" exported'
      );
    });
  });

  // ── importChatHistory ──

  describe('importChatHistory', () => {
    it('should do nothing when user cancels file dialog', async () => {
      vi.mocked(vscode.window.showOpenDialog).mockResolvedValue(undefined as any);

      await provider.importChatHistory();

      expect(mockConvManager.importSession).not.toHaveBeenCalled();
    });

    it('should do nothing when user selects no files', async () => {
      vi.mocked(vscode.window.showOpenDialog).mockResolvedValue([] as any);

      await provider.importChatHistory();

      expect(mockConvManager.importSession).not.toHaveBeenCalled();
    });

    it('should import session from selected file', async () => {
      const fakeUri = { fsPath: '/tmp/session.json' };
      vi.mocked(vscode.window.showOpenDialog).mockResolvedValue([fakeUri] as any);
      vi.mocked(vscode.workspace.fs.readFile).mockResolvedValue(
        Buffer.from('{"session":"data"}') as any
      );

      await provider.importChatHistory();

      expect(mockConvManager.importSession).toHaveBeenCalledWith('{"session":"data"}');
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'Chat session "Imported" imported successfully'
      );
    });

    it('should show error when import fails', async () => {
      const fakeUri = { fsPath: '/tmp/bad.json' };
      vi.mocked(vscode.window.showOpenDialog).mockResolvedValue([fakeUri] as any);
      vi.mocked(vscode.workspace.fs.readFile).mockRejectedValue(new Error('read failed'));

      await provider.importChatHistory();

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'Failed to import chat history: read failed'
      );
    });
  });
});
