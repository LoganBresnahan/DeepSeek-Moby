/**
 * ADR 0003 Phase 3 Fidelity Test #2 — end-to-end round trip.
 *
 * Script a turn through RequestOrchestrator → capture live structural events →
 * persist them into a real EventStore → hydrate via ConversationManager's new
 * getSessionRichHistory → assert liveEvents == hydratedEvents.
 *
 * This is the safety net for the hydration flip. Any future regression in the
 * emission pipeline, persistence layer, or hydration query will surface here.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { WorkingEventEmitter } = vi.hoisted(() => ({
  WorkingEventEmitter: class WorkingEventEmitter {
    private _listeners: Array<(e: any) => void> = [];
    event = (listener: (e: any) => void) => {
      this._listeners.push(listener);
      return { dispose: () => { this._listeners = this._listeners.filter(l => l !== listener); } };
    };
    fire = (data: any) => { for (const l of this._listeners) l(data); };
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
        get: vi.fn((_key: string, d?: any) => d),
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
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  };
});

vi.mock('../../../src/tools/reasonerShellExecutor', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    executeShellCommands: vi.fn(async (commands: any[]) =>
      commands.map((c: any) => ({
        command: c.command,
        output: `mock output for: ${c.command}`,
        success: true,
        executionTimeMs: 10,
      }))
    ),
  };
});

import { Database } from '../../../src/events/SqlJsWrapper';
import { runMigrations } from '../../../src/events/migrations';
import { EventStore } from '../../../src/events/EventStore';
import { ConversationManager } from '../../../src/events/ConversationManager';
import { RequestOrchestrator } from '../../../src/providers/requestOrchestrator';
import { __resetCustomModelsForTests, __setCustomModelForTests } from '../../../src/models/registry';

describe('Phase 3 Fidelity: live events == hydrated events round-trip', () => {
  const SESSION_ID = 'session-1';
  let db: Database;
  let eventStore: EventStore;
  let getSessionRichHistory: (sid: string) => Promise<any[]>;

  // Minimal orchestrator plumbing
  let orchestrator: RequestOrchestrator;
  let mockClient: any;
  let mockConversation: any;

  beforeEach(() => {
    // Phase 5 flipped 'deepseek-chat' to streamingToolCalls: true. The fidelity
    // contract is shape-agnostic but the multi-turn test depends on the legacy
    // runToolLoop event emission cadence. Override capabilities to legacy shape.
    __setCustomModelForTests('deepseek-chat', {
      toolCalling: 'native',
      reasoningTokens: 'none',
      editProtocol: ['native-tool', 'search-replace'],
      shellProtocol: 'native-tool',
      supportsTemperature: true,
      maxOutputTokens: 8192,
      maxTokensConfigKey: 'maxTokensChatModel',
      streaming: true,
      apiEndpoint: 'https://api.deepseek.com',
      tokenizer: 'deepseek-v3',
      requestFormat: 'openai',
      streamingToolCalls: false,
    });

    db = new Database(':memory:');
    runMigrations(db);
    db.prepare('INSERT INTO sessions (id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(SESSION_ID, 'Test', 'deepseek-chat', 1000, 1000);
    eventStore = new EventStore(db);

    // Bind getSessionRichHistory to a minimal CM-shaped object
    const getShr = ConversationManager.prototype.getSessionRichHistory;
    getSessionRichHistory = (sid) => getShr.call({ eventStore } as any, sid);

    mockClient = {
      getModel: vi.fn(() => 'deepseek-chat'),
      setModel: vi.fn(),
      isReasonerModel: vi.fn(() => false),
      chat: vi.fn(async () => ({ content: '', tool_calls: null })),
      streamChat: vi.fn(async (
        _messages: any,
        onToken: (token: string) => void,
      ) => {
        onToken('Hello ');
        onToken('world!');
        return 'Hello world!';
      }),
      estimateTokens: vi.fn((t: string) => Math.ceil(t.length / 4)),
      buildContext: vi.fn(async (messages: any[]) => ({ messages, tokenCount: 100, budget: 4096 })),
      getBalance: vi.fn(),
    };

    // mockConversation wires recordStructuralEvent and recordAssistantMessage
    // through to the REAL eventStore so the orchestrator's emitted events land
    // in the DB, then we hydrate from the same DB.
    mockConversation = {
      createSession: vi.fn(async () => ({ id: SESSION_ID, title: 'Test', model: 'deepseek-chat', createdAt: new Date().toISOString() })),
      getSession: vi.fn(async () => null),
      recordUserMessage: vi.fn(async (sid: string, content: string) => {
        eventStore.append({ sessionId: sid, timestamp: Date.now(), type: 'user_message', content } as any);
      }),
      getSessionMessagesCompat: vi.fn(async () => [{ role: 'user', content: 'Hello' }]),
      getLatestSnapshotSummary: vi.fn(() => undefined),
      recordAssistantReasoning: vi.fn(),
      recordToolCall: vi.fn(),
      recordToolResult: vi.fn(),
      recordAssistantMessage: vi.fn(async (
        sid: string, content: string, model: string, finishReason: any,
        _usage: any, _iters: any, _unused: any, extras: any
      ) => {
        eventStore.append({
          sessionId: sid, timestamp: Date.now(), type: 'assistant_message',
          content, model, finishReason,
          status: extras?.status, turnId: extras?.turnId,
        } as any);
      }),
      recordStructuralEvent: vi.fn((sid: string, turnId: string, indexInTurn: number, payload: any) => {
        eventStore.append({
          sessionId: sid, timestamp: Date.now(), type: 'structural_turn_event',
          turnId, indexInTurn, payload,
        } as any);
      }),
      getSessionRichHistory: vi.fn(async () => []),
      getAllSessions: vi.fn(async () => []),
      hasFreshSummary: vi.fn(() => false),
      createSnapshot: vi.fn(async () => {}),
      getRecentTurnSequences: vi.fn(() => ({ userSequence: 1, assistantSequence: 2 })),
    };

    const mockStatusBar = { updateLastResponse: vi.fn(), setRequestActive: vi.fn(), update: vi.fn() };
    const noopDisposable = () => ({ dispose: vi.fn() });
    const mockDiffManager = {
      clearProcessedBlocks: vi.fn(), clearPendingDiffs: vi.fn(), clearResponseFileChanges: vi.fn(),
      handleCodeBlockDetection: vi.fn(), detectAndProcessUnfencedEdits: vi.fn(async () => {}),
      getModifiedFilesContext: vi.fn(() => ''), getFileChanges: vi.fn(() => []),
      currentEditMode: 'manual', emitAutoAppliedChanges: vi.fn(),
      handleAutoShowDiff: vi.fn(async () => {}), handleAskModeDiff: vi.fn(async () => {}),
      applyCodeDirectlyForAutoMode: vi.fn(async () => true), showDiff: vi.fn(async () => {}),
      setFlushCallback: vi.fn(), waitForPendingApprovals: vi.fn(async () => []),
      cancelPendingApprovals: vi.fn(), registerShellModifiedFiles: vi.fn(),
      registerShellDeletedFiles: vi.fn(), getFailedAutoApplyCount: vi.fn(() => 0),
      resetFailedAutoApplyCount: vi.fn(),
      onCodeApplied: vi.fn(noopDisposable), onEditRejected: vi.fn(noopDisposable),
    };
    const mockWebSearch = {
      searchForMessage: vi.fn(async () => ''),
      getSettings: vi.fn(async () => ({ enabled: false, settings: {}, configured: false, mode: 'auto' })),
      getMode: vi.fn(() => 'auto'), searchByQuery: vi.fn(async () => ''),
      resetToDefaults: vi.fn(), clearCache: vi.fn(), toggle: vi.fn(), updateSettings: vi.fn(),
    };
    const mockFileContext = {
      clearTurnTracking: vi.fn(), extractFileIntent: vi.fn(), getSelectedFilesContext: vi.fn(() => ''),
      trackReadFile: vi.fn(), sendOpenFiles: vi.fn(), isModalOpen: false, setModalOpen: vi.fn(),
    };

    orchestrator = new RequestOrchestrator(
      mockClient, mockConversation, mockStatusBar as any, mockDiffManager as any,
      mockWebSearch as any, mockFileContext as any, undefined,
      { getActiveContent: () => '' } as any,
    );
  });

  afterEach(() => {
    orchestrator?.dispose();
    __resetCustomModelsForTests();
  });

  it('live structural events match hydrated turnEvents for a simple chat turn', async () => {
    await orchestrator.handleMessage('Hi', SESSION_ID, async () => '', undefined);

    const liveEvents = orchestrator.structuralEvents.peekLastCompleted()!.events;
    expect(liveEvents.length).toBeGreaterThan(0);

    const turns = await getSessionRichHistory(SESSION_ID);
    const assistant = turns.find((t: any) => t.role === 'assistant')!;
    expect(assistant.turnEvents).toEqual(liveEvents);
  });

  it('hydrated assistant turn carries the complete finalization content', async () => {
    await orchestrator.handleMessage('Hi', SESSION_ID, async () => '', undefined);

    const turns = await getSessionRichHistory(SESSION_ID);
    const assistant = turns.find((t: any) => t.role === 'assistant')!;
    // Default mock emits 'Hello ' + 'world!' and saveToHistory stores concatenated
    expect(assistant.content).toContain('Hello');
    expect(assistant.content).toContain('world!');
  });

  it('multi-turn conversation preserves per-turn event grouping after round trip', async () => {
    await orchestrator.handleMessage('First', SESSION_ID, async () => '', undefined);
    const firstTurnLive = [...orchestrator.structuralEvents.peekLastCompleted()!.events];

    await orchestrator.handleMessage('Second', SESSION_ID, async () => '', undefined);
    const secondTurnLive = [...orchestrator.structuralEvents.peekLastCompleted()!.events];

    const turns = await getSessionRichHistory(SESSION_ID);
    const assistantTurns = turns.filter((t: any) => t.role === 'assistant');
    expect(assistantTurns).toHaveLength(2);
    expect(assistantTurns[0].turnEvents).toEqual(firstTurnLive);
    expect(assistantTurns[1].turnEvents).toEqual(secondTurnLive);
  });
});
