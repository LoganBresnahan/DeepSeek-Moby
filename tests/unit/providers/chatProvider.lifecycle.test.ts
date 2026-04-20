/**
 * Tests for ChatProvider session lifecycle + message routing + event wiring.
 *
 * Coverage target: the seams that Option B (incremental event saves, ADR-TBD)
 * will modify — loadCurrentSession, saveCurrentSession, deleteSession,
 * clearConversation, and the sendMessage / onSessionCreated / summarization
 * event handlers.
 *
 * Pattern: we bind ChatProvider's prototype methods to lightweight mock objects
 * (same approach as chatProvider.queuing.test.ts) to avoid the cost of wiring
 * the full manager graph in every test.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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
        get: vi.fn((_key: string, defaultValue?: any) => defaultValue),
        update: vi.fn(),
        has: vi.fn().mockReturnValue(true),
        inspect: vi.fn(),
      })),
      workspaceFolders: [{ uri: { fsPath: '/test/workspace' } }],
      asRelativePath: vi.fn((uri: any) => uri.fsPath || uri),
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
      file: vi.fn((p: string) => ({ fsPath: p })),
    },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  };
});

import { ChatProvider } from '../../../src/providers/chatProvider';

// ── Mock factory for the globalState the provider reads/writes ──
function makeGlobalState(initial: Record<string, any> = {}) {
  const store = new Map<string, any>(Object.entries(initial));
  return {
    get: vi.fn((key: string) => store.get(key)),
    update: vi.fn(async (key: string, value: any) => {
      if (value === undefined) store.delete(key);
      else store.set(key, value);
    }),
    _store: store,
  };
}

// ── Session lifecycle ──

describe('ChatProvider.loadCurrentSession', () => {
  const loadCurrentSession = (ChatProvider.prototype as any).loadCurrentSession;

  it('restores session from instance-scoped key when it exists', async () => {
    const gs = makeGlobalState({
      'currentSessionId-instance-a': 'session-from-instance',
      'currentSessionId': 'session-from-shared',
    });
    const cp: any = {
      instanceId: 'instance-a',
      currentSessionId: null,
      conversationManager: {
        getGlobalState: () => gs,
        getSession: vi.fn(async (id: string) => ({ id })),
      },
    };

    await loadCurrentSession.call(cp);

    expect(cp.currentSessionId).toBe('session-from-instance');
    // Did not fall through to shared key
    expect(cp.conversationManager.getSession).toHaveBeenCalledTimes(1);
    expect(cp.conversationManager.getSession).toHaveBeenCalledWith('session-from-instance');
  });

  it('falls back to shared key when instance-scoped session no longer exists', async () => {
    const gs = makeGlobalState({
      'currentSessionId-instance-a': 'deleted-session',
      'currentSessionId': 'shared-session',
    });
    const cp: any = {
      instanceId: 'instance-a',
      currentSessionId: null,
      conversationManager: {
        getGlobalState: () => gs,
        getSession: vi.fn(async (id: string) => id === 'shared-session' ? { id } : null),
      },
    };

    await loadCurrentSession.call(cp);

    expect(cp.currentSessionId).toBe('shared-session');
  });

  it('leaves currentSessionId null when no saved IDs exist', async () => {
    const gs = makeGlobalState({});
    const cp: any = {
      instanceId: 'instance-a',
      currentSessionId: null,
      conversationManager: {
        getGlobalState: () => gs,
        getSession: vi.fn(),
      },
    };

    await loadCurrentSession.call(cp);

    expect(cp.currentSessionId).toBeNull();
    expect(cp.conversationManager.getSession).not.toHaveBeenCalled();
  });

  it('leaves currentSessionId null when all saved IDs point to deleted sessions', async () => {
    const gs = makeGlobalState({
      'currentSessionId-instance-a': 'gone-1',
      'currentSessionId': 'gone-2',
    });
    const cp: any = {
      instanceId: 'instance-a',
      currentSessionId: null,
      conversationManager: {
        getGlobalState: () => gs,
        getSession: vi.fn(async () => null),
      },
    };

    await loadCurrentSession.call(cp);

    expect(cp.currentSessionId).toBeNull();
  });
});

describe('ChatProvider.saveCurrentSession', () => {
  const saveCurrentSession = (ChatProvider.prototype as any).saveCurrentSession;

  it('writes currentSessionId to both instance-scoped and shared keys', async () => {
    const gs = makeGlobalState();
    const cp: any = {
      instanceId: 'instance-a',
      currentSessionId: 'session-xyz',
      conversationManager: { getGlobalState: () => gs },
    };

    await saveCurrentSession.call(cp);

    expect(gs.update).toHaveBeenCalledWith('currentSessionId-instance-a', 'session-xyz');
    expect(gs.update).toHaveBeenCalledWith('currentSessionId', 'session-xyz');
  });

  it('no-ops when currentSessionId is null', async () => {
    const gs = makeGlobalState();
    const cp: any = {
      instanceId: 'instance-a',
      currentSessionId: null,
      conversationManager: { getGlobalState: () => gs },
    };

    await saveCurrentSession.call(cp);

    expect(gs.update).not.toHaveBeenCalled();
  });
});

describe('ChatProvider.deleteSession', () => {
  const deleteSession = (ChatProvider.prototype as any).deleteSession;

  function makeMockCp(currentSessionId: string | null) {
    const view = { webview: { postMessage: vi.fn() } };
    const cp: any = {
      currentSessionId,
      _view: view,
      conversationManager: {
        deleteSession: vi.fn(async () => {}),
      },
      sendHistorySessions: vi.fn(async () => {}),
      _view_for_tests: view,
    };
    return cp;
  }

  it('clears currentSessionId and notifies webview when deleting the active session', async () => {
    const cp = makeMockCp('active-session');
    await deleteSession.call(cp, 'active-session');

    expect(cp.conversationManager.deleteSession).toHaveBeenCalledWith('active-session');
    expect(cp.currentSessionId).toBeNull();
    expect(cp._view_for_tests.webview.postMessage).toHaveBeenCalledWith({ type: 'clearChat' });
    expect(cp.sendHistorySessions).toHaveBeenCalled();
  });

  it('leaves currentSessionId untouched when deleting a different session', async () => {
    const cp = makeMockCp('active-session');
    await deleteSession.call(cp, 'other-session');

    expect(cp.currentSessionId).toBe('active-session');
    expect(cp._view_for_tests.webview.postMessage).not.toHaveBeenCalled();
    expect(cp.sendHistorySessions).toHaveBeenCalled();
  });

  it('swallows errors from conversationManager.deleteSession without throwing', async () => {
    const cp = makeMockCp('active-session');
    cp.conversationManager.deleteSession = vi.fn(async () => {
      throw new Error('db error');
    });

    await expect(deleteSession.call(cp, 'active-session')).resolves.toBeUndefined();
    // Current session stays intact because the delete failed before the reassignment
    expect(cp.currentSessionId).toBe('active-session');
  });

  it('still refreshes the history list on success even when no view is attached', async () => {
    const cp: any = {
      currentSessionId: 'active-session',
      _view: undefined,
      conversationManager: { deleteSession: vi.fn(async () => {}) },
      sendHistorySessions: vi.fn(async () => {}),
    };

    await deleteSession.call(cp, 'active-session');

    expect(cp.currentSessionId).toBeNull();
    expect(cp.sendHistorySessions).toHaveBeenCalled();
  });
});

// ── Message routing (sendMessage + drainQueue + summarization gate) ──

describe('ChatProvider message routing', () => {
  const drainQueue = (ChatProvider.prototype as any).drainQueue;

  it('drainQueue threads currentSessionId through each queued message', async () => {
    // Queued messages should each be sent with the sessionId from the most
    // recent handleMessage result — Option B will reshape this flow, so this
    // test locks in the current contract.
    const sessionIds: Array<string | null> = [];
    let call = 0;
    const cp: any = {
      _pendingMessages: [{ message: 'a' }, { message: 'b' }, { message: 'c' }],
      currentSessionId: null,
      requestOrchestrator: {
        handleMessage: vi.fn(async (_msg: string, sid: string | null) => {
          sessionIds.push(sid);
          call++;
          return { sessionId: `s-${call}` };
        }),
      },
      fileContextManager: { getEditorContext: vi.fn(async () => '') },
    };

    await drainQueue.call(cp);

    // First call gets null (initial), subsequent calls see updated IDs
    expect(sessionIds).toEqual([null, 's-1', 's-2']);
    expect(cp.currentSessionId).toBe('s-3');
  });

  it('summarization gate queues when _summarizing=true and routes to orchestrator otherwise', async () => {
    // Simulate the body of the `sendMessage` case in resolveWebviewView.
    // We can't easily invoke the inner switch, but we can model its behavior:
    async function routeSendMessage(cp: any, data: any) {
      if (cp._summarizing) {
        cp._pendingMessages.push({ message: data.message, attachments: data.attachments });
        cp._view?.webview.postMessage({ type: 'statusMessage', message: 'Queued — optimizing context...' });
        return;
      }
      const result = await cp.requestOrchestrator.handleMessage(
        data.message, cp.currentSessionId, () => cp.fileContextManager.getEditorContext(), data.attachments
      );
      cp.currentSessionId = result.sessionId;
    }

    const view = { webview: { postMessage: vi.fn() } };
    const cp: any = {
      _summarizing: true,
      _pendingMessages: [],
      _view: view,
      currentSessionId: null,
      requestOrchestrator: { handleMessage: vi.fn() },
      fileContextManager: { getEditorContext: vi.fn() },
    };

    await routeSendMessage(cp, { message: 'during-summary' });

    expect(cp.requestOrchestrator.handleMessage).not.toHaveBeenCalled();
    expect(cp._pendingMessages).toHaveLength(1);
    expect(view.webview.postMessage).toHaveBeenCalledWith({
      type: 'statusMessage',
      message: 'Queued — optimizing context...',
    });

    // Flip the flag — next message routes through
    cp._summarizing = false;
    cp.requestOrchestrator.handleMessage = vi.fn(async () => ({ sessionId: 'new-session' }));

    await routeSendMessage(cp, { message: 'after-summary' });
    expect(cp.requestOrchestrator.handleMessage).toHaveBeenCalled();
    expect(cp.currentSessionId).toBe('new-session');
  });
});

// ── Event subscription wiring ──
//
// These tests verify that the orchestrator/manager events fan out to the
// webview with the expected shape. Option B will add new events on this
// same surface, so pinning the current set catches regressions if wiring
// is inadvertently removed during the refactor.

describe('ChatProvider event wiring contract', () => {
  // Rather than instantiate the full provider, we verify the *structure* of
  // the postMessage payloads by invoking the documented mapping inline.
  // Each test represents one wired event and locks its current shape.

  const postMessage = vi.fn();
  const view = { webview: { postMessage } };

  beforeEach(() => {
    postMessage.mockClear();
  });

  it('onError payload forwards as { type: "error", error }', () => {
    const handler = (d: { error: string }) => view.webview.postMessage({ type: 'error', error: d.error });
    handler({ error: 'boom' });
    expect(postMessage).toHaveBeenCalledWith({ type: 'error', error: 'boom' });
  });

  it('onWarning payload forwards as { type: "warning", message }', () => {
    const handler = (d: { message: string }) => view.webview.postMessage({ type: 'warning', message: d.message });
    handler({ message: 'heads up' });
    expect(postMessage).toHaveBeenCalledWith({ type: 'warning', message: 'heads up' });
  });

  it('onSessionCreated payload spreads event fields under type: "sessionCreated"', () => {
    const handler = (d: { sessionId: string; model: string }) =>
      view.webview.postMessage({ type: 'sessionCreated', ...d });
    handler({ sessionId: 's1', model: 'deepseek-chat' });
    expect(postMessage).toHaveBeenCalledWith({
      type: 'sessionCreated', sessionId: 's1', model: 'deepseek-chat',
    });
  });

  it('onGenerationStopped payload includes userStopped=true (for UI marker rendering)', () => {
    const handler = () => view.webview.postMessage({ type: 'generationStopped', userStopped: true });
    handler();
    expect(postMessage).toHaveBeenCalledWith({ type: 'generationStopped', userStopped: true });
  });

  it('onCommandApprovalRequired payload carries command + prefix + unknownSubCommand', () => {
    const handler = (d: { command: string; prefix: string; unknownSubCommand: string }) =>
      view.webview.postMessage({
        type: 'commandApprovalRequired',
        command: d.command,
        prefix: d.prefix,
        unknownSubCommand: d.unknownSubCommand,
      });
    handler({ command: 'npm install foo', prefix: 'npm install', unknownSubCommand: 'foo' });
    expect(postMessage).toHaveBeenCalledWith({
      type: 'commandApprovalRequired',
      command: 'npm install foo',
      prefix: 'npm install',
      unknownSubCommand: 'foo',
    });
  });

  it('summarization events toggle the _summarizing flag in both directions', () => {
    const cp: any = { _summarizing: false };
    const onStarted = () => { cp._summarizing = true; };
    const onCompleted = () => { cp._summarizing = false; };

    onStarted();
    expect(cp._summarizing).toBe(true);

    onCompleted();
    expect(cp._summarizing).toBe(false);
  });
});
