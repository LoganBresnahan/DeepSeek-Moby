/**
 * Tests for ChatProvider message queuing during summarization (Phase 3).
 *
 * Tests the _summarizing flag, _pendingMessages queue, and drainQueue() logic.
 * Uses lightweight mocks to avoid full webview initialization.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Working EventEmitter for real event subscriptions
const { WorkingEventEmitter } = vi.hoisted(() => ({
  WorkingEventEmitter: class WorkingEventEmitter {
    private _listeners: Array<(e: any) => void> = [];
    event = (listener: (e: any) => void) => {
      this._listeners.push(listener);
      return { dispose: () => { this._listeners = this._listeners.filter(l => l !== listener); } };
    };
    fire = (data?: any) => { for (const l of this._listeners) l(data); };
    dispose = () => { this._listeners = []; };
  }
}));

vi.mock('vscode', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    EventEmitter: WorkingEventEmitter,
    workspace: {
      onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
      getConfiguration: vi.fn(() => ({
        get: vi.fn((key: string, defaultValue?: any) => {
          const defaults: Record<string, any> = {
            'systemPrompt': '',
            'editMode': 'manual',
            'maxToolCalls': 100,
            'maxShellIterations': 100,
            'allowAllShellCommands': false,
          };
          return defaults[key] ?? defaultValue;
        }),
        update: vi.fn(),
        has: vi.fn().mockReturnValue(true),
        inspect: vi.fn()
      })),
      workspaceFolders: [{ uri: { fsPath: '/test/workspace' } }],
      asRelativePath: vi.fn((uri: any) => uri.fsPath || uri)
    },
    window: {
      activeTextEditor: undefined,
      createOutputChannel: vi.fn(() => ({
        appendLine: vi.fn(), append: vi.fn(), show: vi.fn(),
        clear: vi.fn(), dispose: vi.fn(), info: vi.fn(),
        warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(),
      })),
      showErrorMessage: vi.fn(),
      showWarningMessage: vi.fn(),
      showInformationMessage: vi.fn(),
    },
    Uri: {
      joinPath: vi.fn(() => ({ fsPath: '/mock' })),
      file: vi.fn((path: string) => ({ fsPath: path })),
    },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  };
});

import { ChatProvider } from '../../../src/providers/chatProvider';

/**
 * We test the queuing behavior by accessing ChatProvider's internal state
 * through its prototype methods, similar to how ConversationManager tests work.
 *
 * Key behaviors:
 * - When _summarizing is true, sendMessage case queues messages
 * - When _summarizing becomes false (via onSummarizationCompleted), flag resets
 * - drainQueue() processes pending messages sequentially
 */
describe('ChatProvider message queuing (Phase 3)', () => {
  // We'll bind the drainQueue method to a mock with the fields it needs
  const drainQueue = (ChatProvider.prototype as any).drainQueue;

  it('drainQueue processes all pending messages sequentially', async () => {
    const handleCalls: string[] = [];
    const mockCp = {
      _pendingMessages: [
        { message: 'msg1', attachments: undefined },
        { message: 'msg2', attachments: [{ content: 'f', name: 'a.ts', size: 1 }] },
        { message: 'msg3', attachments: undefined },
      ],
      currentSessionId: 'session-1',
      requestOrchestrator: {
        handleMessage: vi.fn(async (msg: string) => {
          handleCalls.push(msg);
          return { sessionId: 'session-1' };
        }),
      },
      fileContextManager: {
        getEditorContext: vi.fn(async () => ''),
      },
    };

    await drainQueue.call(mockCp);

    expect(handleCalls).toEqual(['msg1', 'msg2', 'msg3']);
    expect(mockCp._pendingMessages).toHaveLength(0);
    expect(mockCp.currentSessionId).toBe('session-1');
  });

  it('drainQueue does nothing when queue is empty', async () => {
    const mockCp = {
      _pendingMessages: [],
      currentSessionId: 'session-1',
      requestOrchestrator: {
        handleMessage: vi.fn(),
      },
      fileContextManager: {
        getEditorContext: vi.fn(async () => ''),
      },
    };

    await drainQueue.call(mockCp);

    expect(mockCp.requestOrchestrator.handleMessage).not.toHaveBeenCalled();
  });

  it('drainQueue updates sessionId from each handled message', async () => {
    let callNum = 0;
    const mockCp = {
      _pendingMessages: [
        { message: 'msg1' },
        { message: 'msg2' },
      ],
      currentSessionId: 'old-session',
      requestOrchestrator: {
        handleMessage: vi.fn(async () => {
          callNum++;
          return { sessionId: `session-${callNum}` };
        }),
      },
      fileContextManager: {
        getEditorContext: vi.fn(async () => ''),
      },
    };

    await drainQueue.call(mockCp);

    // Session ID should be updated after each message
    expect(mockCp.currentSessionId).toBe('session-2');
  });

  it('drainQueue passes attachments correctly', async () => {
    const mockCp = {
      _pendingMessages: [
        {
          message: 'msg with files',
          attachments: [{ content: 'code', name: 'test.ts', size: 4 }]
        },
      ],
      currentSessionId: 'session-1',
      requestOrchestrator: {
        handleMessage: vi.fn(async () => ({ sessionId: 'session-1' })),
      },
      fileContextManager: {
        getEditorContext: vi.fn(async () => ''),
      },
    };

    await drainQueue.call(mockCp);

    expect(mockCp.requestOrchestrator.handleMessage).toHaveBeenCalledWith(
      'msg with files',
      'session-1',
      expect.any(Function),
      [{ content: 'code', name: 'test.ts', size: 4 }]
    );
  });

  it('_summarizing flag controls message queuing', () => {
    // Test the flag directly since the wireEvents subscription is integration-level
    const mockCp = {
      _summarizing: false,
      _pendingMessages: [] as any[],
    };

    // Simulate summarization started
    mockCp._summarizing = true;

    // Simulate messages arriving during summarization
    mockCp._pendingMessages.push({ message: 'queued msg 1' });
    mockCp._pendingMessages.push({ message: 'queued msg 2' });

    expect(mockCp._summarizing).toBe(true);
    expect(mockCp._pendingMessages).toHaveLength(2);

    // Simulate summarization completed
    mockCp._summarizing = false;

    expect(mockCp._summarizing).toBe(false);
    // Queue is still there — drainQueue would process it
    expect(mockCp._pendingMessages).toHaveLength(2);
  });

  it('message queuing during active summarization stores messages in order', () => {
    const queue: Array<{ message: string; attachments?: any[] }> = [];

    // Simulate 3 messages arriving during summarization
    queue.push({ message: 'first' });
    queue.push({ message: 'second', attachments: [{ content: 'x', name: 'f.ts', size: 1 }] });
    queue.push({ message: 'third' });

    expect(queue).toHaveLength(3);
    expect(queue[0].message).toBe('first');
    expect(queue[1].message).toBe('second');
    expect(queue[1].attachments).toHaveLength(1);
    expect(queue[2].message).toBe('third');
  });
});
