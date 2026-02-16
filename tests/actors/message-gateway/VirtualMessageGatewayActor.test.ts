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
    getBoundActor: vi.fn(() => ({ needsNewSegment: () => false })),
    startStreamingTurn: vi.fn(),
    endStreamingTurn: vi.fn(),
    addTextSegment: vi.fn((turnId: string, content: string) => {
      const turn = turns.get(turnId);
      if (turn) turn.textSegments.push({ content });
    }),
    updateTextContent: vi.fn(),
    finalizeCurrentSegment: vi.fn(() => true),
    resumeWithNewSegment: vi.fn(),
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
    setEditMode: vi.fn(),
    clear: vi.fn(() => turns.clear()),
    destroy: vi.fn()
  };
}

function createMockInputAreaActor() {
  return { destroy: vi.fn() };
}

function createMockStatusPanelActor() {
  return {
    showError: vi.fn(),
    showWarning: vi.fn(),
    showMessage: vi.fn(),
    destroy: vi.fn()
  };
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
    manager = new EventStateManager();
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
      statusPanel: createMockStatusPanelActor() as unknown as VirtualActorRefs['statusPanel'],
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

      expect(mockActors.virtualList.addTextSegment).toHaveBeenCalled();
      expect(mockActors.streaming.handleContentChunk).toHaveBeenCalledWith('Hello ');
      expect(mockActors.streaming.handleContentChunk).toHaveBeenCalledWith('world!');
      expect(gateway.segmentContent).toBe('Hello world!');
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
    it('handles iterationStart message', () => {
      dispatchMessage({ type: 'startResponse', messageId: 'msg-1' });
      dispatchMessage({ type: 'iterationStart', iteration: 1 });

      expect(mockActors.virtualList.finalizeCurrentSegment).toHaveBeenCalled();
      expect(mockActors.virtualList.startThinkingIteration).toHaveBeenCalledWith('turn-1');
      expect(gateway.hasInterleaved).toBe(true);
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

      expect(mockActors.virtualList.finalizeCurrentSegment).toHaveBeenCalled();
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

      expect(mockActors.virtualList.setShellResults).toHaveBeenCalledWith(
        'turn-1',
        'shell-segment-1',
        [{ output: 'file.txt', success: true }]
      );
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

      expect(mockActors.virtualList.finalizeCurrentSegment).toHaveBeenCalled();
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

      expect(mockActors.virtualList.updateTool).toHaveBeenCalledWith('turn-1', 0, 'done');
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
    it('handles pendingFileAdd message', () => {
      dispatchMessage({ type: 'startResponse', messageId: 'msg-1' });
      dispatchMessage({
        type: 'pendingFileAdd',
        filePath: '/src/test.ts',
        diffId: 'diff-1'
      });

      expect(mockActors.virtualList.addPendingFile).toHaveBeenCalledWith(
        'turn-1',
        { filePath: '/src/test.ts', diffId: 'diff-1' }
      );
    });

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
    it('routes error to status panel', () => {
      dispatchMessage({ type: 'error', error: 'API error' });

      expect(mockActors.statusPanel.showError).toHaveBeenCalledWith('API error');
    });

    it('routes warning to status panel', () => {
      dispatchMessage({ type: 'warning', message: 'Rate limited' });

      expect(mockActors.statusPanel.showWarning).toHaveBeenCalledWith('Rate limited');
    });

    it('routes statusMessage to status panel', () => {
      dispatchMessage({ type: 'statusMessage', message: 'Processing...' });

      expect(mockActors.statusPanel.showMessage).toHaveBeenCalledWith('Processing...');
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
    it('cleans up streaming state', () => {
      dispatchMessage({ type: 'startResponse', messageId: 'msg-1' });
      dispatchMessage({ type: 'streamToken', token: 'Partial...' });
      dispatchMessage({ type: 'generationStopped' });

      expect(mockActors.streaming.endStream).toHaveBeenCalled();
      expect(mockActors.virtualList.endStreamingTurn).toHaveBeenCalled();
      expect(gateway.phase).toBe('idle');
      expect(gateway.currentTurnId).toBe(null);
    });
  });

  describe('loadHistory restore', () => {
    it('restores a simple user + assistant conversation', () => {
      dispatchMessage({
        type: 'loadHistory',
        history: [
          { role: 'user', content: 'Hello', timestamp: 1000 },
          { role: 'assistant', content: 'Hi there!', model: 'deepseek-chat', timestamp: 2000 }
        ]
      });

      expect(mockActors.session.handleLoadHistory).toHaveBeenCalled();
      expect(mockActors.virtualList.clear).toHaveBeenCalled();
      expect(mockActors.virtualList.addTurn).toHaveBeenCalledTimes(2);
      expect(mockActors.virtualList.addTextSegment).toHaveBeenCalledWith('turn-1', 'Hello');
      expect(mockActors.virtualList.addTextSegment).toHaveBeenCalledWith('turn-2', 'Hi there!');
    });

    it('restores Reasoner conversation with interleaved thinking + shell', () => {
      dispatchMessage({
        type: 'loadHistory',
        history: [
          { role: 'user', content: 'Run a command', timestamp: 1000 },
          {
            role: 'assistant',
            content: 'Here are the results.',
            model: 'deepseek-reasoner',
            reasoning_iterations: ['Let me think...', 'Now I understand.'],
            shellResults: [{ command: 'ls -la', output: 'file1.txt', success: true }],
            contentIterations: ['Let me check', 'Here are the results.'],
            timestamp: 2000
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
            toolCalls: [
              { name: 'read_file', detail: 'src/app.ts', status: 'done' },
              { name: 'apply_code_edit', detail: 'fixing bug', status: 'done' }
            ],
            filesModified: ['src/app.ts'],
            timestamp: 2000
          }
        ]
      });

      // Tools rendered
      expect(mockActors.virtualList.startToolBatch).toHaveBeenCalledWith('turn-2', [
        { name: 'read_file', detail: 'src/app.ts' },
        { name: 'apply_code_edit', detail: 'fixing bug' }
      ]);
      expect(mockActors.virtualList.updateTool).toHaveBeenCalledWith('turn-2', 0, 'done');
      expect(mockActors.virtualList.updateTool).toHaveBeenCalledWith('turn-2', 1, 'done');
      expect(mockActors.virtualList.completeToolBatch).toHaveBeenCalledWith('turn-2');

      // File modifications rendered
      expect(mockActors.virtualList.addPendingFile).toHaveBeenCalledWith('turn-2', {
        filePath: 'src/app.ts',
        status: 'applied'
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

    it('restores Reasoner with files after shells but before final text', () => {
      // 2 reasoning iterations, 1 shell (after first), 2 content iterations
      // Order: thinking[0] → content[0] (inline) → shell[0] → thinking[1] → files → content[1] (final)
      dispatchMessage({
        type: 'loadHistory',
        history: [
          { role: 'user', content: 'Edit file', timestamp: 1000 },
          {
            role: 'assistant',
            content: 'Added animals.',
            model: 'deepseek-reasoner',
            reasoning_iterations: ['Checking file...', 'Now editing...'],
            shellResults: [{ command: 'cat test.txt', output: 'contents', success: true }],
            contentIterations: ['Let me check first', 'Added animals.'],
            filesModified: ['test.txt'],
            timestamp: 2000
          }
        ]
      });

      // Files rendered
      expect(mockActors.virtualList.addPendingFile).toHaveBeenCalledWith('turn-2', {
        filePath: 'test.txt',
        status: 'applied'
      });

      // Order: shell before files, files before final text
      const shellCall = mockActors.virtualList.createShellSegment.mock.invocationCallOrder[0];
      const fileCall = mockActors.virtualList.addPendingFile.mock.invocationCallOrder[0];
      // Final text is addTextSegment call [2]: [0]=user text, [1]=inline content[0], [2]=remaining content[1]
      const textCalls = (mockActors.virtualList.addTextSegment as ReturnType<typeof vi.fn>).mock.invocationCallOrder;
      const finalTextCall = textCalls[textCalls.length - 1]; // last addTextSegment call
      expect(shellCall).toBeLessThan(fileCall);
      expect(fileCall).toBeLessThan(finalTextCall);
    });

    it('falls back to full content when contentIterations is missing (legacy data)', () => {
      dispatchMessage({
        type: 'loadHistory',
        history: [
          { role: 'user', content: 'Hello', timestamp: 1000 },
          {
            role: 'assistant',
            content: 'Full accumulated text',
            model: 'deepseek-reasoner',
            reasoning_iterations: ['Thinking...'],
            timestamp: 2000
          }
        ]
      });

      // Should fall back to m.content since no contentIterations
      expect(mockActors.virtualList.addTextSegment).toHaveBeenCalledWith('turn-2', 'Full accumulated text');
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

  describe('code block carry-forward', () => {
    it('carries forward incomplete code block to new segment after interleaving', () => {
      dispatchMessage({ type: 'startResponse', messageId: 'msg-1' });

      // Stream content that includes a complete block + start of another
      dispatchMessage({ type: 'streamToken', token: '```python\npass\n```\n\n```javascript\nconst x' });

      // Simulate interleave: diffListChanged finalizes the segment
      dispatchMessage({
        type: 'diffListChanged',
        diffs: [{ filePath: 'file.py', status: 'applied' }]
      });

      // Now make getBoundActor return needsNewSegment = true (simulating post-interleave)
      (mockActors.virtualList.getBoundActor as ReturnType<typeof vi.fn>).mockReturnValue({
        needsNewSegment: () => true
      });

      // Next token arrives → should create new segment with carry-forward
      dispatchMessage({ type: 'streamToken', token: ' = 1;' });

      // segmentContent should start with the carried-forward incomplete block
      expect(gateway.segmentContent).toContain('```javascript');
      expect(gateway.segmentContent).toContain('const x');
      expect(gateway.segmentContent).toContain(' = 1;');
    });

    it('resets segmentContent to empty when no incomplete code block exists', () => {
      dispatchMessage({ type: 'startResponse', messageId: 'msg-1' });

      // Stream content with only a complete block (no trailing incomplete)
      dispatchMessage({ type: 'streamToken', token: 'Hello ```python\npass\n``` done' });

      dispatchMessage({
        type: 'diffListChanged',
        diffs: [{ filePath: 'file.py', status: 'applied' }]
      });

      (mockActors.virtualList.getBoundActor as ReturnType<typeof vi.fn>).mockReturnValue({
        needsNewSegment: () => true
      });

      dispatchMessage({ type: 'streamToken', token: ' more text' });

      // No carry-forward — starts fresh
      expect(gateway.segmentContent).toBe(' more text');
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
