import { describe, it, expect, vi, beforeEach } from 'vitest';

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

    orchestrator = new RequestOrchestrator(
      mockClient as any,
      mockConversation as any,
      mockStatusBar as any,
      mockDiffManager as any,
      mockWebSearch as any,
      mockFileContext as any,
    );
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
      expect(systemPromptArg).toContain('ASK');
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
      configStore.set('systemPrompt', 'You are a helpful bot.');

      await orchestrator.handleMessage('Hello', null, async () => '', undefined);

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
      const callArgs = mockConversation.recordAssistantMessage.mock.calls[0];
      expect(callArgs[0]).toBe('session-1');
      expect(callArgs[1]).toContain('Hello world');
      expect(callArgs[2]).toBe('deepseek-chat');
      expect(callArgs[3]).toBe('stop');
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

      // Should record partial message with [Generation stopped]
      expect(mockConversation.recordAssistantMessage).toHaveBeenCalledWith(
        'session-1',
        expect.stringContaining('[Generation stopped]'),
        'deepseek-chat',
        'length'
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
    it('should fire onGenerationStopped', () => {
      const events: void[] = [];
      orchestrator.onGenerationStopped(() => events.push(undefined));

      orchestrator.stopGeneration();

      expect(events).toHaveLength(1);
    });

    it('should fire onGenerationStopped even without active request', () => {
      const events: void[] = [];
      orchestrator.onGenerationStopped(() => events.push(undefined));

      orchestrator.stopGeneration();

      expect(events).toHaveLength(1);
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

    it('should call showDiff for apply_code_edit in manual mode', async () => {
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
                name: 'apply_code_edit',
                arguments: JSON.stringify({
                  file: 'src/index.ts',
                  code: 'console.log("hello")',
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
        '# File: src/index.ts\nconsole.log("hello")',
        'typescript'
      );
      expect(mockDiffManager.applyCodeDirectlyForAutoMode).not.toHaveBeenCalled();
      expect(mockDiffManager.handleAskModeDiff).not.toHaveBeenCalled();
    });

    it('should call applyCodeDirectlyForAutoMode for apply_code_edit in auto mode', async () => {
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
                name: 'apply_code_edit',
                arguments: JSON.stringify({
                  file: 'src/index.ts',
                  code: 'console.log("hello")',
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
        'console.log("hello")',
        undefined,
        true
      );
      expect(mockDiffManager.showDiff).not.toHaveBeenCalled();
    });

    it('should call handleAskModeDiff for apply_code_edit in ask mode', async () => {
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
                name: 'apply_code_edit',
                arguments: JSON.stringify({
                  file: 'src/index.ts',
                  code: 'console.log("hello")',
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
        '# File: src/index.ts\nconsole.log("hello")',
        'typescript'
      );
      expect(mockDiffManager.showDiff).not.toHaveBeenCalled();
      expect(mockDiffManager.applyCodeDirectlyForAutoMode).not.toHaveBeenCalled();
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
      };
    }

    it('should accept optional CommandApprovalManager in constructor', () => {
      const mockApproval = createMockCommandApprovalManager();
      const orch = new RequestOrchestrator(
        mockClient as any,
        mockConversation as any,
        mockStatusBar as any,
        mockDiffManager as any,
        mockWebSearch as any,
        mockFileContext as any,
        mockApproval as any,
      );
      expect(orch).toBeDefined();
    });

    it('should work without CommandApprovalManager (backward compatible)', () => {
      const orch = new RequestOrchestrator(
        mockClient as any,
        mockConversation as any,
        mockStatusBar as any,
        mockDiffManager as any,
        mockWebSearch as any,
        mockFileContext as any,
      );
      expect(orch).toBeDefined();
    });

    it('should call checkCommand for each shell command when manager is present', async () => {
      const mockApproval = createMockCommandApprovalManager();
      mockApproval.checkCommand.mockReturnValue('allowed');

      const orch = new RequestOrchestrator(
        mockClient as any,
        mockConversation as any,
        mockStatusBar as any,
        mockDiffManager as any,
        mockWebSearch as any,
        mockFileContext as any,
        mockApproval as any,
      );

      // Setup reasoner model that returns shell commands
      mockClient.isReasonerModel.mockReturnValue(true);
      mockClient.streamChat.mockImplementation(async (
        _messages: any,
        onToken: (token: string) => void,
        _systemPrompt: string,
        _onReasoning?: (token: string) => void,
      ) => {
        const content = 'Let me check the files.\n<shell>ls -la</shell>\n<shell>pwd</shell>';
        onToken(content);
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

    it('should skip blocked commands and include blocked feedback in results', async () => {
      const mockApproval = createMockCommandApprovalManager();
      // Block "rm" commands, allow "ls"
      mockApproval.checkCommand.mockImplementation((cmd: string) => {
        if (cmd.startsWith('ls')) return 'allowed';
        if (cmd.startsWith('rm')) return 'blocked';
        return 'ask';
      });

      const orch = new RequestOrchestrator(
        mockClient as any,
        mockConversation as any,
        mockStatusBar as any,
        mockDiffManager as any,
        mockWebSearch as any,
        mockFileContext as any,
        mockApproval as any,
      );

      mockClient.isReasonerModel.mockReturnValue(true);
      mockClient.streamChat.mockImplementation(async (
        _messages: any,
        onToken: (token: string) => void,
      ) => {
        const content = '<shell>ls</shell>\n<shell>rm -rf /tmp/test</shell>';
        onToken(content);
        return content;
      });

      configStore.set('allowAllShellCommands', false);

      const shellResults: ShellResultsEvent[] = [];
      orch.onShellResults(e => shellResults.push(e));

      await orch.handleMessage('Clean up', 'session-1', async () => '', undefined);

      // Should have results for both commands
      expect(shellResults.length).toBeGreaterThan(0);
      const allResults = shellResults[0].results;

      // The blocked command should show up with a blocked message
      const blockedResult = allResults.find(r => r.command === 'rm -rf /tmp/test');
      expect(blockedResult).toBeDefined();
      expect(blockedResult!.success).toBe(false);
      expect(blockedResult!.output).toContain('blocked');
    });

    it('should block "ask" commands and await requestApproval', async () => {
      const mockApproval = createMockCommandApprovalManager();
      mockApproval.checkCommand.mockReturnValue('ask');
      // Simulate user blocking the command
      mockApproval.requestApproval.mockResolvedValue({
        command: 'curl https://example.com',
        decision: 'blocked',
        persistent: false,
      });

      const orch = new RequestOrchestrator(
        mockClient as any,
        mockConversation as any,
        mockStatusBar as any,
        mockDiffManager as any,
        mockWebSearch as any,
        mockFileContext as any,
        mockApproval as any,
      );

      mockClient.isReasonerModel.mockReturnValue(true);
      mockClient.streamChat.mockImplementation(async (
        _messages: any,
        onToken: (token: string) => void,
      ) => {
        const content = '<shell>curl https://example.com</shell>';
        onToken(content);
        return content;
      });

      configStore.set('allowAllShellCommands', false);

      const shellResults: ShellResultsEvent[] = [];
      orch.onShellResults(e => shellResults.push(e));

      await orch.handleMessage('Fetch data', 'session-1', async () => '', undefined);

      // requestApproval should have been called
      expect(mockApproval.requestApproval).toHaveBeenCalledWith('curl https://example.com');

      // Blocked result should appear in shell results
      expect(shellResults.length).toBeGreaterThan(0);
      const result = shellResults[0].results.find(r => r.command.includes('curl'));
      expect(result).toBeDefined();
      expect(result!.success).toBe(false);
      expect(result!.output).toContain('blocked');
    });

    it('should bypass approval gate when allowAllShellCommands is true', async () => {
      const mockApproval = createMockCommandApprovalManager();

      const orch = new RequestOrchestrator(
        mockClient as any,
        mockConversation as any,
        mockStatusBar as any,
        mockDiffManager as any,
        mockWebSearch as any,
        mockFileContext as any,
        mockApproval as any,
      );

      mockClient.isReasonerModel.mockReturnValue(true);
      mockClient.streamChat.mockImplementation(async (
        _messages: any,
        onToken: (token: string) => void,
      ) => {
        const content = '<shell>some-unknown-command</shell>';
        onToken(content);
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
});
