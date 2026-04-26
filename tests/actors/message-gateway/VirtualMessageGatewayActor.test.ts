/**
 * Unit tests for VirtualMessageGatewayActor
 *
 * Tests the message routing and coordination between VS Code extension
 * messages and the Virtual Rendering architecture (VirtualListActor).
 *
 * Since this actor coordinates many other actors, we use mocks
 * to isolate the gateway's behavior.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { VirtualMessageGatewayActor, VirtualActorRefs, VSCodeAPI } from '../../../media/actors/message-gateway/VirtualMessageGatewayActor';
import { EventStateManager } from '../../../media/state/EventStateManager';

// ============================================
// Mock Actor Factories
// ============================================

function createMockStreamingActor() {
  return {
    startStream: vi.fn(),
    endStream: vi.fn(),
    handleContentChunk: vi.fn(),
    handleThinkingChunk: vi.fn(),
    destroy: vi.fn()
  };
}

function createMockSessionActor() {
  return {
    model: 'deepseek-chat',
    handleSessionLoaded: vi.fn(),
    handleSessionCreated: vi.fn(),
    handleSessionError: vi.fn(),
    handleModelChanged: vi.fn(),
    handleLoadHistory: vi.fn(),
    destroy: vi.fn()
  };
}

function createMockEditModeActor() {
  return {
    setMode: vi.fn(),
    isValidMode: vi.fn((mode: unknown) => ['manual', 'ask', 'auto'].includes(mode as string)),
    destroy: vi.fn()
  };
}

function createMockVirtualListActor() {
  const turns = new Map<string, {
    role: string;
    textSegments: Array<{ content: string }>;
    thinkingIterations: Array<{ content: string; complete: boolean }>;
    pendingFiles: Array<{ id: string; diffId?: string; status: string }>;
  }>();

  return {
    addTurn: vi.fn((turnId: string, role: string) => {
      turns.set(turnId, {
        role,
        textSegments: [],
        thinkingIterations: [],
        pendingFiles: []
      });
    }),
    getTurn: vi.fn((turnId: string) => turns.get(turnId)),
    startStreamingTurn: vi.fn(),
    endStreamingTurn: vi.fn(),
    addTextSegment: vi.fn((turnId: string, content: string) => {
      const turn = turns.get(turnId);
      if (turn) turn.textSegments.push({ content });
    }),
    updateTextContent: vi.fn(),
    completeCurrentTextSegment: vi.fn(),
    pushTurnActivity: vi.fn(),
    popTurnActivity: vi.fn(),
    setTurnTextActive: vi.fn(),
    clearTurnActivity: vi.fn(),
    startThinkingIteration: vi.fn((turnId: string) => {
      const turn = turns.get(turnId);
      if (turn) turn.thinkingIterations.push({ content: '', complete: false });
    }),
    updateThinkingContent: vi.fn(),
    completeThinkingIteration: vi.fn(),
    createShellSegment: vi.fn(() => 'shell-segment-1'),
    startShellSegment: vi.fn(),
    setShellResults: vi.fn(),
    startToolBatch: vi.fn(),
    updateTool: vi.fn(),
    updateToolBatch: vi.fn(),
    completeToolBatch: vi.fn(),
    addPendingFile: vi.fn((turnId: string, file: { filePath: string; diffId?: string }) => {
      const turn = turns.get(turnId);
      if (turn) turn.pendingFiles.push({ id: `file-${turn.pendingFiles.length}`, diffId: file.diffId, status: 'pending' });
    }),
    updatePendingStatus: vi.fn(),
    updatePendingFileStatusByPath: vi.fn(),
    markCodeBlockApplied: vi.fn(),
    addDrawingSegment: vi.fn(),
    setEditMode: vi.fn(),
    clear: vi.fn(() => turns.clear()),
    destroy: vi.fn()
  };
}

function createMockInputAreaActor() {
  return { destroy: vi.fn() };
}

function createMockToolbarActor() {
  return {
    setEditMode: vi.fn(),
    setWebSearchEnabled: vi.fn(),
    setWebSearchMode: vi.fn(),
    destroy: vi.fn()
  };
}

function createMockHistoryActor() {
  return { destroy: vi.fn() };
}

function createMockVSCodeAPI(): VSCodeAPI {
  return {
    postMessage: vi.fn(),
    getState: vi.fn(() => ({})),
    setState: vi.fn()
  };
}

// ============================================
// Tests
// ============================================

describe('VirtualMessageGatewayActor', () => {
  let manager: EventStateManager;
  let element: HTMLElement;
  let gateway: VirtualMessageGatewayActor;
  let mockVSCode: VSCodeAPI;
  let mockActors: VirtualActorRefs;

  beforeEach(() => {
    manager = new EventStateManager({ batchBroadcasts: false });
    element = document.createElement('div');
    element.id = 'gateway-root';
    document.body.appendChild(element);

    mockVSCode = createMockVSCodeAPI();
    mockActors = {
      streaming: createMockStreamingActor() as unknown as VirtualActorRefs['streaming'],
      session: createMockSessionActor() as unknown as VirtualActorRefs['session'],
      editMode: createMockEditModeActor() as unknown as VirtualActorRefs['editMode'],
      virtualList: createMockVirtualListActor() as unknown as VirtualActorRefs['virtualList'],
      inputArea: createMockInputAreaActor() as unknown as VirtualActorRefs['inputArea'],
      toolbar: createMockToolbarActor() as unknown as VirtualActorRefs['toolbar'],
      history: createMockHistoryActor() as unknown as VirtualActorRefs['history']
    };

    gateway = new VirtualMessageGatewayActor(manager, element, mockVSCode, mockActors);
  });

  afterEach(() => {
    gateway.destroy();
    document.body.innerHTML = '';
  });

  // Helper to dispatch window message events
  function dispatchMessage(data: Record<string, unknown>) {
    const event = new MessageEvent('message', { data });
    window.dispatchEvent(event);
  }

  describe('initialization', () => {
    it('registers with the manager', async () => {
      await new Promise(resolve => queueMicrotask(resolve));
      expect(manager.hasActor('gateway-root-VirtualMessageGatewayActor')).toBe(true);
    });

    it('starts with idle phase', () => {
      expect(gateway.phase).toBe('idle');
    });

    it('starts with no current turn', () => {
      expect(gateway.currentTurnId).toBe(null);
    });
  });

  describe('streaming flow', () => {
    it('handles startResponse message', () => {
      dispatchMessage({ type: 'startResponse', messageId: 'msg-1' });

      expect(mockActors.virtualList.addTurn).toHaveBeenCalledWith(
        'turn-1',
        'assistant',
        expect.objectContaining({ model: 'deepseek-chat' })
      );
      expect(mockActors.virtualList.startStreamingTurn).toHaveBeenCalledWith('turn-1');
      expect(mockActors.streaming.startStream).toHaveBeenCalled();
      expect(gateway.phase).toBe('streaming');
      expect(gateway.currentTurnId).toBe('turn-1');
    });

    it('handles streamToken message', () => {
      dispatchMessage({ type: 'startResponse', messageId: 'msg-1' });
      dispatchMessage({ type: 'streamToken', token: 'Hello ' });
      dispatchMessage({ type: 'streamToken', token: 'world!' });

      // CQRS: text rendered via projector → addTextSegment (first token) + updateTextContent (subsequent)
      expect(mockActors.virtualList.addTextSegment).toHaveBeenCalled();
      expect(mockActors.streaming.handleContentChunk).toHaveBeenCalledWith('Hello ');
      expect(mockActors.streaming.handleContentChunk).toHaveBeenCalledWith('world!');
    });

    it('handles endResponse message', () => {
      dispatchMessage({ type: 'startResponse', messageId: 'msg-1' });
      dispatchMessage({ type: 'streamToken', token: 'Response' });
      dispatchMessage({ type: 'endResponse', message: { content: 'Response' } });

      expect(mockActors.streaming.endStream).toHaveBeenCalled();
      expect(mockActors.virtualList.endStreamingTurn).toHaveBeenCalled();
      expect(gateway.phase).toBe('idle');
      expect(gateway.currentTurnId).toBe(null);
    });
  });

  describe('thinking/reasoning flow', () => {
    it('defers thinking bubble until first reasoning token', () => {
      dispatchMessage({ type: 'startResponse', messageId: 'msg-1' });
      dispatchMessage({ type: 'iterationStart', iteration: 1 });

      // Thinking bubble should NOT appear on iterationStart alone
      expect(mockActors.virtualList.startThinkingIteration).not.toHaveBeenCalled();

      // First reasoning token triggers the thinking bubble
      dispatchMessage({ type: 'streamReasoning', token: 'Let me think...' });
      expect(mockActors.virtualList.startThinkingIteration).toHaveBeenCalledWith('turn-1');
    });

    it('handles streamReasoning message', () => {
      dispatchMessage({ type: 'startResponse', messageId: 'msg-1' });
      dispatchMessage({ type: 'iterationStart', iteration: 1 });
      dispatchMessage({ type: 'streamReasoning', token: 'Let me think...' });

      expect(mockActors.streaming.handleThinkingChunk).toHaveBeenCalledWith('Let me think...');
    });
  });

  describe('shell execution flow', () => {
    it('handles shellExecuting message', () => {
      dispatchMessage({ type: 'startResponse', messageId: 'msg-1' });
      dispatchMessage({
        type: 'shellExecuting',
        commands: [{ command: 'ls -la' }]
      });

      // CQRS: shell-start event → projector renders createShellSegment
      expect(mockActors.virtualList.createShellSegment).toHaveBeenCalledWith(
        'turn-1',
        [{ command: 'ls -la' }]
      );
      expect(gateway.phase).toBe('waiting-for-results');
    });

    it('handles shellResults message', () => {
      dispatchMessage({ type: 'startResponse', messageId: 'msg-1' });
      dispatchMessage({
        type: 'shellExecuting',
        commands: [{ command: 'ls' }]
      });
      dispatchMessage({
        type: 'shellResults',
        results: [{ output: 'file.txt', success: true }]
      });

      // CQRS: shell-complete event → projector updates shell segment with results
      expect(mockActors.virtualList.setShellResults).toHaveBeenCalled();
      expect(gateway.phase).toBe('streaming');
    });
  });

  describe('tool calls flow', () => {
    it('handles toolCallsStart message', () => {
      dispatchMessage({ type: 'startResponse', messageId: 'msg-1' });
      dispatchMessage({
        type: 'toolCallsStart',
        tools: [{ name: 'read_file', detail: 'src/index.ts' }]
      });

      // CQRS: tool-batch-start event → projector renders startToolBatch
      expect(mockActors.virtualList.startToolBatch).toHaveBeenCalledWith(
        'turn-1',
        [{ name: 'read_file', detail: 'src/index.ts' }]
      );
    });

    it('handles toolCallUpdate message', () => {
      dispatchMessage({ type: 'startResponse', messageId: 'msg-1' });
      dispatchMessage({
        type: 'toolCallsStart',
        tools: [{ name: 'read_file', detail: 'src/index.ts' }]
      });
      dispatchMessage({
        type: 'toolCallUpdate',
        index: 0,
        status: 'done'
      });

      // CQRS: tool-update event → projector updates batch segment → updateToolBatch
      expect(mockActors.virtualList.updateToolBatch).toHaveBeenCalledWith(
        'turn-1',
        expect.arrayContaining([
          expect.objectContaining({ name: 'read_file', status: 'done' })
        ])
      );
    });

    it('handles toolCallsEnd message', () => {
      dispatchMessage({ type: 'startResponse', messageId: 'msg-1' });
      dispatchMessage({
        type: 'toolCallsStart',
        tools: [{ name: 'read_file', detail: 'src/index.ts' }]
      });
      dispatchMessage({ type: 'toolCallsEnd' });

      expect(mockActors.virtualList.completeToolBatch).toHaveBeenCalledWith('turn-1');
    });
  });

  describe('pending files flow', () => {
    it('handles pendingFilesSetEditMode message', () => {
      dispatchMessage({
        type: 'pendingFilesSetEditMode',
        mode: 'auto'
      });

      expect(mockActors.virtualList.setEditMode).toHaveBeenCalledWith('auto');
    });
  });

  describe('session messages', () => {
    it('routes sessionLoaded to session actor', () => {
      dispatchMessage({
        type: 'sessionLoaded',
        sessionId: 'sess-1',
        title: 'Test Session',
        model: 'deepseek-reasoner'
      });

      expect(mockActors.session.handleSessionLoaded).toHaveBeenCalledWith({
        sessionId: 'sess-1',
        title: 'Test Session',
        model: 'deepseek-reasoner'
      });
    });

    it('routes sessionCreated to session actor', () => {
      dispatchMessage({
        type: 'sessionCreated',
        sessionId: 'new-sess',
        model: 'deepseek-chat'
      });

      expect(mockActors.session.handleSessionCreated).toHaveBeenCalledWith({
        sessionId: 'new-sess',
        model: 'deepseek-chat'
      });
    });

    it('routes sessionError to session actor', () => {
      dispatchMessage({
        type: 'sessionError',
        error: 'Something went wrong'
      });

      expect(mockActors.session.handleSessionError).toHaveBeenCalledWith({
        error: 'Something went wrong'
      });
    });
  });

  describe('history messages', () => {
    it('handles addMessage for user', () => {
      dispatchMessage({
        type: 'addMessage',
        message: { role: 'user', content: 'Hello AI' }
      });

      expect(mockActors.virtualList.addTurn).toHaveBeenCalledWith(
        'turn-1',
        'user',
        expect.any(Object)
      );
      expect(mockActors.virtualList.addTextSegment).toHaveBeenCalledWith('turn-1', 'Hello AI');
    });

    it('handles addMessage for assistant with reasoning', () => {
      dispatchMessage({
        type: 'addMessage',
        message: { role: 'assistant', content: 'Hello!', reasoning: 'Let me think...' }
      });

      expect(mockActors.virtualList.addTurn).toHaveBeenCalledWith(
        'turn-1',
        'assistant',
        expect.any(Object)
      );
      expect(mockActors.virtualList.startThinkingIteration).toHaveBeenCalledWith('turn-1');
      expect(mockActors.virtualList.updateThinkingContent).toHaveBeenCalledWith('turn-1', 'Let me think...');
    });

    it('handles loadHistory message', () => {
      dispatchMessage({
        type: 'loadHistory',
        history: [
          { role: 'user', content: 'Hi' },
          { role: 'assistant', content: 'Hello!' }
        ]
      });

      expect(mockActors.session.handleLoadHistory).toHaveBeenCalled();
      expect(mockActors.virtualList.clear).toHaveBeenCalled();
      expect(mockActors.virtualList.addTurn).toHaveBeenCalledTimes(2);
    });

    it('handles clearChat message', () => {
      dispatchMessage({ type: 'clearChat' });

      expect(mockActors.virtualList.clear).toHaveBeenCalled();
      expect(gateway.phase).toBe('idle');
      expect(gateway.currentTurnId).toBe(null);
    });
  });

  describe('status messages', () => {
    it('routes error to status panel via pub/sub', () => {
      const spy = vi.spyOn(manager, 'publishDirect');
      dispatchMessage({ type: 'error', error: 'API error' });

      expect(spy).toHaveBeenCalledWith('status.message', { type: 'error', message: 'API error' });
    });

    it('routes warning to status panel via pub/sub', () => {
      const spy = vi.spyOn(manager, 'publishDirect');
      dispatchMessage({ type: 'warning', message: 'Rate limited' });

      expect(spy).toHaveBeenCalledWith('status.message', { type: 'warning', message: 'Rate limited' });
    });

    it('routes statusMessage to status panel via pub/sub', () => {
      const spy = vi.spyOn(manager, 'publishDirect');
      dispatchMessage({ type: 'statusMessage', message: 'Processing...' });

      expect(spy).toHaveBeenCalledWith('status.message', { type: 'info', message: 'Processing...' });
    });
  });

  describe('settings messages', () => {
    it('handles editModeSettings message', () => {
      dispatchMessage({ type: 'editModeSettings', mode: 'auto' });

      expect(mockActors.editMode.setMode).toHaveBeenCalledWith('auto');
      expect(mockActors.toolbar.setEditMode).toHaveBeenCalledWith('auto');
      expect(mockActors.virtualList.setEditMode).toHaveBeenCalledWith('auto');
    });

    it('handles webSearchToggled message', () => {
      dispatchMessage({ type: 'webSearchToggled', enabled: true });

      expect(mockActors.toolbar.setWebSearchEnabled).toHaveBeenCalledWith(true);
    });

    it('handles webSearchModeChanged message', () => {
      dispatchMessage({ type: 'webSearchModeChanged', mode: 'manual' });

      expect(mockActors.toolbar.setWebSearchMode).toHaveBeenCalledWith('manual');
    });
  });

  describe('generationStopped', () => {
    it('ends the streaming UI state', () => {
      // Post-ADR-0003 contract: handleGenerationStopped only flips the
      // streaming UI back (stop → send button). The marker text and
      // turn finalization come through the regular endResponse flow
      // from the extension, so the gateway does NOT reset _phase or
      // _currentTurnId here. See VirtualMessageGatewayActor.handleGenerationStopped
      // for the rationale.
      dispatchMessage({ type: 'startResponse', messageId: 'msg-1' });
      dispatchMessage({ type: 'streamToken', token: 'Partial...' });
      dispatchMessage({ type: 'generationStopped' });

      expect(mockActors.streaming.endStream).toHaveBeenCalled();
    });
  });

  // ADR 0003 Phase 3: history restore is driven by the structural
  // `turnEvents` array authored extension-side. The webview projects
  // those events through TurnProjector.projectFull and renders the
  // resulting view segments. The legacy fragment fields
  // (`reasoning_iterations`, `shellResults`, `contentIterations`,
  // `toolCalls`, `filesModified`) are no longer read.
  describe('loadHistory restore', () => {
    it('restores a simple user + assistant conversation', () => {
      dispatchMessage({
        type: 'loadHistory',
        history: [
          { role: 'user', content: 'Hello', timestamp: 1000 },
          {
            role: 'assistant',
            content: 'Hi there!',
            model: 'deepseek-chat',
            timestamp: 2000,
            turnEvents: [
              { type: 'text-append', content: 'Hi there!', iteration: 0, ts: 2000 },
              { type: 'text-finalize', iteration: 0, ts: 2001 }
            ]
          }
        ]
      });

      expect(mockActors.session.handleLoadHistory).toHaveBeenCalled();
      expect(mockActors.virtualList.clear).toHaveBeenCalled();
      expect(mockActors.virtualList.addTurn).toHaveBeenCalledTimes(2);
      expect(mockActors.virtualList.addTextSegment).toHaveBeenCalledWith('turn-1', 'Hello');
      expect(mockActors.virtualList.addTextSegment).toHaveBeenCalledWith('turn-2', 'Hi there!');
    });

    it('restores Reasoner conversation with interleaved thinking + shell', () => {
      // Default mock session model is 'deepseek-chat'. The renderSegment text
      // branch only strips <shell> tags when model === 'deepseek-reasoner';
      // since we're not exercising that branch here, the chat-model default
      // is fine.
      dispatchMessage({
        type: 'loadHistory',
        history: [
          { role: 'user', content: 'Run a command', timestamp: 1000 },
          {
            role: 'assistant',
            content: 'Here are the results.',
            model: 'deepseek-reasoner',
            timestamp: 2000,
            turnEvents: [
              // Iteration 0: think → text → shell
              { type: 'thinking-start', iteration: 0, ts: 2000 },
              { type: 'thinking-content', content: 'Let me think...', iteration: 0, ts: 2001 },
              { type: 'thinking-complete', iteration: 0, ts: 2002 },
              { type: 'text-append', content: 'Let me check', iteration: 0, ts: 2003 },
              { type: 'shell-start', id: 'sh-1', commands: [{ command: 'ls -la' }], iteration: 0, ts: 2004 },
              { type: 'shell-complete', id: 'sh-1', results: [{ output: 'file1.txt', success: true }], ts: 2005 },
              { type: 'iteration-end', iteration: 0, ts: 2006 },
              // Iteration 1: think → text
              { type: 'thinking-start', iteration: 1, ts: 2007 },
              { type: 'thinking-content', content: 'Now I understand.', iteration: 1, ts: 2008 },
              { type: 'thinking-complete', iteration: 1, ts: 2009 },
              { type: 'text-append', content: 'Here are the results.', iteration: 1, ts: 2010 },
              { type: 'text-finalize', iteration: 1, ts: 2011 }
            ]
          }
        ]
      });

      // 2 thinking iterations
      expect(mockActors.virtualList.startThinkingIteration).toHaveBeenCalledTimes(2);
      expect(mockActors.virtualList.updateThinkingContent).toHaveBeenCalledWith('turn-2', 'Let me think...');
      expect(mockActors.virtualList.updateThinkingContent).toHaveBeenCalledWith('turn-2', 'Now I understand.');
      expect(mockActors.virtualList.completeThinkingIteration).toHaveBeenCalledTimes(2);

      // 1 shell segment
      expect(mockActors.virtualList.createShellSegment).toHaveBeenCalledWith(
        'turn-2',
        [{ command: 'ls -la' }]
      );
      expect(mockActors.virtualList.setShellResults).toHaveBeenCalledWith(
        'turn-2',
        'shell-segment-1',
        [{ output: 'file1.txt', success: true }]
      );

      // Content: iteration 0's text (inline before shell) + iteration 1's text (remaining after shell)
      expect(mockActors.virtualList.addTextSegment).toHaveBeenCalledWith('turn-2', 'Let me check');
      expect(mockActors.virtualList.addTextSegment).toHaveBeenCalledWith('turn-2', 'Here are the results.');
    });

    it('restores Chat conversation with tools before text', () => {
      dispatchMessage({
        type: 'loadHistory',
        history: [
          { role: 'user', content: 'Fix the bug', timestamp: 1000 },
          {
            role: 'assistant',
            content: 'Fixed it.',
            model: 'deepseek-chat',
            timestamp: 2000,
            turnEvents: [
              { type: 'tool-batch-start', tools: [
                { name: 'read_file', detail: 'src/app.ts' },
                { name: 'edit_file', detail: 'fixing bug' }
              ], ts: 2000 },
              { type: 'tool-update', index: 0, status: 'done', ts: 2001 },
              { type: 'tool-update', index: 1, status: 'done', ts: 2002 },
              { type: 'tool-batch-complete', ts: 2003 },
              { type: 'file-modified', path: 'src/app.ts', status: 'applied', ts: 2004 },
              { type: 'text-append', content: 'Fixed it.', iteration: 0, ts: 2005 },
              { type: 'text-finalize', iteration: 0, ts: 2006 }
            ]
          }
        ]
      });

      // Tools rendered
      expect(mockActors.virtualList.startToolBatch).toHaveBeenCalledWith('turn-2', [
        { name: 'read_file', detail: 'src/app.ts' },
        { name: 'edit_file', detail: 'fixing bug' }
      ]);
      expect(mockActors.virtualList.updateTool).toHaveBeenCalledWith('turn-2', 0, 'done');
      expect(mockActors.virtualList.updateTool).toHaveBeenCalledWith('turn-2', 1, 'done');
      expect(mockActors.virtualList.completeToolBatch).toHaveBeenCalledWith('turn-2');

      // File modifications rendered
      expect(mockActors.virtualList.addPendingFile).toHaveBeenCalledWith('turn-2', {
        filePath: 'src/app.ts',
        status: 'applied',
        editMode: undefined
      });

      // Text content rendered
      expect(mockActors.virtualList.addTextSegment).toHaveBeenCalledWith('turn-2', 'Fixed it.');

      // Order verification: tools first, then files, then text
      const toolCall = mockActors.virtualList.startToolBatch.mock.invocationCallOrder[0];
      const fileCall = mockActors.virtualList.addPendingFile.mock.invocationCallOrder[0];
      const textCall = (mockActors.virtualList.addTextSegment as ReturnType<typeof vi.fn>).mock.invocationCallOrder[1]; // [1] = assistant text (user is [0])
      expect(toolCall).toBeLessThan(fileCall);
      expect(fileCall).toBeLessThan(textCall);
    });

    it('restores Reasoner with files after shells', () => {
      // Iteration 0: thinking → text → shell
      // Iteration 1: thinking → text → file-modified
      dispatchMessage({
        type: 'loadHistory',
        history: [
          { role: 'user', content: 'Edit file', timestamp: 1000 },
          {
            role: 'assistant',
            content: 'Added animals.',
            model: 'deepseek-reasoner',
            timestamp: 2000,
            turnEvents: [
              { type: 'thinking-start', iteration: 0, ts: 2000 },
              { type: 'thinking-content', content: 'Checking file...', iteration: 0, ts: 2001 },
              { type: 'thinking-complete', iteration: 0, ts: 2002 },
              { type: 'text-append', content: 'Let me check first', iteration: 0, ts: 2003 },
              { type: 'shell-start', id: 'sh-1', commands: [{ command: 'cat test.txt' }], iteration: 0, ts: 2004 },
              { type: 'shell-complete', id: 'sh-1', results: [{ output: 'contents', success: true }], ts: 2005 },
              { type: 'iteration-end', iteration: 0, ts: 2006 },
              { type: 'thinking-start', iteration: 1, ts: 2007 },
              { type: 'thinking-content', content: 'Now editing...', iteration: 1, ts: 2008 },
              { type: 'thinking-complete', iteration: 1, ts: 2009 },
              { type: 'text-append', content: 'Added animals.', iteration: 1, ts: 2010 },
              { type: 'file-modified', path: 'test.txt', status: 'applied', ts: 2011 },
              { type: 'text-finalize', iteration: 1, ts: 2012 }
            ]
          }
        ]
      });

      // Files rendered
      expect(mockActors.virtualList.addPendingFile).toHaveBeenCalledWith('turn-2', {
        filePath: 'test.txt',
        status: 'applied',
        editMode: undefined
      });

      // Order: shell before files
      const shellCall = mockActors.virtualList.createShellSegment.mock.invocationCallOrder[0];
      const fileCall = mockActors.virtualList.addPendingFile.mock.invocationCallOrder[0];
      expect(shellCall).toBeLessThan(fileCall);
    });

    it('renders nothing for assistant turns missing turnEvents (no legacy fallback)', () => {
      // The previous fragment-reconstruction fallback was deleted in ADR 0003
      // Phase 3. An assistant row without `turnEvents` produces an empty
      // turn shell — no text, no thinking, no shell, no tools.
      dispatchMessage({
        type: 'loadHistory',
        history: [
          { role: 'user', content: 'Hello', timestamp: 1000 },
          {
            role: 'assistant',
            content: 'Full accumulated text',  // legacy field — must NOT be read
            model: 'deepseek-reasoner',
            timestamp: 2000
          }
        ]
      });

      // The user turn IS rendered (turn-1) — that's the addTextSegment we expect.
      // The assistant turn (turn-2) has no events to project, so no
      // assistant-side addTextSegment call is made.
      expect(mockActors.virtualList.addTextSegment).toHaveBeenCalledTimes(1);
      expect(mockActors.virtualList.addTextSegment).toHaveBeenCalledWith('turn-1', 'Hello');
      expect(mockActors.virtualList.addTextSegment).not.toHaveBeenCalledWith(
        'turn-2',
        expect.stringContaining('Full accumulated text')
      );
    });

    it('handles empty history gracefully', () => {
      dispatchMessage({
        type: 'loadHistory',
        history: []
      });

      expect(mockActors.session.handleLoadHistory).toHaveBeenCalled();
      expect(mockActors.virtualList.clear).toHaveBeenCalled();
      expect(mockActors.virtualList.addTurn).not.toHaveBeenCalled();
    });
  });

  describe('CQRS text segment handling', () => {
    it('creates new text segment after interleaving events', () => {
      dispatchMessage({ type: 'startResponse', messageId: 'msg-1' });
      dispatchMessage({ type: 'streamToken', token: 'Hello' });

      // Shell interleave creates a new text segment via projector
      dispatchMessage({
        type: 'shellExecuting',
        commands: [{ command: 'ls' }]
      });
      dispatchMessage({
        type: 'shellResults',
        results: [{ output: 'ok', success: true }]
      });

      // Next token starts a new text segment (continuation)
      dispatchMessage({ type: 'streamToken', token: ' world' });

      // Verify text was rendered (projector handles segment creation)
      expect(mockActors.virtualList.addTextSegment).toHaveBeenCalled();
      expect(mockActors.streaming.handleContentChunk).toHaveBeenCalledWith(' world');
    });
  });

  // ============================================
  // Drawing Message Tests
  // ============================================

  describe('drawing messages', () => {
    it('handles drawingReceived by creating a user turn with drawing segment', () => {
      dispatchMessage({
        type: 'drawingReceived',
        imageDataUrl: 'data:image/png;base64,abc123',
        timestamp: 1700000000000
      });

      expect(mockActors.virtualList.addTurn).toHaveBeenCalledWith(
        expect.stringContaining('turn-drawing-'),
        'user',
        expect.objectContaining({ timestamp: 1700000000000 })
      );
      expect((mockActors.virtualList as any).addDrawingSegment).toHaveBeenCalledWith(
        expect.stringContaining('turn-drawing-'),
        'data:image/png;base64,abc123',
        1700000000000
      );
    });

    it('ignores drawingReceived with no imageDataUrl', () => {
      dispatchMessage({
        type: 'drawingReceived',
        timestamp: 1700000000000
      });

      expect((mockActors.virtualList as any).addDrawingSegment).not.toHaveBeenCalled();
    });

    it('handles asciiDrawingReceived by creating user turn and sending message', () => {
      dispatchMessage({
        type: 'asciiDrawingReceived',
        text: '┌──┐\n│Hi│\n└──┘',
        timestamp: 1700000000000
      });

      // Should create a visible user turn with the ASCII art
      expect(mockActors.virtualList.addTurn).toHaveBeenCalledWith(
        expect.stringContaining('turn-ascii-'),
        'user',
        expect.objectContaining({ timestamp: expect.any(Number) })
      );
      expect(mockActors.virtualList.addTextSegment).toHaveBeenCalledWith(
        expect.stringContaining('turn-ascii-'),
        '```\n┌──┐\n│Hi│\n└──┘\n```'
      );

      // Should also send to extension for LLM processing
      expect(mockVSCode.postMessage).toHaveBeenCalledWith({
        type: 'sendMessage',
        message: '```\n┌──┐\n│Hi│\n└──┘\n```'
      });
    });

    it('ignores asciiDrawingReceived with no text', () => {
      dispatchMessage({
        type: 'asciiDrawingReceived',
        timestamp: 1700000000000
      });

      expect(mockVSCode.postMessage).not.toHaveBeenCalled();
      expect(mockActors.virtualList.addTurn).not.toHaveBeenCalledWith(
        expect.stringContaining('turn-ascii-'),
        expect.anything(),
        expect.anything()
      );
    });

    it('publishes drawingServerState to manager', () => {
      const publishSpy = vi.spyOn(manager, 'publishDirect');

      dispatchMessage({
        type: 'drawingServerState',
        running: true,
        url: 'http://192.168.0.135:8839',
        qrMatrix: [[true, false], [false, true]],
        isWSL: true
      });

      expect(publishSpy).toHaveBeenCalledWith(
        'drawingServer.state',
        expect.objectContaining({
          running: true,
          url: 'http://192.168.0.135:8839',
          isWSL: true
        })
      );
    });
  });

  describe('lifecycle', () => {
    it('removes message listener on destroy', () => {
      const removeEventListenerSpy = vi.spyOn(window, 'removeEventListener');

      gateway.destroy();

      expect(removeEventListenerSpy).toHaveBeenCalledWith('message', expect.any(Function));
    });
  });
});
