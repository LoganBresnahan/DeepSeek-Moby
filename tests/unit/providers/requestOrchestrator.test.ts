import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The default __mocks__/vscode.ts EventEmitter uses vi.fn() stubs that don't
// wire event→fire. We need real subscriptions for testing event-driven classes.
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

// Track config values
const { configStore } = vi.hoisted(() => ({
  configStore: new Map<string, any>()
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
          if (configStore.has(key)) return configStore.get(key);
          const defaults: Record<string, any> = {
            'systemPrompt': '',
            'editMode': 'manual',
            'maxToolCalls': 100,
            'maxShellIterations': 100,
            'allowAllShellCommands': false,
          };
          return defaults[key] ?? defaultValue;
        }),
        update: vi.fn(async (key: string, value: any) => {
          if (value === undefined) configStore.delete(key);
          else configStore.set(key, value);
        }),
        has: vi.fn().mockReturnValue(true),
        inspect: vi.fn()
      })),
      workspaceFolders: [{ uri: { fsPath: '/test/workspace' } }],
      asRelativePath: vi.fn((uri: any) => uri.fsPath || uri)
    },
    window: {
      activeTextEditor: undefined,
      createOutputChannel: vi.fn(() => ({
        appendLine: vi.fn(),
        append: vi.fn(),
        show: vi.fn(),
        clear: vi.fn(),
        dispose: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        trace: vi.fn(),
      })),
      showErrorMessage: vi.fn(),
      showWarningMessage: vi.fn(),
      showInformationMessage: vi.fn(),
    },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  };
});

// Mock reasonerShellExecutor so shell commands don't actually execute
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

import { RequestOrchestrator } from '../../../src/providers/requestOrchestrator';
import { __resetCustomModelsForTests, __setCustomModelForTests } from '../../../src/models/registry';
import { executeShellCommands } from '../../../src/tools/reasonerShellExecutor';
import type {
  StartResponseEvent,
  EndResponseEvent,
  AutoContinuationEvent,
  ToolDetail,
  ToolCallUpdateEvent,
  ShellExecutingEvent,
  ShellResultsEvent,
} from '../../../src/providers/types';

// ── Mock factories ──

function createMockDeepSeekClient() {
  return {
    getModel: vi.fn(() => 'deepseek-chat'),
    setModel: vi.fn(),
    isReasonerModel: vi.fn(() => false),
    chat: vi.fn(async () => ({
      content: 'Tool response',
      tool_calls: null
    })),
    streamChat: vi.fn(async (
      _messages: any,
      onToken: (token: string) => void,
      _systemPrompt: string,
      _onReasoning?: (token: string) => void,
      _options?: any
    ) => {
      // Simulate streaming a response
      onToken('Hello ');
      onToken('world!');
      return 'Hello world!';
    }),
    estimateTokens: vi.fn((text: string) => Math.ceil(text.length / 4)),
    buildContext: vi.fn(async (messages: any[], _systemPrompt: string, _snapshot?: any) => ({
      messages,
      tokenCount: 100,
      budget: 4096
    })),
    getBalance: vi.fn(),
  };
}

function createMockConversationManager() {
  return {
    createSession: vi.fn(async (title?: string, model?: string) => ({
      id: 'test-session-123',
      title: title || 'Test Session',
      model: model || 'deepseek-chat',
      createdAt: new Date().toISOString()
    })),
    getSession: vi.fn(async () => null),
    recordUserMessage: vi.fn().mockResolvedValue({}),
    getSessionMessagesCompat: vi.fn(async () => [
      { role: 'user', content: 'Hello' }
    ]),
    getLatestSnapshotSummary: vi.fn(() => undefined),
    recordAssistantReasoning: vi.fn(),
    recordToolCall: vi.fn(),
    recordToolResult: vi.fn(),
    recordAssistantMessage: vi.fn(async () => {}),
    recordStructuralEvent: vi.fn(),
    getSessionRichHistory: vi.fn(async () => []),
    getAllSessions: vi.fn(async () => []),
    hasFreshSummary: vi.fn(() => false),
    createSnapshot: vi.fn(async () => {}),
    getRecentTurnSequences: vi.fn(() => ({ userSequence: 1, assistantSequence: 2 })),
  };
}

function createMockStatusBar() {
  return {
    updateLastResponse: vi.fn(),
    setRequestActive: vi.fn(),
    update: vi.fn(),
  };
}

function createMockDiffManager() {
  // Subscriptions wired by RequestOrchestrator (ADR 0003 Phase 2.5) expect
  // disposable returns. Return a stub that records the handler for tests that
  // want to invoke it manually.
  const noopDisposable = () => ({ dispose: vi.fn() });
  return {
    clearProcessedBlocks: vi.fn(),
    clearPendingDiffs: vi.fn(),
    clearResponseFileChanges: vi.fn(),
    handleCodeBlockDetection: vi.fn(),
    detectAndProcessUnfencedEdits: vi.fn(async () => {}),
    getModifiedFilesContext: vi.fn(() => ''),
    getFileChanges: vi.fn(() => []),
    currentEditMode: 'manual' as 'manual' | 'ask' | 'auto',
    emitAutoAppliedChanges: vi.fn(),
    handleAutoShowDiff: vi.fn(async () => {}),
    handleAskModeDiff: vi.fn(async () => {}),
    applyCodeDirectlyForAutoMode: vi.fn(async () => true),
    showDiff: vi.fn(async () => {}),
    setFlushCallback: vi.fn(),
    waitForPendingApprovals: vi.fn(async () => []),
    cancelPendingApprovals: vi.fn(),
    registerShellModifiedFiles: vi.fn(),
    registerShellDeletedFiles: vi.fn(),
    getFailedAutoApplyCount: vi.fn(() => 0),
    resetFailedAutoApplyCount: vi.fn(),
    // Edit-safety checkpoint transaction (ADR 0006) — the orchestrator opens
    // one per auto-apply batch and commits at the batch boundary.
    beginEditTransaction: vi.fn(),
    commitEditTransaction: vi.fn(),
    revertEditTransaction: vi.fn(async () => []),
    snapshotPathForCheckpoint: vi.fn(async () => {}),
    onCodeApplied: vi.fn(noopDisposable),
    onEditRejected: vi.fn(noopDisposable),
  };
}

function createMockWebSearchManager() {
  return {
    searchForMessage: vi.fn(async () => ''),
    getSettings: vi.fn(async () => ({
      enabled: false,
      settings: { searchDepth: 'basic', creditsPerPrompt: 1, maxResultsPerSearch: 5, cacheDuration: 15 },
      configured: false,
      mode: 'auto' as const
    })),
    getMode: vi.fn(() => 'auto' as const),
    searchByQuery: vi.fn(async () => ''),
    resetToDefaults: vi.fn(),
    clearCache: vi.fn(),
    toggle: vi.fn(),
    updateSettings: vi.fn(),
    setRecentUserPrompt: vi.fn(),
    getDigestMaxResults: vi.fn(() => 5),
    renderSearchLedger: vi.fn(() => ''), // ADR 0010: per-turn search ledger
  };
}

function createMockFileContextManager() {
  return {
    clearTurnTracking: vi.fn(),
    extractFileIntent: vi.fn(),
    getSelectedFilesContext: vi.fn(() => ''),
    trackReadFile: vi.fn(),
    sendOpenFiles: vi.fn(),
    isModalOpen: false,
    setModalOpen: vi.fn(),
  };
}

describe('RequestOrchestrator', () => {
  let orchestrator: RequestOrchestrator;
  let mockClient: ReturnType<typeof createMockDeepSeekClient>;
  let mockConversation: ReturnType<typeof createMockConversationManager>;
  let mockStatusBar: ReturnType<typeof createMockStatusBar>;
  let mockDiffManager: ReturnType<typeof createMockDiffManager>;
  let mockWebSearch: ReturnType<typeof createMockWebSearchManager>;
  let mockFileContext: ReturnType<typeof createMockFileContextManager>;

  beforeEach(() => {
    configStore.clear();
    mockClient = createMockDeepSeekClient();
    mockConversation = createMockConversationManager();
    mockStatusBar = createMockStatusBar();
    mockDiffManager = createMockDiffManager();
    mockWebSearch = createMockWebSearchManager();
    mockFileContext = createMockFileContextManager();

    // Phase 5 flipped every built-in model to streamingToolCalls: true. Most
    // tests in this file pin contracts of the legacy runToolLoop +
    // streamAndIterate split (still live for custom OpenAI-compat models that
    // don't opt into streaming). Override 'deepseek-chat' with the legacy
    // capability shape so those tests exercise the legacy path. The Phase 4.5
    // describe at line ~1941 swaps in a streaming model id for its scope.
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

    orchestrator = new RequestOrchestrator(
      mockClient as any,
      mockConversation as any,
      mockStatusBar as any,
      mockDiffManager as any,
      mockWebSearch as any,
      mockFileContext as any,
      undefined, // commandApprovalManager
      { getActiveContent: () => '' } as any, // savedPromptManager
    );

    // ADR 0003 Phase 3: receiveTurnEvents retired. Extension authors events
    // directly, no receiver needed from webview side. Tests no longer poke it.
  });

  // Tracks any extra orchestrators constructed inside individual tests
  // (the command-approval-gate suite creates its own with a CAM injected).
  // Without this, those secondary instances leak — each subscribes to its
  // own emitters and the diff manager's flush callback, accumulating across
  // ~8 tests until the worker OOMs mid-run.
  const extraOrchestrators: RequestOrchestrator[] = [];
  const trackOrch = <T extends RequestOrchestrator>(o: T): T => {
    extraOrchestrators.push(o);
    return o;
  };

  afterEach(() => {
    orchestrator?.dispose();
    extraOrchestrators.forEach(o => { try { o.dispose(); } catch { /* ignore */ } });
    extraOrchestrators.length = 0;
    __resetCustomModelsForTests();
  });

  // ── Edit-safety: per-file repair halt wiring (ADR 0006 layer 7) ──
  // Drives the private settle point directly. recordRepairRegression is unit-
  // tested in editValidation.test.ts; this proves the ORCHESTRATION around it —
  // that a regression's reverted files + error set are threaded in and that
  // halt-vs-retry is decided correctly — the path that's hard to trigger live.
  describe('settleEditBatch — per-file repair halt', () => {
    function armAutoBatch(revertedFiles: string[]) {
      mockDiffManager.currentEditMode = 'auto';
      (mockDiffManager as any).hasOpenEditTransaction = true;
      (mockDiffManager as any).checkpointedPaths = revertedFiles;
      mockDiffManager.revertEditTransaction = vi.fn(async () => revertedFiles);
      mockDiffManager.commitEditTransaction = vi.fn();
    }
    function stubVerdict(result: any) {
      (orchestrator as any).editValidator.validateBatch = vi.fn().mockResolvedValue(result);
    }
    async function settleOnce(pushFeedback = vi.fn()) {
      const signal = new AbortController().signal;
      const halt = await (orchestrator as any).settleEditBatch(true, signal, pushFeedback);
      return { halt, pushFeedback };
    }
    const regression = (file: string, code: string) => ({
      verdict: 'regression', command: 'dotnet build', output: `${file}: error ${code}`, errors: [`${file}: error ${code}`],
    });

    it('reverts + retries on a regression, then HALTS on the same error maxRepairAttempts× in a row', async () => {
      configStore.set('editSafety.maxRepairAttempts', 3);
      armAutoBatch(['/ws/a.cs']);
      stubVerdict(regression('a.cs', 'CS1'));

      const r1 = await settleOnce();
      expect(r1.halt).toBe(false);                              // streak 1 → retry
      expect(mockDiffManager.revertEditTransaction).toHaveBeenCalled();
      expect(r1.pushFeedback).toHaveBeenCalledOnce();           // error fed back

      expect((await settleOnce()).halt).toBe(false);            // streak 2 → retry

      const r3 = await settleOnce();
      expect(r3.halt).toBe(true);                               // streak 3 → HALT
      expect(r3.pushFeedback).not.toHaveBeenCalled();           // no retry once halted
    });

    it('does NOT halt when three DIFFERENT files each regress once', async () => {
      configStore.set('editSafety.maxRepairAttempts', 3);
      for (const [file, code] of [['/ws/a.cs', 'CS1'], ['/ws/b.cs', 'CS2'], ['/ws/c.cs', 'CS3']] as const) {
        armAutoBatch([file]);
        stubVerdict(regression(file, code));
        expect((await settleOnce()).halt).toBe(false);          // independent files never accumulate
      }
    });

    it('a CHANGING error on the same file resets the streak (never halts while progressing)', async () => {
      configStore.set('editSafety.maxRepairAttempts', 2);
      armAutoBatch(['/ws/a.cs']);
      for (const code of ['CS1', 'CS2', 'CS3', 'CS4']) {
        stubVerdict(regression('a.cs', code));                  // a different error each round
        expect((await settleOnce()).halt).toBe(false);
      }
    });

    it('clears the per-file budget when the turn boundary resets it', async () => {
      configStore.set('editSafety.maxRepairAttempts', 2);
      armAutoBatch(['/ws/a.cs']);
      stubVerdict(regression('a.cs', 'CS1'));
      expect((await settleOnce()).halt).toBe(false);            // streak 1
      (orchestrator as any)._editRepairByFile.clear();          // what handleMessage does each turn
      expect((await settleOnce()).halt).toBe(false);            // streak back to 1, not 2 → no halt
    });

    it('commits (no revert, no halt) on a clean verdict', async () => {
      armAutoBatch(['/ws/a.cs']);
      stubVerdict({ verdict: 'clean', command: 'dotnet build' });
      expect((await settleOnce()).halt).toBe(false);
      expect(mockDiffManager.commitEditTransaction).toHaveBeenCalled();
      expect(mockDiffManager.revertEditTransaction).not.toHaveBeenCalled();
    });

    it('commits a held verdict (still broken, no new errors — kept, not reverted)', async () => {
      armAutoBatch(['/ws/a.cs']);
      stubVerdict({ verdict: 'held', command: 'dotnet build', note: 'no new errors' });
      expect((await settleOnce()).halt).toBe(false);
      expect(mockDiffManager.commitEditTransaction).toHaveBeenCalled();
      expect(mockDiffManager.revertEditTransaction).not.toHaveBeenCalled();
    });
  });

  // ── Verify-on-stop gate (ADR 0011) ──
  // Drives verifyTurnCompletion directly with stubbed verdict + file state.
  // readArtifactText is stubbed so no real fs is touched (the vscode mock here
  // has no workspace.fs). recordRepairRegression runs for real over the real
  // _editRepairByFile, so the per-file budget bound is exercised end to end.
  describe('verifyTurnCompletion — verify-on-stop gate (ADR 0011)', () => {
    const signal = new AbortController().signal;
    function stubVerdict(verdict: any, batch: any = null) {
      (orchestrator as any).editValidator.getLastVerdict = vi.fn(() => verdict);
      (orchestrator as any).editValidator.getLastBatch = vi.fn(() => batch);
    }
    function stubFiles(paths: string[]) {
      mockDiffManager.getFileChanges = vi.fn(() =>
        paths.map(p => ({ filePath: p, status: 'applied' as const, iteration: 1 })));
    }
    function stubReads(map: Record<string, string | null>) {
      (orchestrator as any).readArtifactText = vi.fn(async (_root: any, p: string) =>
        (p in map ? map[p] : null));
    }
    beforeEach(() => { mockDiffManager.currentEditMode = 'auto'; });

    it('regression verdict at stop → re-injects the build errors, once per turn', async () => {
      stubVerdict('regression', { command: 'dotnet build', output: 'a.cs: error CS1002' });
      stubFiles([]);
      const first = await (orchestrator as any).verifyTurnCompletion(signal);
      expect(first).toContain('still failing');
      expect(first).toContain('CS1002');
      // One-shot guard: a second consult this turn does not re-inject again.
      expect(await (orchestrator as any).verifyTurnCompletion(signal)).toBeNull();
    });

    it('clean verdict + non-empty artifact → accepts the stop (null)', async () => {
      stubVerdict('clean');
      stubFiles(['Components/Slides/Slide3Demo.razor']);
      stubReads({ 'Components/Slides/Slide3Demo.razor': '<div>content</div>' });
      expect(await (orchestrator as any).verifyTurnCompletion(signal)).toBeNull();
    });

    it('clean build but EMPTY deliverable → holds the turn open (the Slide3Demo case)', async () => {
      stubVerdict('clean');
      stubFiles(['Components/Slides/Slide3Demo.razor']);
      stubReads({ 'Components/Slides/Slide3Demo.razor': '   \n  ' }); // whitespace only
      const fb = await (orchestrator as any).verifyTurnCompletion(signal);
      expect(fb).toContain('Slide3Demo.razor');
      expect(fb).toContain('empty');
    });

    it('an empty deliverable stops re-injecting after maxRepairAttempts (bounded + warns)', async () => {
      configStore.set('editSafety.maxRepairAttempts', 2);
      stubVerdict('clean');
      stubFiles(['x.razor']);
      stubReads({ 'x.razor': '' });
      const warnings: string[] = [];
      orchestrator.onWarning(w => warnings.push(w.message));
      expect(await (orchestrator as any).verifyTurnCompletion(signal)).toContain('empty'); // 1 → re-inject
      expect(await (orchestrator as any).verifyTurnCompletion(signal)).toBeNull();          // 2 → stuck → accept
      expect(warnings.some(w => /empty/.test(w))).toBe(true);
    });

    it('inconclusive verdict + present artifact → accepts (no false continuation)', async () => {
      stubVerdict('inconclusive');
      stubFiles(['x.ts']);
      stubReads({ 'x.ts': 'export const x = 1;' });
      expect(await (orchestrator as any).verifyTurnCompletion(signal)).toBeNull();
    });

    it('a missing file is NOT flagged (ambiguous: could be an intentional delete)', async () => {
      stubVerdict('clean');
      stubFiles(['deleted.ts']);
      stubReads({ 'deleted.ts': null }); // read returns null = missing/unreadable
      expect(await (orchestrator as any).verifyTurnCompletion(signal)).toBeNull();
    });

    it('verifyOnStop=false disables the gate entirely', async () => {
      configStore.set('editSafety.verifyOnStop', false);
      stubVerdict('regression', { command: 'build', output: 'err' });
      stubFiles(['x.ts']);
      stubReads({ 'x.ts': '' });
      expect(await (orchestrator as any).verifyTurnCompletion(signal)).toBeNull();
    });

    it('is a no-op outside auto mode', async () => {
      mockDiffManager.currentEditMode = 'manual';
      stubVerdict('regression', { command: 'build', output: 'err' });
      expect(await (orchestrator as any).verifyTurnCompletion(signal)).toBeNull();
    });

    it('no edits this turn → nothing to verify (null)', async () => {
      stubVerdict('clean');
      stubFiles([]);
      expect(await (orchestrator as any).verifyTurnCompletion(signal)).toBeNull();
    });
  });

  // ── Session Management ──

  describe('handleMessage - session management', () => {
    it('should create a new session when currentSessionId is null', async () => {
      const sessionEvents: Array<{ sessionId: string; model: string }> = [];
      orchestrator.onSessionCreated(e => sessionEvents.push(e));

      const result = await orchestrator.handleMessage(
        'Hello', null, async () => '', undefined
      );

      expect(mockConversation.createSession).toHaveBeenCalledWith('Hello', 'deepseek-chat');
      expect(result.sessionId).toBe('test-session-123');
      expect(sessionEvents).toEqual([{ sessionId: 'test-session-123', model: 'deepseek-chat' }]);
    });

    it('should reuse existing session when currentSessionId is provided', async () => {
      const sessionEvents: Array<{ sessionId: string; model: string }> = [];
      orchestrator.onSessionCreated(e => sessionEvents.push(e));

      const result = await orchestrator.handleMessage(
        'Hello', 'existing-session', async () => '', undefined
      );

      expect(mockConversation.createSession).not.toHaveBeenCalled();
      expect(result.sessionId).toBe('existing-session');
      expect(sessionEvents).toHaveLength(0);
    });

    it('should save user message to history', async () => {
      await orchestrator.handleMessage('Hello world', null, async () => '', undefined);

      expect(mockConversation.recordUserMessage).toHaveBeenCalledWith('test-session-123', 'Hello world');
    });
  });

  // ── Turn Preparation ──

  describe('handleMessage - turn preparation', () => {
    it('should clear turn tracking on each message', async () => {
      await orchestrator.handleMessage('Hello', null, async () => '', undefined);

      expect(mockDiffManager.clearProcessedBlocks).toHaveBeenCalled();
      expect(mockDiffManager.clearPendingDiffs).toHaveBeenCalled();
      expect(mockFileContext.clearTurnTracking).toHaveBeenCalled();
      expect(mockDiffManager.clearResponseFileChanges).toHaveBeenCalled();
    });

    it('should extract file intent from message', async () => {
      await orchestrator.handleMessage('Fix the bug in main.ts', null, async () => '', undefined);

      expect(mockFileContext.extractFileIntent).toHaveBeenCalledWith('Fix the bug in main.ts');
    });
  });

  // ── Streaming Events ──

  describe('handleMessage - streaming events', () => {
    it('should fire onStartResponse at the beginning', async () => {
      const events: StartResponseEvent[] = [];
      orchestrator.onStartResponse(e => events.push(e));

      await orchestrator.handleMessage('Hello', null, async () => '', undefined);

      expect(events).toHaveLength(1);
      expect(events[0].isReasoner).toBe(false);
    });

    it('should fire onStartResponse with isReasoner=true for reasoner model', async () => {
      mockClient.isReasonerModel.mockReturnValue(true);
      const events: StartResponseEvent[] = [];
      orchestrator.onStartResponse(e => events.push(e));

      await orchestrator.handleMessage('Hello', null, async () => '', undefined);

      expect(events[0].isReasoner).toBe(true);
    });

    it('should fire onStreamToken for each token', async () => {
      const tokens: string[] = [];
      orchestrator.onStreamToken(e => tokens.push(e.token));

      await orchestrator.handleMessage('Hello', null, async () => '', undefined);

      // ContentTransformBuffer batches tokens, so we may get fewer events
      // but the content should include all tokens
      const combined = tokens.join('');
      expect(combined).toContain('Hello');
      expect(combined).toContain('world');
    });

    it('should fire onEndResponse with clean response', async () => {
      const events: EndResponseEvent[] = [];
      orchestrator.onEndResponse(e => events.push(e));

      await orchestrator.handleMessage('Hello', null, async () => '', undefined);

      expect(events).toHaveLength(1);
      expect(events[0].role).toBe('assistant');
      expect(events[0].content).toContain('Hello world');
      expect(events[0].editMode).toBe('manual');
    });

    it('flushes auto-applied edits at end of response so the live Modified Files dropdown is not missing the last file', async () => {
      // No-tool turn never hits the per-batch emitAutoAppliedChanges() flush
      // (that is gated on fileModifiedInBatch), so this only passes via the
      // end-of-response flush. emitAutoAppliedChanges is incremental/idempotent,
      // so the extra call is a no-op when the tail was already sent.
      await orchestrator.handleMessage('Hello', null, async () => '', undefined);

      expect(mockDiffManager.emitAutoAppliedChanges).toHaveBeenCalled();
    });
  });

  // ── Reasoner Model ──

  describe('handleMessage - reasoner model', () => {
    it('should fire onStreamReasoning for reasoner tokens', async () => {
      mockClient.isReasonerModel.mockReturnValue(true);
      mockClient.streamChat.mockImplementation(async (
        _messages: any,
        onToken: (token: string) => void,
        _systemPrompt: string,
        onReasoning?: (token: string) => void,
        _options?: any
      ) => {
        if (onReasoning) {
          onReasoning('thinking...');
        }
        onToken('answer');
        return 'answer';
      });

      const reasoningTokens: string[] = [];
      orchestrator.onStreamReasoning(e => reasoningTokens.push(e.token));

      await orchestrator.handleMessage('Hello', null, async () => '', undefined);

      expect(reasoningTokens).toContain('thinking...');
    });

    it('should fire onIterationStart for reasoner model', async () => {
      mockClient.isReasonerModel.mockReturnValue(true);
      const events: Array<{ iteration: number }> = [];
      orchestrator.onIterationStart(e => events.push(e));

      await orchestrator.handleMessage('Hello', null, async () => '', undefined);

      expect(events).toHaveLength(1);
      expect(events[0].iteration).toBe(1);
    });

    it('should include reasoning iterations in endResponse', async () => {
      mockClient.isReasonerModel.mockReturnValue(true);
      mockClient.streamChat.mockImplementation(async (
        _messages: any,
        onToken: (token: string) => void,
        _systemPrompt: string,
        onReasoning?: (token: string) => void,
        _options?: any
      ) => {
        if (onReasoning) {
          onReasoning('step 1 reasoning');
        }
        onToken('response content');
        return 'response content';
      });

      const events: EndResponseEvent[] = [];
      orchestrator.onEndResponse(e => events.push(e));

      await orchestrator.handleMessage('Hello', null, async () => '', undefined);

      expect(events[0].reasoning_content).toBe('step 1 reasoning');
      expect(events[0].reasoning_iterations).toEqual(['step 1 reasoning']);
    });
  });

  // ── System Prompt ──

  describe('handleMessage - system prompt', () => {
    it('should include edit mode in system prompt', async () => {
      mockDiffManager.currentEditMode = 'ask';

      await orchestrator.handleMessage('Hello', null, async () => '', undefined);

      // The system prompt is passed to streamChat
      const systemPromptArg = mockClient.streamChat.mock.calls[0][2];
      expect(systemPromptArg).toContain('edit mode: ask');
    });

    it('should include editor context from provider', async () => {
      await orchestrator.handleMessage(
        'Hello', null,
        async () => 'Current File: test.ts\nFull Path: /test/test.ts',
        undefined
      );

      const systemPromptArg = mockClient.streamChat.mock.calls[0][2];
      expect(systemPromptArg).toContain('Current File: test.ts');
    });

    it('should include custom system prompt when configured', async () => {
      // Create orchestrator with a mock saved prompt manager that returns content
      const customOrch = new RequestOrchestrator(
        mockClient as any,
        mockConversation as any,
        mockStatusBar as any,
        mockDiffManager as any,
        mockWebSearch as any,
        mockFileContext as any,
        undefined,
        { getActiveContent: () => 'You are a helpful bot.' } as any,
      );

      await customOrch.handleMessage('Hello', null, async () => '', undefined);

      const systemPromptArg = mockClient.streamChat.mock.calls[0][2];
      expect(systemPromptArg).toContain('You are a helpful bot.');
    });

    it('should include web search results when available', async () => {
      mockWebSearch.searchForMessage.mockResolvedValue('Web result: TypeScript 5.7 features');

      await orchestrator.handleMessage('Hello', null, async () => '', undefined);

      const systemPromptArg = mockClient.streamChat.mock.calls[0][2];
      expect(systemPromptArg).toContain('Web result: TypeScript 5.7 features');
      expect(systemPromptArg).toContain('WEB SEARCH RESULTS');
    });

    it('should include modified files context', async () => {
      mockDiffManager.getModifiedFilesContext.mockReturnValue('\n--- Modified Files ---\nsrc/index.ts (applied)');

      await orchestrator.handleMessage('Hello', null, async () => '', undefined);

      const systemPromptArg = mockClient.streamChat.mock.calls[0][2];
      expect(systemPromptArg).toContain('src/index.ts (applied)');
    });

    it('should include reasoner shell prompt for reasoner model', async () => {
      mockClient.isReasonerModel.mockReturnValue(true);

      await orchestrator.handleMessage('Hello', null, async () => '', undefined);

      const systemPromptArg = mockClient.streamChat.mock.calls[0][2];
      // Reasoner prompt includes shell command instructions
      expect(systemPromptArg).toContain('shell');
    });

    // ── Temporal grounding (ADR 0007) ──
    // The standing date + staleness directive must be present on EVERY turn,
    // not only when a manual-mode web search pre-fetched results. These pin the
    // status-quo gap fix (date was trapped inside the `if (webSearchContext)`
    // branch) and the insertion point (before active plans).
    describe('temporal grounding (ADR 0007)', () => {
      it('includes the temporal block on a normal turn with no web search', async () => {
        // searchForMessage defaults to '' (falsy) → no web-search section.
        await orchestrator.handleMessage('Hello', null, async () => '', undefined);

        const sp = mockClient.streamChat.mock.calls[0][2];
        expect(sp).toContain('TEMPORAL CONTEXT');
        // Staleness-directive keywords — the load-bearing behavioral cue.
        expect(sp).toContain('out of date');
        expect(sp).toContain('time-sensitive');
        expect(sp).toContain('web_search');
      });

      it('renders today\'s date deterministically under a mocked clock', async () => {
        // Fake only Date so setTimeout/microtasks in handleMessage still run.
        // Noon-local avoids the UTC-midnight→previous-day TZ edge.
        const fixed = new Date(2026, 5, 20, 12, 0, 0);
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(fixed);
        try {
          await orchestrator.handleMessage('Hello', null, async () => '', undefined);

          const sp = mockClient.streamChat.mock.calls[0][2];
          // Compute the expected string the same way buildSystemPrompt does,
          // from the same instant, so the assertion is TZ/locale-independent.
          const expected = fixed.toLocaleDateString('en-US', {
            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
          });
          expect(sp).toContain(`Today's date is ${expected}`);
        } finally {
          vi.useRealTimers();
        }
      });

      it('places the temporal block before the active-plans section', async () => {
        // planManager is not injected by the shared beforeEach; stub it so the
        // active-plans section renders, then assert ordering.
        (orchestrator as any).planManager = {
          getActivePlansContext: vi.fn(async () => '\n--- ACTIVE PLANS ---\nStep 1 of 3\n')
        };

        await orchestrator.handleMessage('Hello', null, async () => '', undefined);

        const sp = mockClient.streamChat.mock.calls[0][2];
        const temporalIdx = sp.indexOf('TEMPORAL CONTEXT');
        const plansIdx = sp.indexOf('ACTIVE PLANS');
        expect(temporalIdx).toBeGreaterThan(-1);
        expect(plansIdx).toBeGreaterThan(-1);
        expect(temporalIdx).toBeLessThan(plansIdx);
      });

      it('uses a single date source shared with the web-search header', async () => {
        mockWebSearch.searchForMessage.mockResolvedValue('Web result: live standings');

        await orchestrator.handleMessage('Hello', null, async () => '', undefined);

        const sp = mockClient.streamChat.mock.calls[0][2];
        // The hoisted `today` feeds both the WEB SEARCH RESULTS header and the
        // temporal block — guards against reintroducing a second `new Date()`.
        const headerDate = sp.match(/WEB SEARCH RESULTS \(([^)]+)\)/)?.[1];
        expect(headerDate).toBeTruthy();
        expect(sp).toContain(`Today's date is ${headerDate}`);
      });

      it('includes the temporal block on the reasoner path', async () => {
        mockClient.isReasonerModel.mockReturnValue(true);

        await orchestrator.handleMessage('Hello', null, async () => '', undefined);

        const sp = mockClient.streamChat.mock.calls[0][2];
        expect(sp).toContain('TEMPORAL CONTEXT');
      });
    });
  });

  // ── Web-search ledger wiring (ADR 0010) ──

  describe('dispatchToolCall - web_search ledger (ADR 0010)', () => {
    it('appends the per-turn search ledger to the web_search tool result', async () => {
      mockWebSearch.searchByQuery = vi.fn(async () => 'RAW SEARCH RESULT');
      mockWebSearch.renderSearchLedger = vi.fn(
        () => '\n\nSEARCHES THIS TURN (do not repeat — reuse these results):\n  • "x" → 2 results\n'
      );

      const toolCall = {
        id: 't1',
        type: 'function',
        function: { name: 'web_search', arguments: JSON.stringify({ query: 'x' }) }
      };
      const signal = new AbortController().signal;
      const dispatch = await (orchestrator as any).dispatchToolCall(toolCall, signal);

      expect(mockWebSearch.searchByQuery).toHaveBeenCalledWith('x');
      // The model sees the raw result AND its running search history together.
      expect(dispatch.result).toContain('RAW SEARCH RESULT');
      expect(dispatch.result).toContain('SEARCHES THIS TURN');
    });
  });

  // ── Message Building ──

  describe('handleMessage - message building', () => {
    it('should inject attachments into last user message', async () => {
      const attachments = [
        { content: 'file content here', name: 'test.ts', size: 100 }
      ];

      await orchestrator.handleMessage('Hello', null, async () => '', attachments);

      // Check that buildContext received messages with attachment context
      const messagesArg = mockClient.buildContext.mock.calls[0][0];
      const lastUserMsg = messagesArg[messagesArg.length - 1];
      expect(lastUserMsg.content).toContain('test.ts');
      expect(lastUserMsg.content).toContain('file content here');
    });

    it('should inject selected files context', async () => {
      mockFileContext.getSelectedFilesContext.mockReturnValue('\n--- Selected Files ---\nsrc/app.ts: const x = 1;');

      await orchestrator.handleMessage('Hello', null, async () => '', undefined);

      const messagesArg = mockClient.buildContext.mock.calls[0][0];
      const lastUserMsg = messagesArg[messagesArg.length - 1];
      expect(lastUserMsg.content).toContain('src/app.ts');
    });
  });

  // ── History Save ──

  describe('handleMessage - history save', () => {
    it('should save assistant response to history', async () => {
      await orchestrator.handleMessage('Hello', 'session-1', async () => '', undefined);

      expect(mockConversation.recordAssistantMessage).toHaveBeenCalled();
      // Phase 2: first call is the in_progress placeholder; the final call is
      // the authoritative assistant message with the streamed content.
      const allCalls = mockConversation.recordAssistantMessage.mock.calls;
      const callArgs = allCalls[allCalls.length - 1];
      expect(callArgs[0]).toBe('session-1');
      expect(callArgs[1]).toContain('Hello world');
      expect(callArgs[2]).toBe('deepseek-chat');
      expect(callArgs[3]).toBe('stop');
      expect(callArgs[7]).toMatchObject({ status: 'complete' });
    });

    it('should record file modifications in history', async () => {
      mockDiffManager.getFileChanges.mockReturnValue([
        { filePath: 'src/index.ts', status: 'applied', iteration: 1 },
        { filePath: 'src/utils.ts', status: 'applied', iteration: 1 },
      ]);

      await orchestrator.handleMessage('Hello', 'session-1', async () => '', undefined);

      // Should record _file_modified tool calls
      const toolCallCalls = mockConversation.recordToolCall.mock.calls;
      const fileModCalls = toolCallCalls.filter((c: any) => c[2] === '_file_modified');
      expect(fileModCalls).toHaveLength(2);
    });

    it('should update status bar after successful response', async () => {
      await orchestrator.handleMessage('Hello', null, async () => '', undefined);

      expect(mockStatusBar.updateLastResponse).toHaveBeenCalled();
    });

    it('should fire onTurnSequenceUpdate after saving to history', async () => {
      const seqEvents: Array<{ userSequence?: number; assistantSequence?: number }> = [];
      orchestrator.onTurnSequenceUpdate(e => seqEvents.push(e));

      await orchestrator.handleMessage('Hello', 'session-1', async () => '', undefined);

      expect(mockConversation.getRecentTurnSequences).toHaveBeenCalledWith('session-1');
      expect(seqEvents).toHaveLength(1);
      expect(seqEvents[0].userSequence).toBe(1);
      expect(seqEvents[0].assistantSequence).toBe(2);
    });
  });

  // ── Error Handling ──

  describe('handleMessage - error handling', () => {
    it('should fire onError for API errors', async () => {
      mockClient.streamChat.mockRejectedValue(new Error('API connection failed'));

      const errors: Array<{ error: string }> = [];
      orchestrator.onError(e => errors.push(e));

      await orchestrator.handleMessage('Hello', null, async () => '', undefined);

      expect(errors).toHaveLength(1);
      expect(errors[0].error).toContain('API connection failed');
    });

    it('should save partial response on abort', async () => {
      const abortError = new Error('Request aborted');
      abortError.name = 'AbortError';

      // Make streamChat call onToken then throw abort
      mockClient.streamChat.mockImplementation(async (
        _messages: any,
        onToken: (token: string) => void,
        _systemPrompt: string,
        _onReasoning?: any,
        _options?: any
      ) => {
        onToken('partial ');
        throw abortError;
      });

      await orchestrator.handleMessage('Hello', 'session-1', async () => '', undefined);

      // Should record partial message with [Generation stopped].
      // Phase 2 also writes an in_progress placeholder first — use objectContaining
      // on the calls list rather than exact-match on a single call.
      expect(mockConversation.recordAssistantMessage).toHaveBeenCalledWith(
        'session-1',
        expect.stringContaining('[Generation stopped]'),
        'deepseek-chat',
        'stop',
        undefined, undefined, undefined,
        expect.objectContaining({ status: 'interrupted' })
      );
    });

    it('should not fire onError for abort', async () => {
      const abortError = new Error('Request aborted');
      abortError.name = 'AbortError';
      mockClient.streamChat.mockRejectedValue(abortError);

      const errors: Array<{ error: string }> = [];
      orchestrator.onError(e => errors.push(e));

      await orchestrator.handleMessage('Hello', null, async () => '', undefined);

      expect(errors).toHaveLength(0);
    });

    // ADR 0001: user-initiated stop must save only the *[User interrupted]* marker
    // and drop the partial assistant content. Backend aborts keep partial content.
    // See: docs/architecture/decisions/0001-stop-button-discards-partial.md
    it('user-initiated stop saves only the marker, dropping partial content', async () => {
      mockClient.streamChat.mockImplementation(async (
        _messages: any,
        onToken: (token: string) => void,
      ) => {
        onToken('some partial streamed content that should NOT be persisted');
        orchestrator.stopGeneration();
        const abortError = new Error('Request aborted');
        abortError.name = 'AbortError';
        throw abortError;
      });

      await orchestrator.handleMessage('Hello', 'session-1', async () => '', undefined);

      // Phase 2 writes an in_progress placeholder at turn start, then the
      // interrupted finalization at abort time. Assert against the finalization
      // (last call) — the placeholder's empty content is expected and not
      // the assertion target here.
      const calls = mockConversation.recordAssistantMessage.mock.calls;
      expect(calls.length).toBeGreaterThanOrEqual(1);
      const savedText = calls[calls.length - 1][1];
      expect(savedText).toBe('*[User interrupted]*');
      expect(savedText).not.toContain('partial streamed content');
      expect(savedText).not.toContain('Generation stopped');
      expect(calls[calls.length - 1][7]).toMatchObject({ status: 'interrupted' });
    });

    it('backend abort (no user stop) keeps partial content alongside the marker', async () => {
      mockClient.streamChat.mockImplementation(async (
        _messages: any,
        onToken: (token: string) => void,
      ) => {
        onToken('partial streamed content');
        const abortError = new Error('Request aborted');
        abortError.name = 'AbortError';
        throw abortError;
      });

      await orchestrator.handleMessage('Hello', 'session-1', async () => '', undefined);

      const calls = mockConversation.recordAssistantMessage.mock.calls;
      const savedText = calls[calls.length - 1][1];
      expect(savedText).toContain('partial streamed content');
      expect(savedText).toContain('*[Generation stopped]*');
      expect(savedText).not.toContain('*[User interrupted]*');
      expect(calls[calls.length - 1][7]).toMatchObject({ status: 'interrupted' });
    });

    it('_userInitiatedStop flag resets after use so next abort is treated as backend', async () => {
      // First call: user-initiated stop
      mockClient.streamChat.mockImplementationOnce(async (
        _messages: any,
        onToken: (token: string) => void,
      ) => {
        onToken('first partial');
        orchestrator.stopGeneration();
        const abortError = new Error('Request aborted');
        abortError.name = 'AbortError';
        throw abortError;
      });
      await orchestrator.handleMessage('Hello', 'session-1', async () => '', undefined);

      // Second call: backend abort with no stopGeneration() call
      mockClient.streamChat.mockImplementationOnce(async (
        _messages: any,
        onToken: (token: string) => void,
      ) => {
        onToken('second partial');
        const abortError = new Error('Request aborted');
        abortError.name = 'AbortError';
        throw abortError;
      });
      await orchestrator.handleMessage('Hello again', 'session-1', async () => '', undefined);

      // Phase 2: filter out the placeholder writes — only finalization rows
      // carry a status of 'interrupted' or 'complete'. The ADR 0001 guarantee
      // is about what gets persisted as the authoritative turn record.
      const finalizations = mockConversation.recordAssistantMessage.mock.calls.filter(
        (c: any[]) => c[7] && (c[7].status === 'interrupted' || c[7].status === 'complete')
      );
      expect(finalizations.length).toBeGreaterThanOrEqual(2);
      const firstSaved = finalizations[0][1];
      const secondSaved = finalizations[1][1];
      expect(firstSaved).toBe('*[User interrupted]*');
      expect(secondSaved).toContain('second partial');
      expect(secondSaved).toContain('*[Generation stopped]*');
    });

    it('should provide helpful message for context length errors with attachments', async () => {
      mockClient.streamChat.mockRejectedValue(new Error('Context length exceeded'));

      const errors: Array<{ error: string }> = [];
      orchestrator.onError(e => errors.push(e));

      const attachments = [
        { content: 'x'.repeat(50000), name: 'big.ts', size: 50000 }
      ];
      await orchestrator.handleMessage('Hello', null, async () => '', attachments);

      expect(errors[0].error).toContain('attached files');
      expect(errors[0].error).toContain('KB');
    });
  });

  // ── stopGeneration ──

  describe('stopGeneration', () => {
    // ADR 0008: stopGeneration is now async — it fires onGenerationStopped only
    // after the in-flight loop's teardown resolves. With no active request the
    // teardown is an already-resolved promise, so the fire is one microtask away.
    it('should fire onGenerationStopped', async () => {
      const events: void[] = [];
      orchestrator.onGenerationStopped(() => events.push(undefined));

      await orchestrator.stopGeneration();

      expect(events).toHaveLength(1);
    });

    it('should fire onGenerationStopped even without active request', async () => {
      const events: void[] = [];
      orchestrator.onGenerationStopped(() => events.push(undefined));

      await orchestrator.stopGeneration();

      expect(events).toHaveLength(1);
    });

    it('defers generationStopped until the in-flight turn has torn down (ADR 0008)', async () => {
      const order: string[] = [];
      orchestrator.onGenerationStopped(() => order.push('generationStopped'));

      // Simulate an in-flight turn: a pending teardown deferred + an active
      // controller, exactly as handleMessage sets up at turn start.
      const deferred = (orchestrator as any).makeDeferred();
      (orchestrator as any)._teardownDeferred = deferred;
      (orchestrator as any).abortController = new AbortController();

      const stop = orchestrator.stopGeneration(); // aborts, then awaits teardown
      await Promise.resolve();
      // Teardown is still pending → generationStopped must NOT have fired yet.
      expect(order).not.toContain('generationStopped');

      order.push('teardown');
      deferred.resolve();                          // what handleMessage's finally does
      await stop;

      // generationStopped fires only AFTER teardown — the serialization guarantee.
      expect(order).toEqual(['teardown', 'generationStopped']);
    });
  });

  // ── Code Block Detection ──

  describe('handleMessage - code block detection', () => {
    it('should call diffManager.handleCodeBlockDetection during streaming', async () => {
      await orchestrator.handleMessage('Hello', null, async () => '', undefined);

      expect(mockDiffManager.handleCodeBlockDetection).toHaveBeenCalled();
    });

    it('should call detectAndProcessUnfencedEdits for non-manual mode', async () => {
      mockDiffManager.currentEditMode = 'ask';

      await orchestrator.handleMessage('Hello', null, async () => '', undefined);

      expect(mockDiffManager.detectAndProcessUnfencedEdits).toHaveBeenCalled();
    });

    it('should not call detectAndProcessUnfencedEdits for manual mode', async () => {
      mockDiffManager.currentEditMode = 'manual';

      await orchestrator.handleMessage('Hello', null, async () => '', undefined);

      expect(mockDiffManager.detectAndProcessUnfencedEdits).not.toHaveBeenCalled();
    });
  });

  // ── Tool Loop (Chat Model) ──

  describe('handleMessage - tool loop', () => {
    it('should run tool loop for chat model (not reasoner)', async () => {
      // Set up a tool call response followed by a final response
      let callCount = 0;
      mockClient.chat.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            content: '',
            tool_calls: [{
              id: 'tc-1',
              type: 'function',
              function: { name: 'read_file', arguments: '{"path":"src/index.ts"}' }
            }]
          };
        }
        // Second call: no tool calls, end loop
        return { content: 'Done exploring', tool_calls: null };
      });

      const toolStartEvents: Array<{ tools: ToolDetail[] }> = [];
      const toolUpdateEvents: ToolCallUpdateEvent[] = [];
      const toolEndEvents: void[] = [];
      orchestrator.onToolCallsStart(e => toolStartEvents.push(e));
      orchestrator.onToolCallUpdate(e => toolUpdateEvents.push(e));
      orchestrator.onToolCallsEnd(() => toolEndEvents.push(undefined));

      await orchestrator.handleMessage('Read the file', null, async () => '', undefined);

      expect(toolStartEvents).toHaveLength(1);
      expect(toolStartEvents[0].tools[0].name).toBe('read_file');
      // Should have running + done updates
      expect(toolUpdateEvents).toHaveLength(2);
      expect(toolEndEvents).toHaveLength(1);
    });

    it('should not run tool loop for reasoner model', async () => {
      mockClient.isReasonerModel.mockReturnValue(true);

      await orchestrator.handleMessage('Hello', null, async () => '', undefined);

      // chat() is used by the tool loop; it should not be called for reasoner
      expect(mockClient.chat).not.toHaveBeenCalled();
    });

    // edit_file takes a structured `edits: [{search, replace}, ...]`
    // array. The orchestrator synthesizes the SEARCH/REPLACE block string
    // that downstream diff machinery expects, so the assertions check the
    // synthesized format rather than the raw model-facing input.
    const edit = { search: 'old code', replace: 'console.log("hello")' };
    const expectedBlock =
      `<<<<<<< SEARCH\nold code\n=======\nconsole.log("hello")\n>>>>>>> REPLACE`;

    it('should call showDiff for edit_file in manual mode', async () => {
      mockDiffManager.currentEditMode = 'manual';

      let callCount = 0;
      mockClient.chat.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            content: '',
            tool_calls: [{
              id: 'tc-1',
              type: 'function',
              function: {
                name: 'edit_file',
                arguments: JSON.stringify({
                  file: 'src/index.ts',
                  edits: [edit],
                  language: 'typescript'
                })
              }
            }]
          };
        }
        return { content: 'Done', tool_calls: null };
      });

      await orchestrator.handleMessage('Edit the file', null, async () => '', undefined);

      expect(mockDiffManager.showDiff).toHaveBeenCalledWith(
        `# File: src/index.ts\n${expectedBlock}`,
        'typescript'
      );
      expect(mockDiffManager.applyCodeDirectlyForAutoMode).not.toHaveBeenCalled();
      expect(mockDiffManager.handleAskModeDiff).not.toHaveBeenCalled();
    });

    it('should call applyCodeDirectlyForAutoMode for edit_file in auto mode', async () => {
      mockDiffManager.currentEditMode = 'auto';

      let callCount = 0;
      mockClient.chat.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            content: '',
            tool_calls: [{
              id: 'tc-1',
              type: 'function',
              function: {
                name: 'edit_file',
                arguments: JSON.stringify({
                  file: 'src/index.ts',
                  edits: [edit],
                  language: 'typescript'
                })
              }
            }]
          };
        }
        return { content: 'Done', tool_calls: null };
      });

      await orchestrator.handleMessage('Edit the file', null, async () => '', undefined);

      expect(mockDiffManager.applyCodeDirectlyForAutoMode).toHaveBeenCalledWith(
        'src/index.ts',
        expectedBlock,
        undefined,
        true
      );
      expect(mockDiffManager.showDiff).not.toHaveBeenCalled();
    });

    // ADR 0006 (edit safety) — the auto-apply batch is wrapped in a checkpoint
    // transaction: opened before dispatch, committed at the batch boundary.
    it('opens and commits a checkpoint transaction for an auto-mode edit batch', async () => {
      mockDiffManager.currentEditMode = 'auto';

      let callCount = 0;
      mockClient.chat.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            content: '',
            tool_calls: [{
              id: 'tc-1',
              type: 'function',
              function: {
                name: 'edit_file',
                arguments: JSON.stringify({ file: 'src/index.ts', edits: [edit], language: 'typescript' })
              }
            }]
          };
        }
        return { content: 'Done', tool_calls: null };
      });

      await orchestrator.handleMessage('Edit the file', null, async () => '', undefined);

      expect(mockDiffManager.beginEditTransaction).toHaveBeenCalled();
      expect(mockDiffManager.commitEditTransaction).toHaveBeenCalled();
    });

    it('does not open a checkpoint transaction in manual mode', async () => {
      mockDiffManager.currentEditMode = 'manual';

      let callCount = 0;
      mockClient.chat.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            content: '',
            tool_calls: [{
              id: 'tc-1',
              type: 'function',
              function: {
                name: 'edit_file',
                arguments: JSON.stringify({ file: 'src/index.ts', edits: [edit], language: 'typescript' })
              }
            }]
          };
        }
        return { content: 'Done', tool_calls: null };
      });

      await orchestrator.handleMessage('Edit the file', null, async () => '', undefined);

      expect(mockDiffManager.beginEditTransaction).not.toHaveBeenCalled();
    });

    // Regression: when the auto-apply reports failure (no clean match), the
    // model must be TOLD — with actionable guidance — not left thinking the
    // edit landed. The tool-result message fed back into the next chat() call
    // must carry the "did not match / re-read" guidance. This is the
    // end-to-end payoff of DiffManager returning false on a non-match.
    it('surfaces re-read guidance to the model when an auto edit_file fails to apply', async () => {
      mockDiffManager.currentEditMode = 'auto';
      // The apply layer reports failure (e.g. SEARCH text not verbatim).
      mockDiffManager.applyCodeDirectlyForAutoMode.mockResolvedValue(false);

      let callCount = 0;
      mockClient.chat.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            content: '',
            tool_calls: [{
              id: 'tc-1',
              type: 'function',
              function: {
                name: 'edit_file',
                arguments: JSON.stringify({
                  file: 'src/index.ts',
                  edits: [edit],
                  language: 'typescript'
                })
              }
            }]
          };
        }
        return { content: 'Done', tool_calls: null };
      });

      await orchestrator.handleMessage('Edit the file', null, async () => '', undefined);

      // The tool result is appended as a { role: 'tool', content } message and
      // sent on the next chat() call. Find it and assert it carries guidance.
      const toolResultMessages = mockClient.chat.mock.calls
        .flatMap((call: any[]) => (Array.isArray(call[0]) ? call[0] : []))
        .filter((m: any) => m && m.role === 'tool' && typeof m.content === 'string');
      const failureMsg = toolResultMessages.find((m: any) => m.content.includes('edit_file failed'));

      expect(failureMsg).toBeDefined();
      expect(failureMsg.content).toMatch(/did not match/i);
      expect(failureMsg.content).toMatch(/re-read/i);
    });

    it('should call handleAskModeDiff for edit_file in ask mode', async () => {
      mockDiffManager.currentEditMode = 'ask';
      mockDiffManager.waitForPendingApprovals.mockResolvedValue([{ approved: true, filePath: 'src/index.ts' }]);

      let callCount = 0;
      mockClient.chat.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            content: '',
            tool_calls: [{
              id: 'tc-1',
              type: 'function',
              function: {
                name: 'edit_file',
                arguments: JSON.stringify({
                  file: 'src/index.ts',
                  edits: [edit],
                  language: 'typescript'
                })
              }
            }]
          };
        }
        return { content: 'Done', tool_calls: null };
      });

      await orchestrator.handleMessage('Edit the file', null, async () => '', undefined);

      expect(mockDiffManager.handleAskModeDiff).toHaveBeenCalledWith(
        `# File: src/index.ts\n${expectedBlock}`,
        'typescript'
      );
      expect(mockDiffManager.showDiff).not.toHaveBeenCalled();
      expect(mockDiffManager.applyCodeDirectlyForAutoMode).not.toHaveBeenCalled();
    });
  });

  // ── Tool-loop budget exhaustion ──

  describe('handleMessage - tool budget exhaustion', () => {
    it('caps tool iterations at moby.maxToolCalls and falls through to streaming', async () => {
      // Configure a tight tool-call cap. moby.maxToolCalls === 100 means
      // "no limit" (Infinity), so 2 actually constrains.
      configStore.set('maxToolCalls', 2);

      // Each chat() call returns a tool call — with no terminator, the loop
      // would run forever without the cap.
      mockClient.chat.mockImplementation(async () => ({
        content: '',
        tool_calls: [{
          id: `tc-${Math.random().toString(36).slice(2, 7)}`,
          type: 'function' as const,
          function: { name: 'read_file', arguments: '{"path":"src/index.ts"}' }
        }]
      }));

      await orchestrator.handleMessage('Read everything', null, async () => '', undefined);

      // chat() should be called exactly maxToolCalls times — once per iteration —
      // before the loop bails and hands off to streamChat for the final answer.
      expect(mockClient.chat).toHaveBeenCalledTimes(2);
      expect(mockClient.streamChat).toHaveBeenCalledTimes(1);
    });

    it('appends the "tool calling limit reached" warning to the streaming system prompt', async () => {
      configStore.set('maxToolCalls', 1);
      mockClient.chat.mockImplementation(async () => ({
        content: '',
        tool_calls: [{
          id: 'tc-1',
          type: 'function' as const,
          function: { name: 'read_file', arguments: '{"path":"src/x.ts"}' }
        }]
      }));

      await orchestrator.handleMessage('Read', null, async () => '', undefined);

      // streamChat is called with (messages, onToken, systemPrompt, onReasoning, options).
      const streamCall = mockClient.streamChat.mock.calls.at(-1);
      const systemPrompt = streamCall?.[2] as string | undefined;
      expect(systemPrompt).toMatch(/tool calling limit was reached/i);
      // And the standard "exploration phase complete" hand-off line is still there —
      // budget exhaustion appends to it, doesn't replace it.
      expect(systemPrompt).toMatch(/tool exploration phase is now complete/i);
    });

    it('does NOT add the limit warning when the tool loop ended naturally', async () => {
      configStore.set('maxToolCalls', 5);
      let callCount = 0;
      mockClient.chat.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            content: '',
            tool_calls: [{
              id: 'tc-1', type: 'function' as const,
              function: { name: 'read_file', arguments: '{"path":"src/x.ts"}' }
            }]
          };
        }
        // Natural end — no more tool_calls.
        return { content: 'done', tool_calls: null };
      });

      await orchestrator.handleMessage('Read', null, async () => '', undefined);

      const systemPrompt = mockClient.streamChat.mock.calls.at(-1)?.[2] as string | undefined;
      expect(systemPrompt).not.toMatch(/tool calling limit was reached/i);
    });
  });

  // ── Proactive Context Compression ──

  describe('handleMessage - proactive context compression', () => {
    it('should trigger summarization when context usage exceeds 80%', async () => {
      // Set buildContext to return >80% usage
      mockClient.buildContext.mockResolvedValue({
        messages: [{ role: 'user', content: 'Hello' }],
        tokenCount: 9000,
        budget: 10000
      });
      mockConversation.hasFreshSummary.mockReturnValue(false);

      const startEvents: void[] = [];
      const completeEvents: void[] = [];
      orchestrator.onSummarizationStarted(() => startEvents.push(undefined));
      orchestrator.onSummarizationCompleted(() => completeEvents.push(undefined));

      await orchestrator.handleMessage('Hello', 'session-1', async () => '', undefined);

      expect(mockConversation.createSnapshot).toHaveBeenCalledWith('session-1');
      expect(startEvents).toHaveLength(1);
      expect(completeEvents).toHaveLength(1);
    });

    it('should NOT trigger summarization when context usage is below 80%', async () => {
      // Set buildContext to return <80% usage
      mockClient.buildContext.mockResolvedValue({
        messages: [{ role: 'user', content: 'Hello' }],
        tokenCount: 5000,
        budget: 10000
      });

      await orchestrator.handleMessage('Hello', 'session-1', async () => '', undefined);

      expect(mockConversation.createSnapshot).not.toHaveBeenCalled();
    });

    it('should NOT trigger summarization when summary is fresh', async () => {
      mockClient.buildContext.mockResolvedValue({
        messages: [{ role: 'user', content: 'Hello' }],
        tokenCount: 9000,
        budget: 10000
      });
      mockConversation.hasFreshSummary.mockReturnValue(true);

      await orchestrator.handleMessage('Hello', 'session-1', async () => '', undefined);

      expect(mockConversation.createSnapshot).not.toHaveBeenCalled();
    });

    it('should NOT trigger summarization when budget is 0', async () => {
      mockClient.buildContext.mockResolvedValue({
        messages: [{ role: 'user', content: 'Hello' }],
        tokenCount: 100,
        budget: 0
      });

      await orchestrator.handleMessage('Hello', 'session-1', async () => '', undefined);

      expect(mockConversation.createSnapshot).not.toHaveBeenCalled();
    });

    it('should handle summarization errors gracefully', async () => {
      mockClient.buildContext.mockResolvedValue({
        messages: [{ role: 'user', content: 'Hello' }],
        tokenCount: 9500,
        budget: 10000
      });
      mockConversation.hasFreshSummary.mockReturnValue(false);
      mockConversation.createSnapshot.mockRejectedValue(new Error('LLM API down'));

      const errors: Array<{ error: string }> = [];
      orchestrator.onError(e => errors.push(e));

      const completeEvents: void[] = [];
      orchestrator.onSummarizationCompleted(() => completeEvents.push(undefined));

      // Should not throw — error is caught internally
      await orchestrator.handleMessage('Hello', 'session-1', async () => '', undefined);

      // Summarization completed event should still fire (even on error)
      expect(completeEvents).toHaveLength(1);
      // The main onError should NOT fire for summarization failures
      expect(errors).toHaveLength(0);
    });

    it('should fire at exactly 80% usage threshold', async () => {
      mockClient.buildContext.mockResolvedValue({
        messages: [{ role: 'user', content: 'Hello' }],
        tokenCount: 8000,
        budget: 10000
      });
      mockConversation.hasFreshSummary.mockReturnValue(false);

      await orchestrator.handleMessage('Hello', 'session-1', async () => '', undefined);

      // 80% is NOT > 80%, so should NOT trigger
      expect(mockConversation.createSnapshot).not.toHaveBeenCalled();
    });

    it('should trigger at 81% usage', async () => {
      mockClient.buildContext.mockResolvedValue({
        messages: [{ role: 'user', content: 'Hello' }],
        tokenCount: 8100,
        budget: 10000
      });
      mockConversation.hasFreshSummary.mockReturnValue(false);

      await orchestrator.handleMessage('Hello', 'session-1', async () => '', undefined);

      expect(mockConversation.createSnapshot).toHaveBeenCalledWith('session-1');
    });
  });

  // ── Command Approval Gate ──

  describe('command approval gate', () => {
    function createMockCommandApprovalManager() {
      // Minimal event emitter stubs for the subscriptions wired by
      // RequestOrchestrator's structural event recorder (ADR 0003).
      const noopDisposable = () => ({ dispose: vi.fn() });
      return {
        checkCommand: vi.fn(() => 'allowed' as 'allowed' | 'blocked' | 'ask'),
        addRule: vi.fn(),
        removeRule: vi.fn(),
        getAllRules: vi.fn(() => []),
        resetToDefaults: vi.fn(),
        extractPrefix: vi.fn((cmd: string) => cmd.split(' ').slice(0, 2).join(' ')),
        splitCompoundCommand: vi.fn((cmd: string) => [cmd]),
        findUnknownSubCommand: vi.fn((cmd: string) => cmd),
        requestApproval: vi.fn(async (cmd: string) => ({ command: cmd, decision: 'blocked' as const, persistent: false })),
        cancelPendingApproval: vi.fn(),
        onApprovalRequired: vi.fn(noopDisposable),
        onApprovalResolved: vi.fn(noopDisposable),
      };
    }

    it('should accept optional CommandApprovalManager in constructor', () => {
      const mockApproval = createMockCommandApprovalManager();
      const orch = trackOrch(new RequestOrchestrator(
        mockClient as any,
        mockConversation as any,
        mockStatusBar as any,
        mockDiffManager as any,
        mockWebSearch as any,
        mockFileContext as any,
        mockApproval as any,
      ));
      expect(orch).toBeDefined();
    });

    it('should work without CommandApprovalManager (backward compatible)', () => {
      const orch = trackOrch(new RequestOrchestrator(
        mockClient as any,
        mockConversation as any,
        mockStatusBar as any,
        mockDiffManager as any,
        mockWebSearch as any,
        mockFileContext as any,
      ));
      expect(orch).toBeDefined();
    });

    // SKIPPED: pre-existing OOM root cause documented in CLAUDE.md. This
    // test (and the three "interrupt-and-resume" cases below) exercise
    // RequestOrchestrator's reasoner shell loop end-to-end. Even with a
    // mock that throws AbortError on signal, the resume path enters an
    // unbounded re-stream cycle that fills the heap and times out vitest's
    // worker. The shell-loop code was rewritten under ADR 0003 / Phase 3
    // and the test scaffolding here hasn't been updated to match.
    //
    // The behavior is still covered indirectly:
    //   - CommandApprovalManager.checkCommand has 70+ direct unit tests.
    //   - reasonerShellExecutor.parseShellCommands + validateCommand have
    //     64 direct unit tests including the BLOCKED_PATTERNS regression.
    //
    // Re-enable after refactoring the mock to drive the shell loop without
    // re-entering streamChat (e.g., directly invoke the dispatch surface
    // exposed for testing) or wiring a signal-aware mock that the loop
    // honors. Tracked separately from this commit's test-coverage push.
    it('should call checkCommand for each shell command when manager is present', async () => {
      const mockApproval = createMockCommandApprovalManager();
      mockApproval.checkCommand.mockReturnValue('allowed');

      const orch = trackOrch(new RequestOrchestrator(
        mockClient as any,
        mockConversation as any,
        mockStatusBar as any,
        mockDiffManager as any,
        mockWebSearch as any,
        mockFileContext as any,
        mockApproval as any,
      ));

      // Setup reasoner model that returns one shell command per resume cycle.
      // The orchestrator's ContentTransformBuffer aborts the stream when it
      // detects a `<shell>` tag (interrupt-and-resume); the mock must honor
      // `options.signal` and throw AbortError, otherwise the resume loop
      // spins forever because each new streamChat call returns the same
      // shell-tag content. (The pre-existing version of this mock issued
      // two tags in one chunk + ignored the signal — that was the root
      // cause of the full-suite OOM logged in CLAUDE.md.)
      mockClient.isReasonerModel.mockReturnValue(true);
      let callCount = 0;
      mockClient.streamChat.mockImplementation(async (
        _messages: any,
        onToken: (token: string) => void,
        _systemPrompt: string,
        _onReasoning?: (token: string) => void,
        options?: { signal?: AbortSignal },
      ) => {
        callCount++;
        const content =
          callCount === 1 ? '<shell>ls -la</shell>' :
          callCount === 2 ? '<shell>pwd</shell>' :
          'Done.';
        onToken(content);
        if ((callCount === 1 || callCount === 2) && options?.signal?.aborted) {
          const err = new Error('aborted');
          err.name = 'AbortError';
          throw err;
        }
        return content;
      });

      // allowAllShellCommands = false (default) so approval gate is active
      configStore.set('allowAllShellCommands', false);

      const shellEvents: ShellResultsEvent[] = [];
      orch.onShellResults(e => shellEvents.push(e));

      await orch.handleMessage('List files', 'session-1', async () => '', undefined);

      // checkCommand should have been called for each parsed shell command
      expect(mockApproval.checkCommand).toHaveBeenCalledWith('ls -la');
      expect(mockApproval.checkCommand).toHaveBeenCalledWith('pwd');
    });

    it('should show approval prompt for blocked commands via interrupt-and-resume', async () => {
      const mockApproval = createMockCommandApprovalManager();
      mockApproval.checkCommand.mockReturnValue('blocked');
      // Simulate user rejecting the command in the approval prompt
      mockApproval.requestApproval.mockResolvedValue({
        command: 'rm -rf /tmp/test',
        decision: 'blocked',
        persistent: false,
      });

      const orch = trackOrch(new RequestOrchestrator(
        mockClient as any,
        mockConversation as any,
        mockStatusBar as any,
        mockDiffManager as any,
        mockWebSearch as any,
        mockFileContext as any,
        mockApproval as any,
      ));

      mockClient.isReasonerModel.mockReturnValue(true);
      let callCount = 0;
      mockClient.streamChat.mockImplementation(async (
        _messages: any,
        onToken: (token: string) => void,
        _systemPrompt: string,
        _onReasoning?: (token: string) => void,
        options?: { signal?: AbortSignal },
      ) => {
        callCount++;
        if (callCount === 1) {
          // First call: stream content with shell tag — buffer detects it and aborts
          const content = '<shell>rm -rf /tmp/test</shell>';
          onToken(content);
          // Check if signal was aborted by the buffer's onShellDetected callback
          if (options?.signal?.aborted) {
            const err = new Error('aborted');
            err.name = 'AbortError';
            throw err;
          }
          return content;
        }
        // Second call (after interrupt): return final response
        const finalContent = 'Command was rejected.';
        onToken(finalContent);
        return finalContent;
      });

      configStore.set('allowAllShellCommands', false);

      await orch.handleMessage('Clean up', 'session-1', async () => '', undefined);

      // Blocked commands show approval prompt via interrupt-and-resume
      expect(mockApproval.requestApproval).toHaveBeenCalled();
    });

    it('should block "ask" commands via interrupt-and-resume approval', async () => {
      const mockApproval = createMockCommandApprovalManager();
      mockApproval.checkCommand.mockReturnValue('ask');
      // Simulate user blocking the command
      mockApproval.requestApproval.mockResolvedValue({
        command: 'curl https://example.com',
        decision: 'blocked',
        persistent: false,
      });

      const orch = trackOrch(new RequestOrchestrator(
        mockClient as any,
        mockConversation as any,
        mockStatusBar as any,
        mockDiffManager as any,
        mockWebSearch as any,
        mockFileContext as any,
        mockApproval as any,
      ));

      mockClient.isReasonerModel.mockReturnValue(true);
      let callCount = 0;
      mockClient.streamChat.mockImplementation(async (
        _messages: any,
        onToken: (token: string) => void,
        _systemPrompt: string,
        _onReasoning?: (token: string) => void,
        options?: { signal?: AbortSignal },
      ) => {
        callCount++;
        if (callCount === 1) {
          const content = '<shell>curl https://example.com</shell>';
          onToken(content);
          if (options?.signal?.aborted) {
            const err = new Error('aborted');
            err.name = 'AbortError';
            throw err;
          }
          return content;
        }
        const finalContent = 'Request blocked.';
        onToken(finalContent);
        return finalContent;
      });

      configStore.set('allowAllShellCommands', false);

      await orch.handleMessage('Fetch data', 'session-1', async () => '', undefined);

      // requestApproval should have been called via interrupt-and-resume
      expect(mockApproval.requestApproval).toHaveBeenCalledWith('curl https://example.com');
    });

    it('should bypass approval gate when allowAllShellCommands is true', async () => {
      const mockApproval = createMockCommandApprovalManager();

      const orch = trackOrch(new RequestOrchestrator(
        mockClient as any,
        mockConversation as any,
        mockStatusBar as any,
        mockDiffManager as any,
        mockWebSearch as any,
        mockFileContext as any,
        mockApproval as any,
      ));

      mockClient.isReasonerModel.mockReturnValue(true);
      // Issue ONE shell command on the first call, then a no-shell terminator
      // on subsequent calls. Returning the same shell content forever made the
      // reasoner shell loop iterate without bound — the orchestrator restarts
      // the stream after each interrupt and the model (mock) keeps emitting
      // the same tag. Honoring options.signal lets the catch-block path fire
      // immediately rather than relying on the post-stream interrupt check.
      let callCount = 0;
      mockClient.streamChat.mockImplementation(async (
        _messages: any,
        onToken: (token: string) => void,
        _systemPrompt: string,
        _onReasoning?: (token: string) => void,
        options?: { signal?: AbortSignal },
      ) => {
        callCount++;
        const content = callCount === 1
          ? '<shell>some-unknown-command</shell>'
          : 'Done.';
        onToken(content);
        if (callCount === 1 && options?.signal?.aborted) {
          const err = new Error('aborted');
          err.name = 'AbortError';
          throw err;
        }
        return content;
      });

      // Enable bypass mode
      configStore.set('allowAllShellCommands', true);

      await orch.handleMessage('Do something', 'session-1', async () => '', undefined);

      // checkCommand should NOT have been called — bypass mode skips the gate
      expect(mockApproval.checkCommand).not.toHaveBeenCalled();
    });
  });

  // ── Dispose ──

  describe('dispose', () => {
    it('should dispose without throwing', () => {
      expect(() => orchestrator.dispose()).not.toThrow();
    });

    it('should not fire events after dispose', () => {
      const events: any[] = [];
      orchestrator.onGenerationStopped(() => events.push('stopped'));

      orchestrator.dispose();
      orchestrator.stopGeneration();

      expect(events).toHaveLength(0);
    });
  });

  // ADR 0003 Phase 1: StructuralEventRecorder fidelity.
  // The recorder subscribes to existing emitters; a turn passing through the
  // orchestrator must leave a consistent event trail in the recorder. This
  // test locks in the Phase 1 contract so Phases 2 and 3 can assert richer
  // fidelity (live == saved == hydrated) against the same surface.
  describe('structural event recorder', () => {
    it('starts and drains a turn around handleMessage', async () => {
      const recorder = orchestrator.structuralEvents;
      expect(recorder.peekCurrent()).toBeNull();

      await orchestrator.handleMessage('Hello', 'session-1', async () => '', undefined);

      // Turn completed and drained
      expect(recorder.peekCurrent()).toBeNull();
      const last = recorder.peekLastCompleted();
      expect(last).not.toBeNull();
      expect(last?.sessionId).toBe('session-1');
    });

    it('records shell-start and shell-complete events with matching IDs when the orchestrator emits them', () => {
      const recorder = orchestrator.structuralEvents;
      recorder.startTurn('turn-x', 'session-1');

      // Simulate the orchestrator firing shell events (as happens during a real turn).
      (orchestrator as any)._onShellExecuting.fire({
        commands: [{ command: 'ls', description: 'list' }],
      });
      (orchestrator as any)._onShellResults.fire({
        results: [{ command: 'ls', output: 'file.txt', success: true }],
      });

      const snap = recorder.peekCurrent();
      expect(snap?.events).toHaveLength(2);
      const [start, complete] = snap!.events;
      expect(start.type).toBe('shell-start');
      expect(complete.type).toBe('shell-complete');
      // Start and complete share the same generated id
      expect((start as any).id).toBe((complete as any).id);
    });

    it('emits iteration-end only when transitioning out of a real iteration', () => {
      // The very first onIterationStart (iteration=1) does NOT emit iteration-end
      // for a phantom iteration 0 — there was nothing to end. Subsequent
      // transitions (1→2, 2→3) emit iteration-end for the completed iteration.
      const recorder = orchestrator.structuralEvents;
      recorder.startTurn('turn-x', 'session-1');

      (orchestrator as any)._onIterationStart.fire({ iteration: 1 });
      (orchestrator as any)._onIterationStart.fire({ iteration: 2 });
      (orchestrator as any)._onIterationStart.fire({ iteration: 3 });

      const events = recorder.peekCurrent()!.events;
      expect(events.filter(e => e.type === 'iteration-end')).toEqual([
        { type: 'iteration-end', iteration: 1, ts: expect.any(Number) },
        { type: 'iteration-end', iteration: 2, ts: expect.any(Number) },
      ]);
    });

    it('drains the recorder on abort so partial turns are inspectable', async () => {
      const recorder = orchestrator.structuralEvents;
      const abortError = new Error('Request aborted');
      abortError.name = 'AbortError';
      mockClient.streamChat.mockImplementation(async (
        _messages: any,
        onToken: (token: string) => void,
      ) => {
        onToken('partial');
        throw abortError;
      });

      await orchestrator.handleMessage('Hello', 'session-1', async () => '', undefined);

      expect(recorder.peekCurrent()).toBeNull();
      expect(recorder.peekLastCompleted()).not.toBeNull();
    });

    it('emits text-append events as the stream tokens arrive', async () => {
      const recorder = orchestrator.structuralEvents;
      await orchestrator.handleMessage('Hello', 'session-1', async () => '', undefined);

      const last = recorder.peekLastCompleted()!;
      const textEvents = last.events.filter(e => e.type === 'text-append');
      // The default mock emits 'Hello ' and 'world!'
      expect(textEvents.map((e: any) => e.content)).toEqual(['Hello ', 'world!']);
    });

    it('Chat-model turn does NOT emit a phantom iteration-end(0) at completion', async () => {
      // Chat model doesn't iterate, so iteration-end must be absent at end-of-turn.
      const recorder = orchestrator.structuralEvents;
      await orchestrator.handleMessage('Hello', 'session-1', async () => '', undefined);

      const last = recorder.peekLastCompleted()!;
      const endEvents = last.events.filter(e => e.type === 'iteration-end');
      expect(endEvents).toHaveLength(0);
    });

    it('Reasoner-model turn emits a final iteration-end on normal completion', async () => {
      mockClient.isReasonerModel.mockReturnValue(true);
      const recorder = orchestrator.structuralEvents;
      await orchestrator.handleMessage('Hello', 'session-1', async () => '', undefined);

      const last = recorder.peekLastCompleted()!;
      const endEvents = last.events.filter(e => e.type === 'iteration-end');
      expect(endEvents.length).toBeGreaterThanOrEqual(1);
      expect(last.events[last.events.length - 1].type).toBe('iteration-end');
    });

    it('extracts code-block events from streamed text at end of iteration', async () => {
      // Use Reasoner so end-of-turn flushes code blocks via iteration-end.
      mockClient.isReasonerModel.mockReturnValue(true);
      mockClient.streamChat.mockImplementationOnce(async (
        _messages: any,
        onToken: (token: string) => void,
      ) => {
        onToken('Here is some code:\n```typescript\nconst x = 1;\n```\nAnd more prose.');
      });

      const recorder = orchestrator.structuralEvents;
      await orchestrator.handleMessage('Hello', 'session-1', async () => '', undefined);

      const last = recorder.peekLastCompleted()!;
      const codeBlocks = last.events.filter(e => e.type === 'code-block') as Array<{
        type: 'code-block'; language: string; content: string;
      }>;
      expect(codeBlocks).toHaveLength(1);
      expect(codeBlocks[0].language).toBe('typescript');
      expect(codeBlocks[0].content).toBe('const x = 1;');
    });

    // ADR 0003 Phase 2: incremental persistence of structural events + status lifecycle.

    it('writes an in_progress placeholder at turn start before any structural events', async () => {
      // The placeholder must be the FIRST recordAssistantMessage call so a crash
      // before the final save still leaves an anchor for hydration.
      mockClient.streamChat.mockImplementationOnce(async () => {});

      await orchestrator.handleMessage('Hello', 'session-1', async () => '', undefined);

      const calls = mockConversation.recordAssistantMessage.mock.calls;
      expect(calls.length).toBeGreaterThanOrEqual(1);
      const firstCall = calls[0];
      // Signature: (sessionId, content, model, finishReason, usage, contentIterations, turnEvents, extras)
      expect(firstCall[0]).toBe('session-1');
      expect(firstCall[1]).toBe('');
      expect(firstCall[7]).toMatchObject({ status: 'in_progress' });
      expect(firstCall[7].turnId).toMatch(/^session-1-\d+$/);
    });

    it('finalizes with status=complete on clean turn completion', async () => {
      await orchestrator.handleMessage('Hello', 'session-1', async () => '', undefined);

      const calls = mockConversation.recordAssistantMessage.mock.calls;
      const finalCall = calls[calls.length - 1];
      expect(finalCall[7]).toMatchObject({ status: 'complete' });
      expect(finalCall[7].turnId).toMatch(/^session-1-\d+$/);
      // Placeholder and final share the same turnId (correlation for hydration)
      expect(finalCall[7].turnId).toBe(calls[0][7].turnId);
    });

    it('marks status=interrupted on abort path', async () => {
      const abortError = new Error('Request aborted');
      abortError.name = 'AbortError';
      mockClient.streamChat.mockImplementation(async (
        _messages: any,
        onToken: (token: string) => void,
      ) => {
        onToken('partial');
        throw abortError;
      });

      await orchestrator.handleMessage('Hello', 'session-1', async () => '', undefined);

      const calls = mockConversation.recordAssistantMessage.mock.calls;
      const abortCall = calls[calls.length - 1];
      expect(abortCall[7]).toMatchObject({ status: 'interrupted' });
    });

    it('persists each structural event to the events table with monotonic indexInTurn', async () => {
      await orchestrator.handleMessage('Hello', 'session-1', async () => '', undefined);

      const calls = mockConversation.recordStructuralEvent.mock.calls;
      expect(calls.length).toBeGreaterThan(0);

      // indexInTurn is the 3rd argument; should be 0, 1, 2, ... in order.
      const indices = calls.map((c: any[]) => c[2]);
      for (let i = 0; i < indices.length; i++) {
        expect(indices[i]).toBe(i);
      }

      // All calls share the same turnId (2nd argument)
      const turnIds = new Set(calls.map((c: any[]) => c[1]));
      expect(turnIds.size).toBe(1);
    });

    it('each recordStructuralEvent payload matches what was appended to the recorder', async () => {
      await orchestrator.handleMessage('Hello', 'session-1', async () => '', undefined);

      const persisted = mockConversation.recordStructuralEvent.mock.calls.map((c: any[]) => c[3]);
      const live = orchestrator.structuralEvents.peekLastCompleted()!.events;
      expect(persisted).toEqual(live);
    });

    // Phase 2.5 coverage

    it('resets shell/approval IDs on turn start so stale state from a prior turn does not leak', async () => {
      // Seed stale state (simulating a turn that aborted mid-shell).
      (orchestrator as any)._currentShellIdForRecorder = 'sh-stale';
      (orchestrator as any)._currentApprovalIdForRecorder = 'ap-stale';
      (orchestrator as any)._iterationContentAccum = 'stale content';
      (orchestrator as any)._iterationCodeBlocksEmitted = 7;

      await orchestrator.handleMessage('Hello', 'session-1', async () => '', undefined);

      // After turn start and drain, instance state must be clean.
      expect((orchestrator as any)._currentShellIdForRecorder).toBeNull();
      expect((orchestrator as any)._currentApprovalIdForRecorder).toBeNull();
    });

    it('abort path emits a final iteration-end before draining (Reasoner turn)', async () => {
      // Only Reasoner turns have real iteration boundaries to close. Chat-model
      // turns never enter an iteration, so iteration-end is correctly skipped
      // for them (no phantom iteration-end(0)).
      mockClient.isReasonerModel.mockReturnValue(true);
      const abortError = new Error('Request aborted');
      abortError.name = 'AbortError';
      mockClient.streamChat.mockImplementation(async (
        _messages: any,
        onToken: (token: string) => void,
      ) => {
        onToken('partial');
        throw abortError;
      });

      await orchestrator.handleMessage('Hello', 'session-1', async () => '', undefined);

      const last = orchestrator.structuralEvents.peekLastCompleted()!;
      const lastEvent = last.events[last.events.length - 1];
      expect(lastEvent.type).toBe('iteration-end');
    });

    it('drains the recorder on non-abort API errors (400/500) so the turn is inspectable', async () => {
      // Regression guard: before the error-path drain fix, a backend error
      // (non-abort) left the recorder mid-turn forever. The Export Turn debug
      // command would show inFlightTurn set and lastCompletedTurn null.
      mockClient.streamChat.mockRejectedValue(new Error('HTTP 400: Bad Request'));

      const recorder = orchestrator.structuralEvents;
      await orchestrator.handleMessage('Hello', 'session-1', async () => '', undefined);

      expect(recorder.peekCurrent()).toBeNull();
      expect(recorder.peekLastCompleted()).not.toBeNull();
    });

    // Regression guard: before the API-error finalization fix, the catch
    // path did NOT write a finalization row, so ConversationManager
    // hydration synthesized a `shutdown-interrupted` event and the user
    // saw "*[Interrupted by shutdown — partial response restored]*" on a
    // turn that actually died to a backend error. The fix writes a
    // proper finalization with a `*[API error: ...]*` marker and
    // status='interrupted'.
    it('finalizes the assistant_message with *[API error: ...]* marker on backend errors', async () => {
      mockClient.streamChat.mockImplementation(async (
        _messages: any,
        onToken: (token: string) => void,
      ) => {
        onToken('halfway there');
        throw new Error('HTTP 500: upstream is on fire');
      });

      await orchestrator.handleMessage('Hello', 'session-1', async () => '', undefined);

      const calls = mockConversation.recordAssistantMessage.mock.calls;
      // Find the finalization call (status: 'interrupted').
      const finalization = calls.find(c =>
        c[7] && typeof c[7] === 'object' && c[7].status === 'interrupted'
      );
      expect(finalization).toBeDefined();
      const savedText = finalization![1] as string;
      expect(savedText).toMatch(/\*\[API error: .+\]\*/);
      expect(savedText).toContain('upstream is on fire');
      // Partial content is preserved alongside the marker.
      expect(savedText).toContain('halfway there');
      // And it is NOT the misleading shutdown marker.
      expect(savedText).not.toMatch(/Interrupted by shutdown/i);
    });

    it('writes only the *[API error: ...]* marker when no partial content streamed', async () => {
      mockClient.streamChat.mockRejectedValue(new Error('connection refused'));

      await orchestrator.handleMessage('Hello', 'session-1', async () => '', undefined);

      const calls = mockConversation.recordAssistantMessage.mock.calls;
      const finalization = calls.find(c =>
        c[7] && typeof c[7] === 'object' && c[7].status === 'interrupted'
      );
      expect(finalization).toBeDefined();
      expect(finalization![1]).toBe('*[API error: connection refused]*');
    });

    it('abort path on Chat-model turn drains without a phantom iteration-end(0)', async () => {
      // Regression guard: before the iteration-end-guard fix, Chat turns
      // emitted iteration-end(0) at end-of-turn even though no iteration ran.
      const abortError = new Error('Request aborted');
      abortError.name = 'AbortError';
      mockClient.streamChat.mockImplementation(async (
        _messages: any,
        onToken: (token: string) => void,
      ) => {
        onToken('partial');
        throw abortError;
      });

      await orchestrator.handleMessage('Hello', 'session-1', async () => '', undefined);

      const last = orchestrator.structuralEvents.peekLastCompleted()!;
      const iterEnds = last.events.filter(e => e.type === 'iteration-end');
      expect(iterEnds).toHaveLength(0);
    });

    it('emits thinking-complete BEFORE text-append when content follows reasoning', async () => {
      mockClient.isReasonerModel.mockReturnValue(true);
      // The ordering matters for hydration: thinking block must close before the
      // first visible content token is recorded.
      mockClient.streamChat.mockImplementationOnce(async (
        _messages: any,
        onToken: (token: string) => void,
        _sys: string,
        onReasoning?: (t: string) => void,
      ) => {
        onReasoning?.('planning...');
        onToken('Here is the answer');
      });

      await orchestrator.handleMessage('Hello', 'session-1', async () => '', undefined);

      const events = orchestrator.structuralEvents.peekLastCompleted()!.events;
      const completeIdx = events.findIndex(e => e.type === 'thinking-complete');
      const firstTextIdx = events.findIndex(e => e.type === 'text-append');
      expect(completeIdx).toBeGreaterThan(-1);
      expect(firstTextIdx).toBeGreaterThan(completeIdx);
    });

    it('re-opens thinking if reasoning arrives after content (new thinking-start emitted)', async () => {
      mockClient.isReasonerModel.mockReturnValue(true);
      mockClient.streamChat.mockImplementationOnce(async (
        _messages: any,
        onToken: (token: string) => void,
        _sys: string,
        onReasoning?: (t: string) => void,
      ) => {
        onReasoning?.('first thought');
        onToken('visible text');
        onReasoning?.('second thought');
      });

      await orchestrator.handleMessage('Hello', 'session-1', async () => '', undefined);

      const events = orchestrator.structuralEvents.peekLastCompleted()!.events;
      const starts = events.filter(e => e.type === 'thinking-start');
      const completes = events.filter(e => e.type === 'thinking-complete');
      // Two thinking blocks: start/complete/start/complete
      expect(starts.length).toBe(2);
      expect(completes.length).toBe(2);
    });

    it('emits tool-batch events for Chat-model tool calls', () => {
      const recorder = orchestrator.structuralEvents;
      recorder.startTurn('turn-x', 'session-1');

      (orchestrator as any)._onToolCallsStart.fire({
        tools: [{ name: 'edit_file', detail: '', status: 'pending' }],
      });
      (orchestrator as any)._onToolCallUpdate.fire({ index: 0, status: 'done', detail: '' });
      (orchestrator as any)._onToolCallsEnd.fire();

      const events = recorder.peekCurrent()!.events;
      expect(events.map(e => e.type)).toEqual([
        'tool-batch-start', 'tool-update', 'tool-batch-complete',
      ]);
    });

    it('emits file-modified on DiffManager.onCodeApplied with the applied status', () => {
      const recorder = orchestrator.structuralEvents;
      recorder.startTurn('turn-x', 'session-1');

      // DiffManager's mock has currentEditMode='manual' from createMockDiffManager
      const diffCalls = (mockDiffManager as any).onCodeApplied.mock.calls;
      // Retrieve the subscription handler registered by wireStructuralRecorder
      // (handler is the first argument to onCodeApplied(...))
      const handler = diffCalls[diffCalls.length - 1][0];
      handler({ success: true, filePath: 'src/game.ts' });

      const events = recorder.peekCurrent()!.events;
      expect(events).toContainEqual(expect.objectContaining({
        type: 'file-modified',
        path: 'src/game.ts',
        status: 'applied',
      }));
    });

    it('recordDrawing appends a drawing event to the current turn', () => {
      const recorder = orchestrator.structuralEvents;
      recorder.startTurn('turn-x', 'session-1');

      orchestrator.recordDrawing('data:image/png;base64,abc');

      const events = recorder.peekCurrent()!.events;
      expect(events).toContainEqual(expect.objectContaining({
        type: 'drawing',
        imageDataUrl: 'data:image/png;base64,abc',
      }));
    });

    it('pairs approval-created and approval-resolved with the same id', async () => {
      // Inject a command approval manager that fires its events synchronously.
      const { CommandApprovalManager } = await import('../../../src/providers/commandApprovalManager');
      const mockDb: any = {
        prepare: () => ({ get: () => ({ rules_version: 0 }), run: () => {}, all: () => [] }),
        transaction: (fn: any) => fn,
      };
      const cam = new (CommandApprovalManager as any)(mockDb, undefined);

      // Rebuild orchestrator with the command approval manager wired in.
      orchestrator.dispose();
      orchestrator = new RequestOrchestrator(
        mockClient as any, mockConversation as any, mockStatusBar as any,
        mockDiffManager as any, mockWebSearch as any, mockFileContext as any,
        cam, { getActiveContent: () => '' } as any,
      );
      // ADR 0003 Phase 3: no receiveTurnEvents hookup needed.

      const recorder = orchestrator.structuralEvents;
      recorder.startTurn('turn-x', 'session-1');

      // Start a shell so approval has something to correlate with.
      (orchestrator as any)._onShellExecuting.fire({
        commands: [{ command: 'npm install', description: '' }],
      });
      // Fire approval lifecycle
      (cam as any)._onApprovalRequired.fire({
        command: 'npm install', prefix: 'npm install', unknownSubCommand: 'install',
      });
      (cam as any)._onApprovalResolved.fire({
        command: 'npm install', decision: 'allowed', persistent: false,
      });

      const events = recorder.peekCurrent()!.events;
      const created = events.find(e => e.type === 'approval-created') as any;
      const resolved = events.find(e => e.type === 'approval-resolved') as any;
      expect(created).toBeDefined();
      expect(resolved).toBeDefined();
      expect(created.id).toBe(resolved.id);
      expect(created.shellId).toMatch(/^sh-\d+$/);
      expect(resolved.decision).toBe('allowed');

      cam.dispose();
    });
  });

  // ── Phase 4.5: streaming-tool-calls loop ──
  //
  // Native-tool models with `streamingToolCalls: true` skip the
  // runToolLoop + streamAndIterate split and route through a single
  // streaming pipeline. The pipeline emits content + reasoning_content
  // + tool_calls deltas in parallel and dispatches tools inline until
  // `finish_reason: 'stop'`. These tests pin the contract.
  //
  // We register a custom model with `streamingToolCalls: true` per-test
  // and point `mockClient.getModel()` at it so the orchestrator's branch
  // selects the new path. Cleanup happens in afterEach via the shared
  // `__resetCustomModelsForTests` hook.
  describe('handleMessage - streaming tool calls (Phase 4.5)', () => {
    const STREAMING_MODEL_ID = 'test-streaming-tool-model';
    let registry: typeof import('../../../src/models/registry');

    beforeEach(async () => {
      registry = await import('../../../src/models/registry');
      registry.registerCustomModels([{
        id: STREAMING_MODEL_ID,
        name: 'Test Streaming Tool Model',
        toolCalling: 'native',
        reasoningTokens: 'inline',
        editProtocol: ['native-tool', 'search-replace'],
        shellProtocol: 'native-tool',
        supportsTemperature: false,
        maxOutputTokens: 8192,
        maxTokensConfigKey: 'maxTokensTestStreaming',
        streaming: true,
        apiEndpoint: 'http://test.local',
        apiKey: 'test',
        requestFormat: 'openai',
        streamingToolCalls: true,
        sendThinkingParam: true,
        reasoningEcho: 'required',
      }]);
      mockClient.getModel.mockReturnValue(STREAMING_MODEL_ID);
    });

    afterEach(() => {
      registry.__resetCustomModelsForTests();
    });

    it('streams content + reasoning live and exits on finish_reason="stop"', async () => {
      // Single iteration — no tool calls, just content and reasoning.
      mockClient.streamChat.mockImplementationOnce(async (
        _messages: any,
        onToken: (t: string) => void,
        _sys: string,
        onReasoning?: (t: string) => void,
      ) => {
        onReasoning?.('Thinking about this...');
        onToken('The answer ');
        onToken('is 42.');
        return {
          content: 'The answer is 42.',
          reasoning_content: 'Thinking about this...',
          finish_reason: 'stop',
        };
      });

      const tokens: string[] = [];
      const reasoningTokens: string[] = [];
      orchestrator.onStreamToken(e => tokens.push(e.token));
      orchestrator.onStreamReasoning(e => reasoningTokens.push(e.token));

      await orchestrator.handleMessage('Hi', 'session-1', async () => '', undefined);

      expect(tokens).toEqual(['The answer ', 'is 42.']);
      expect(reasoningTokens).toEqual(['Thinking about this...']);
      // streamChat should have been called exactly once — no tool re-entry.
      expect(mockClient.streamChat).toHaveBeenCalledTimes(1);
      // chat() — the legacy non-streaming probe — must NOT be called.
      expect(mockClient.chat).not.toHaveBeenCalled();
    });

    it('dispatches tool_calls via the shared helper and re-enters the loop', async () => {
      let call = 0;
      mockClient.streamChat.mockImplementation(async (
        _messages: any,
        onToken: (t: string) => void,
      ) => {
        call++;
        if (call === 1) {
          onToken('Let me check that file.');
          return {
            content: 'Let me check that file.',
            tool_calls: [{
              id: 'call_1', type: 'function' as const,
              function: { name: 'read_file', arguments: '{"path":"src/foo.ts"}' }
            }],
            finish_reason: 'tool_calls',
          };
        }
        // Post-tool: model writes the final answer.
        onToken('Found it.');
        return { content: 'Found it.', finish_reason: 'stop' };
      });

      await orchestrator.handleMessage('Read src/foo.ts', 'session-1', async () => '', undefined);

      // Two streamChat calls: one for the tool decision, one for the final answer.
      expect(mockClient.streamChat).toHaveBeenCalledTimes(2);
      // Tool batch lifecycle fired in order.
      expect(mockClient.chat).not.toHaveBeenCalled();
    });

    it('reasoning_content surfaces during the tool-decision phase (the whole point of 4.5)', async () => {
      let call = 0;
      mockClient.streamChat.mockImplementation(async (
        _messages: any,
        onToken: (t: string) => void,
        _sys: string,
        onReasoning?: (t: string) => void,
      ) => {
        call++;
        if (call === 1) {
          // Reasoning streams BEFORE the tool call decision is known to the UI.
          onReasoning?.('I should read the file first.');
          onToken('Reading.');
          return {
            content: 'Reading.',
            reasoning_content: 'I should read the file first.',
            tool_calls: [{
              id: 'c1', type: 'function' as const,
              function: { name: 'read_file', arguments: '{"path":"a.ts"}' }
            }],
            finish_reason: 'tool_calls',
          };
        }
        onToken('Done.');
        return { content: 'Done.', finish_reason: 'stop' };
      });

      const reasoningTokens: string[] = [];
      orchestrator.onStreamReasoning(e => reasoningTokens.push(e.token));

      await orchestrator.handleMessage('Hi', 'session-1', async () => '', undefined);

      // Reasoning was surfaced live during the tool turn — before today's
      // streamAndIterate would have been reached.
      expect(reasoningTokens).toEqual(['I should read the file first.']);
    });

    it('emits tool batch UI events (start, per-call running/done, end)', async () => {
      let call = 0;
      mockClient.streamChat.mockImplementation(async (
        _messages: any,
        onToken: (t: string) => void,
      ) => {
        call++;
        if (call === 1) {
          onToken('Reading.');
          return {
            content: 'Reading.',
            tool_calls: [{
              id: 'c1', type: 'function' as const,
              function: { name: 'read_file', arguments: '{"path":"x.ts"}' }
            }],
            finish_reason: 'tool_calls',
          };
        }
        onToken('Done.');
        return { content: 'Done.', finish_reason: 'stop' };
      });

      const startEvents: Array<{ tools: ToolDetail[] }> = [];
      const updateEvents: ToolCallUpdateEvent[] = [];
      const endEvents: void[] = [];
      orchestrator.onToolCallsStart(e => startEvents.push(e));
      orchestrator.onToolCallUpdate(e => updateEvents.push(e));
      orchestrator.onToolCallsEnd(() => endEvents.push(undefined));

      await orchestrator.handleMessage('Read x.ts', 'session-1', async () => '', undefined);

      expect(startEvents).toHaveLength(1);
      expect(startEvents[0].tools[0].name).toBe('read_file');
      expect(startEvents[0].tools[0].detail).toBe('read: x.ts');
      // Per-call updates: running first, then a terminal status (done in
      // production, error here because the test workspace path doesn't
      // exist on disk so readFile fails — but the lifecycle is the same).
      const statuses = updateEvents.map(e => e.status);
      expect(statuses[0]).toBe('running');
      expect(statuses).toContain(statuses.includes('done') ? 'done' : 'error');
      expect(endEvents).toHaveLength(1);
    });

    it('pre-announces tool calls via onToolCallStreaming so the UI shows the tool name before the stream resolves', async () => {
      // The whole point of the option-1 fix: when the model commits to a
      // tool call (id + function.name arrive in the stream), the orchestrator
      // fires onToolCallsStart immediately with name-only detail. After the
      // stream fully resolves and arguments have accumulated, an update
      // fires with enriched detail (e.g. `write: a.ts` instead of
      // `write_file`). Closes the silent gap users saw between reasoning
      // ending and tool dispatch beginning.
      let call = 0;
      mockClient.streamChat.mockImplementation(async (
        _messages: any,
        onToken: (t: string) => void,
        _systemPrompt: string,
        _onReasoning?: (t: string) => void,
        options?: any
      ) => {
        call++;
        if (call === 1) {
          onToken('Reading.');
          // Simulate the mid-stream metadata delta that streamChat would
          // dispatch via onToolCallStreaming when the model first commits
          // to the tool call. Args are still empty at this point — they
          // stream as later deltas.
          options?.onToolCallStreaming?.({
            id: 'call_w', type: 'function',
            function: { name: 'write_file', arguments: '' },
          });
          // Then the stream "resolves" — args have fully accumulated.
          return {
            content: 'Reading.',
            tool_calls: [{
              id: 'call_w', type: 'function',
              function: { name: 'write_file', arguments: '{"path":"a.ts","content":"x"}' }
            }],
            finish_reason: 'tool_calls',
          };
        }
        onToken('Done.');
        return { content: 'Done.', finish_reason: 'stop' };
      });

      const startEvents: Array<{ tools: ToolDetail[] }> = [];
      const updateBatchEvents: Array<{ tools: ToolDetail[] }> = [];
      orchestrator.onToolCallsStart(e => startEvents.push(e));
      orchestrator.onToolCallsUpdate(e => updateBatchEvents.push(e));

      await orchestrator.handleMessage('Hi', 'session-1', async () => '', undefined);

      // Start fired exactly once with name-only detail (the streaming
      // callback's payload).
      expect(startEvents).toHaveLength(1);
      expect(startEvents[0].tools[0].name).toBe('write_file');
      expect(startEvents[0].tools[0].detail).toBe('write_file');

      // After the stream resolved with full args, an update fired with
      // enriched detail (`write: a.ts`). Find that specific event.
      const enriched = updateBatchEvents.find(e =>
        e.tools.length === 1 && e.tools[0].detail === 'write: a.ts'
      );
      expect(enriched).toBeDefined();
    });

    it('falls back to firing onToolCallsStart at end of stream when streaming callback never fires', async () => {
      // Defensive: if the model returns tool_calls without streaming any
      // metadata deltas first (shouldn't happen on the wire, but the API
      // contract doesn't guarantee delta order), we still need to render
      // the batch. The post-stream code detects toolContainerStarted=false
      // and fires start as a fallback.
      let call = 0;
      mockClient.streamChat.mockImplementation(async (
        _messages: any,
        onToken: (t: string) => void,
        _systemPrompt: string,
        _onReasoning?: (t: string) => void,
        _options?: any
      ) => {
        call++;
        if (call === 1) {
          onToken('Reading.');
          // Note: NOT calling onToolCallStreaming. Exercises fallback.
          return {
            content: 'Reading.',
            tool_calls: [{
              id: 'c1', type: 'function',
              function: { name: 'read_file', arguments: '{"path":"x.ts"}' }
            }],
            finish_reason: 'tool_calls',
          };
        }
        onToken('Done.');
        return { content: 'Done.', finish_reason: 'stop' };
      });

      const startEvents: Array<{ tools: ToolDetail[] }> = [];
      orchestrator.onToolCallsStart(e => startEvents.push(e));

      await orchestrator.handleMessage('Read x.ts', 'session-1', async () => '', undefined);

      // Start still fired exactly once — fallback detail is enriched
      // (no streaming pre-announce, so the post-stream code computes it).
      expect(startEvents).toHaveLength(1);
      expect(startEvents[0].tools[0].detail).toBe('read: x.ts');
    });

    it('caps iterations at moby.maxToolCalls and bails the loop', async () => {
      configStore.set('maxToolCalls', 2);
      // Model keeps emitting tool calls — would loop forever without the cap.
      mockClient.streamChat.mockImplementation(async (
        _messages: any,
        onToken: (t: string) => void,
      ) => {
        onToken('thinking...');
        return {
          content: 'thinking...',
          tool_calls: [{
            id: `c-${Math.random().toString(36).slice(2, 8)}`,
            type: 'function' as const,
            function: { name: 'read_file', arguments: '{"path":"x.ts"}' }
          }],
          finish_reason: 'tool_calls',
        };
      });

      await orchestrator.handleMessage('Loop', 'session-1', async () => '', undefined);

      // Capped at 2 — no third call.
      expect(mockClient.streamChat).toHaveBeenCalledTimes(2);
    });

    it('appends assistant turn with reasoning_content and tool_calls before tool messages', async () => {
      // Inspect what gets passed to the SECOND streamChat call. The first
      // call's response should have been appended as an assistant turn
      // (with reasoning_content + tool_calls), followed by the tool result
      // message.
      let call = 0;
      let secondCallMessages: any[] | undefined;
      mockClient.streamChat.mockImplementation(async (
        messages: any[],
        onToken: (t: string) => void,
      ) => {
        call++;
        if (call === 1) {
          onToken('Will check.');
          return {
            content: 'Will check.',
            reasoning_content: 'reasoning text',
            tool_calls: [{
              id: 'c1', type: 'function' as const,
              function: { name: 'read_file', arguments: '{"path":"a.ts"}' }
            }],
            finish_reason: 'tool_calls',
          };
        }
        secondCallMessages = messages;
        onToken('Done.');
        return { content: 'Done.', finish_reason: 'stop' };
      });

      await orchestrator.handleMessage('Hi', 'session-1', async () => '', undefined);

      expect(secondCallMessages).toBeDefined();
      // Last two messages should be: assistant-with-tool-call, tool-result.
      const last = secondCallMessages!.at(-1);
      const secondLast = secondCallMessages!.at(-2);
      expect(secondLast.role).toBe('assistant');
      expect(secondLast.content).toBe('Will check.');
      expect(secondLast.reasoning_content).toBe('reasoning text');
      expect(secondLast.tool_calls).toEqual([{
        id: 'c1', type: 'function',
        function: { name: 'read_file', arguments: '{"path":"a.ts"}' }
      }]);
      expect(last.role).toBe('tool');
      expect(last.tool_call_id).toBe('c1');
    });

    it('does NOT amend the system prompt with "exploration phase complete" (Phase 4.5 drop)', async () => {
      let capturedSystemPrompt: string | undefined;
      mockClient.streamChat.mockImplementation(async (
        _messages: any,
        onToken: (t: string) => void,
        systemPrompt?: string,
      ) => {
        capturedSystemPrompt = systemPrompt;
        onToken('Done.');
        return { content: 'Done.', finish_reason: 'stop' };
      });

      await orchestrator.handleMessage('Hi', 'session-1', async () => '', undefined);

      expect(capturedSystemPrompt).toBeDefined();
      // The legacy amendment must NOT be present.
      expect(capturedSystemPrompt).not.toMatch(/exploration phase is now complete/i);
    });

    it('does NOT call the legacy non-streaming chat() probe', async () => {
      mockClient.streamChat.mockImplementationOnce(async (
        _messages: any,
        onToken: (t: string) => void,
      ) => {
        onToken('Hi.');
        return { content: 'Hi.', finish_reason: 'stop' };
      });

      await orchestrator.handleMessage('Hi', 'session-1', async () => '', undefined);

      // The whole point of Phase 4.5: no duplicate generation, no legacy probe.
      expect(mockClient.chat).not.toHaveBeenCalled();
    });

    it('honors abort signal between iterations', async () => {
      let call = 0;
      mockClient.streamChat.mockImplementation(async (
        _messages: any,
        onToken: (t: string) => void,
      ) => {
        call++;
        if (call === 1) {
          onToken('Reading.');
          // Abort before the next iteration starts.
          orchestrator.stopGeneration();
          return {
            content: 'Reading.',
            tool_calls: [{
              id: 'c1', type: 'function' as const,
              function: { name: 'read_file', arguments: '{"path":"x.ts"}' }
            }],
            finish_reason: 'tool_calls',
          };
        }
        // Should never reach here — abort kicks in first.
        onToken('SHOULD_NOT_REACH');
        return { content: 'SHOULD_NOT_REACH', finish_reason: 'stop' };
      });

      await orchestrator.handleMessage('Hi', 'session-1', async () => '', undefined);

      // The post-dispatch iteration should have bailed on signal.aborted.
      // Only the first streamChat call (and its single tool dispatch) ran.
      const calls = mockClient.streamChat.mock.calls.length;
      expect(calls).toBe(1);
    });

    // Regression: a two-tool iteration where the FIRST tool closes the batch.
    //
    // In ask mode, an edit_file dispatch blocks on diff approval and returns
    // `closesBatch: true`. runStreamingToolCallsLoop reacts by firing
    // onToolCallsEnd and doing `batchToolDetails = []` mid-iteration. The
    // SECOND tool in that same iteration (here delete_file) then reaches the
    // running-status update and indexes into the now-empty batch array. Before
    // the fix, `batchToolDetails[batchIndex].status = 'running'` was UNGUARDED,
    // so it threw `TypeError: Cannot set properties of undefined (setting
    // 'status')`. That TypeError is not an AbortError, so handleMessage's catch
    // error-finalized the whole turn (fired onError, saved an *[API error]*
    // record) instead of completing normally.
    //
    // The fix wraps the running-status update in
    // `if (batchIndex < batchToolDetails.length)` — matching the guard the
    // final-status block already had. allToolDetails is never reset and stays
    // safe to index.
    //
    // This test drives that exact iteration and asserts the turn finalizes
    // cleanly: no throw, no onError, onEndResponse fires, and the history
    // record is `status: 'complete'`. With the guard removed it fails because
    // onError fires with "Cannot set properties of undefined" and the
    // end/complete assertions never hold.
    it('does not crash when the first tool in an iteration closes the batch and a second tool follows (ask-mode edit_file + delete_file)', async () => {
      // Ask mode is what makes edit_file dispatch block on approval and set
      // closesBatch=true (see dispatchToolCall ~line 2622).
      mockDiffManager.currentEditMode = 'ask';
      // The blocking approval resolves "approved" so the edit dispatch returns
      // a normal (non-Error) result and proceeds to set closesBatch.
      mockDiffManager.waitForPendingApprovals.mockResolvedValue([
        { approved: true, filePath: 'src/index.ts' },
      ]);

      let call = 0;
      mockClient.streamChat.mockImplementation(async (
        _messages: any,
        onToken: (t: string) => void,
      ) => {
        call++;
        if (call === 1) {
          onToken('Editing then deleting.');
          // ONE iteration, TWO tools. edit_file (ask mode → closesBatch) comes
          // first; delete_file follows in the SAME batch and must survive the
          // mid-iteration `batchToolDetails = []` reset.
          return {
            content: 'Editing then deleting.',
            tool_calls: [
              {
                id: 'call_edit',
                type: 'function' as const,
                function: {
                  name: 'edit_file',
                  arguments: JSON.stringify({
                    file: 'src/index.ts',
                    edits: [{ search: 'old code', replace: 'new code' }],
                    language: 'typescript',
                  }),
                },
              },
              {
                id: 'call_delete',
                type: 'function' as const,
                function: {
                  name: 'delete_file',
                  arguments: JSON.stringify({ path: 'src/obsolete.ts' }),
                },
              },
            ],
            finish_reason: 'tool_calls',
          };
        }
        // Second iteration: model produces its final answer, loop ends cleanly.
        onToken('All done.');
        return { content: 'All done.', finish_reason: 'stop' };
      });

      const errors: Array<{ error: string }> = [];
      const endEvents: EndResponseEvent[] = [];
      orchestrator.onError(e => errors.push(e));
      orchestrator.onEndResponse(e => endEvents.push(e));

      // The crash happened inside the loop and propagated out of handleMessage's
      // try as a TypeError; assert it never throws and never error-finalizes.
      await expect(
        orchestrator.handleMessage('Edit then delete', 'session-1', async () => '', undefined)
      ).resolves.toBeDefined();

      // No TypeError reached the error path. (With the guard removed, onError
      // fires with "Cannot set properties of undefined".)
      expect(errors).toHaveLength(0);
      const crashError = errors.find(e =>
        /Cannot set properties of undefined/i.test(e.error)
      );
      expect(crashError).toBeUndefined();

      // The turn finalized normally with the second iteration's content.
      expect(endEvents).toHaveLength(1);
      expect(endEvents[0].content).toContain('All done.');

      // The edit's ask-mode approval was actually exercised (this is what
      // produces closesBatch=true and the mid-iteration batch reset).
      expect(mockDiffManager.handleAskModeDiff).toHaveBeenCalled();
      expect(mockDiffManager.waitForPendingApprovals).toHaveBeenCalled();

      // Both tool calls ran (a second streamChat iteration only happens if the
      // first iteration completed without throwing past the delete_file tool).
      expect(mockClient.streamChat).toHaveBeenCalledTimes(2);

      // History saved as a clean completion, not an interrupted/error record.
      const finalCall = mockConversation.recordAssistantMessage.mock.calls.at(-1);
      expect(finalCall?.[7]).toMatchObject({ status: 'complete' });
    });
  });
});
