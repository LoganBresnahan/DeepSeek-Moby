/**
 * Mid-Stream Interrupt Integration Tests
 *
 * Tests the "Interrupt & Append" feature that allows users
 * to send a new message while the AI is still generating a response.
 *
 * Flow:
 * 1. User types message during streaming
 * 2. User submits -> message is queued, stopGeneration is sent
 * 3. Backend stops and sends generationStopped
 * 4. Frontend sends the queued message
 *
 * Uses VirtualListActor + VirtualMessageGatewayActor architecture.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventStateManager } from '../../media/state/EventStateManager';
import { StreamingActor } from '../../media/actors/streaming';
import { VirtualListActor } from '../../media/actors/virtual-list';
import {
  createMockVSCodeAPI,
  createTestDOM,
  waitForMicrotasks,
  waitForPubSub,
  type MockVSCodeAPI,
  type TestDOMElements
} from './helpers';

// ============================================
// Test System Setup
// ============================================

interface TestSystem {
  manager: EventStateManager;
  streaming: StreamingActor;
  virtualList: VirtualListActor;
  vscode: MockVSCodeAPI;
  elements: TestDOMElements;
  cleanup: () => void;
  // State
  isStreaming: boolean;
  pendingInterruptMessage: { content: string } | null;
  messageCounter: number;
  currentTurnId: string | null;
  // Actions
  startResponse: (messageId?: string) => void;
  streamToken: (token: string) => void;
  endResponse: (content: string) => void;
  sendMessage: (content: string) => void;
  triggerGenerationStopped: () => void;
}

async function createTestSystem(): Promise<TestSystem> {
  StreamingActor.resetStylesInjected();

  const vscode = createMockVSCodeAPI();
  const elements = createTestDOM();
  const manager = new EventStateManager({ batchBroadcasts: false });

  const streaming = new StreamingActor(manager, elements.streamingRoot);
  const virtualList = new VirtualListActor(manager, elements.chatMessages, {
    minPoolSize: 3,
    maxPoolSize: 10,
    overscan: 1
  });

  await waitForMicrotasks();

  // State variables
  let isStreaming = false;
  let pendingInterruptMessage: { content: string } | null = null;
  let messageCounter = 0;
  let currentTurnId: string | null = null;

  // Action: Start streaming response
  const startResponse = (messageId = `msg-${Date.now()}`) => {
    isStreaming = true;
    const turnId = `turn-${++messageCounter}`;
    currentTurnId = turnId;

    virtualList.addTurn(turnId, 'assistant', {
      model: 'deepseek-chat',
      timestamp: Date.now()
    });
    virtualList.startStreamingTurn(turnId);
    streaming.startStream(messageId, 'deepseek-chat');

    elements.sendBtn.style.display = 'none';
    elements.stopBtn.style.display = 'flex';
  };

  // Action: Stream a token
  const streamToken = (token: string) => {
    if (!currentTurnId) return;

    const turn = virtualList.getTurn(currentTurnId);
    if (!turn) return;

    if (turn.textSegments.length === 0) {
      virtualList.addTextSegment(currentTurnId, token);
    } else {
      const currentContent = turn.textSegments[turn.textSegments.length - 1]?.content || '';
      virtualList.updateTextContent(currentTurnId, currentContent + token);
    }

    streaming.handleContentChunk(token);
  };

  // Action: End streaming response
  const endResponse = (content: string) => {
    isStreaming = false;
    streaming.endStream();

    if (currentTurnId) {
      virtualList.endStreamingTurn();
    }

    currentTurnId = null;
    elements.sendBtn.style.display = 'flex';
    elements.stopBtn.style.display = 'none';
  };

  // Action: Send user message (with interrupt support)
  const sendMessage = (content: string) => {
    if (!content.trim()) return;

    if (isStreaming) {
      // Interrupt flow
      const alreadyInterrupting = pendingInterruptMessage !== null;

      pendingInterruptMessage = { content };
      elements.messageInput.value = '';

      if (!alreadyInterrupting) {
        vscode.postMessage({ type: 'stopGeneration' });
        elements.sendBtn.classList.add('interrupting');
      }
      return;
    }

    // Normal flow
    const turnId = `turn-${++messageCounter}`;
    virtualList.addTurn(turnId, 'user', { timestamp: Date.now() });
    virtualList.addTextSegment(turnId, content);

    elements.messageInput.value = '';
    vscode.postMessage({ type: 'sendMessage', message: content });
  };

  // Action: Handle generation stopped
  const triggerGenerationStopped = () => {
    isStreaming = false;
    streaming.endStream();

    if (currentTurnId) {
      virtualList.endStreamingTurn();
    }

    currentTurnId = null;
    elements.sendBtn.style.display = 'flex';
    elements.stopBtn.style.display = 'none';
    elements.sendBtn.classList.remove('interrupting');

    // Send pending interrupt message
    if (pendingInterruptMessage) {
      const { content } = pendingInterruptMessage;
      pendingInterruptMessage = null;

      // Add user message
      const turnId = `turn-${++messageCounter}`;
      virtualList.addTurn(turnId, 'user', { timestamp: Date.now() });
      virtualList.addTextSegment(turnId, content);

      vscode.postMessage({ type: 'sendMessage', message: content });
    }
  };

  const cleanup = () => {
    streaming.destroy();
    virtualList.destroy();
    document.body.innerHTML = '';
  };

  return {
    manager,
    streaming,
    virtualList,
    vscode,
    elements,
    cleanup,
    get isStreaming() { return isStreaming; },
    get pendingInterruptMessage() { return pendingInterruptMessage; },
    get messageCounter() { return messageCounter; },
    get currentTurnId() { return currentTurnId; },
    startResponse,
    streamToken,
    endResponse,
    sendMessage,
    triggerGenerationStopped
  };
}

// ============================================
// Tests
// ============================================

describe('Mid-Stream Interrupt Flow', () => {
  let system: TestSystem;

  beforeEach(async () => {
    system = await createTestSystem();
  });

  afterEach(() => {
    system.cleanup();
  });

  describe('basic interrupt flow', () => {
    it('allows typing in input during streaming', async () => {
      system.startResponse();
      await waitForPubSub();

      expect(system.isStreaming).toBe(true);

      // User can still type in the input
      system.elements.messageInput.value = 'New message while streaming';
      expect(system.elements.messageInput.value).toBe('New message while streaming');
    });

    it('queues message and sends stopGeneration when submitting during streaming', async () => {
      system.startResponse();
      await waitForPubSub();

      system.streamToken('Partial response...');
      await waitForPubSub();

      system.sendMessage('Interrupt with this!');

      expect(system.pendingInterruptMessage).toEqual({ content: 'Interrupt with this!' });
      expect(system.vscode.postMessage).toHaveBeenCalledWith({ type: 'stopGeneration' });
      expect(system.elements.sendBtn.classList.contains('interrupting')).toBe(true);
    });

    it('sends queued message after receiving generationStopped', async () => {
      system.startResponse();
      await waitForPubSub();

      system.streamToken('Partial...');
      system.sendMessage('My follow-up message');

      system.triggerGenerationStopped();
      await waitForPubSub();

      expect(system.vscode.postMessage).toHaveBeenCalledWith({
        type: 'sendMessage',
        message: 'My follow-up message'
      });
      expect(system.pendingInterruptMessage).toBeNull();
      expect(system.elements.sendBtn.classList.contains('interrupting')).toBe(false);
    });

    it('adds user message to UI after interrupt completes', async () => {
      system.startResponse();
      await waitForPubSub();

      system.streamToken('AI response...');
      system.sendMessage('User follow-up');

      system.triggerGenerationStopped();
      await waitForPubSub();

      // User turn should be added (turn-2 because turn-1 was the assistant)
      const stats = system.virtualList.getPoolStats();
      expect(stats.totalTurns).toBeGreaterThanOrEqual(2);
    });
  });

  describe('multiple interrupt attempts', () => {
    it('only sends one stopGeneration even if user submits multiple times', async () => {
      system.startResponse();
      await waitForPubSub();

      system.sendMessage('First interrupt attempt');
      system.sendMessage('Second interrupt attempt');
      system.sendMessage('Third interrupt attempt');

      const stopCalls = (system.vscode.postMessage as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: unknown[]) => (call[0] as { type: string }).type === 'stopGeneration'
      );
      expect(stopCalls.length).toBe(1);

      expect(system.pendingInterruptMessage?.content).toBe('Third interrupt attempt');
    });

    it('sends the most recent message when interrupt completes', async () => {
      system.startResponse();
      await waitForPubSub();

      system.sendMessage('First attempt');
      system.sendMessage('Second attempt');
      system.sendMessage('Final message');

      system.triggerGenerationStopped();
      await waitForPubSub();

      const sendCalls = (system.vscode.postMessage as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: unknown[]) => (call[0] as { type: string }).type === 'sendMessage'
      );
      expect(sendCalls[sendCalls.length - 1][0]).toEqual({
        type: 'sendMessage',
        message: 'Final message'
      });
    });
  });

  describe('UI state management', () => {
    it('clears input immediately when interrupt is triggered', async () => {
      system.startResponse();
      await waitForPubSub();

      system.elements.messageInput.value = 'My interrupt message';
      system.sendMessage('My interrupt message');

      expect(system.elements.messageInput.value).toBe('');
    });

    it('resets button state after interrupt completes', async () => {
      system.startResponse();
      await waitForPubSub();

      // During streaming, stop button is visible
      expect(system.elements.stopBtn.style.display).toBe('flex');
      expect(system.elements.sendBtn.style.display).toBe('none');

      system.sendMessage('Interrupt');
      expect(system.elements.sendBtn.classList.contains('interrupting')).toBe(true);

      system.triggerGenerationStopped();
      await waitForPubSub();

      expect(system.elements.sendBtn.style.display).toBe('flex');
      expect(system.elements.stopBtn.style.display).toBe('none');
      expect(system.elements.sendBtn.classList.contains('interrupting')).toBe(false);
    });

    it('does not queue empty messages', async () => {
      system.startResponse();
      await waitForPubSub();

      system.sendMessage('');
      system.sendMessage('   ');

      expect(system.pendingInterruptMessage).toBeNull();

      const stopCalls = (system.vscode.postMessage as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: unknown[]) => (call[0] as { type: string }).type === 'stopGeneration'
      );
      expect(stopCalls.length).toBe(0);
    });
  });

  describe('normal flow (not streaming)', () => {
    it('sends message immediately when not streaming', async () => {
      expect(system.isStreaming).toBe(false);

      system.sendMessage('Normal message');

      expect(system.vscode.postMessage).toHaveBeenCalledWith({
        type: 'sendMessage',
        message: 'Normal message'
      });
      expect(system.pendingInterruptMessage).toBeNull();

      const stopCalls = (system.vscode.postMessage as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: unknown[]) => (call[0] as { type: string }).type === 'stopGeneration'
      );
      expect(stopCalls.length).toBe(0);
    });

    it('adds user message to UI immediately when not streaming', async () => {
      system.sendMessage('Hello AI');

      const stats = system.virtualList.getPoolStats();
      expect(stats.totalTurns).toBe(1);
    });
  });

  describe('edge cases', () => {
    it('handles generationStopped without pending message (manual stop)', async () => {
      system.startResponse();
      await waitForPubSub();

      // User clicks stop button (no pending message)
      system.triggerGenerationStopped();
      await waitForPubSub();

      const sendCalls = (system.vscode.postMessage as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: unknown[]) => (call[0] as { type: string }).type === 'sendMessage'
      );
      expect(sendCalls.length).toBe(0);

      expect(system.elements.sendBtn.style.display).toBe('flex');
      expect(system.elements.stopBtn.style.display).toBe('none');
    });

    it('handles rapid stream start -> interrupt -> stop sequence', async () => {
      system.startResponse();
      await waitForPubSub();

      system.sendMessage('Quick interrupt');

      system.triggerGenerationStopped();
      await waitForPubSub();

      expect(system.vscode.postMessage).toHaveBeenCalledWith({
        type: 'sendMessage',
        message: 'Quick interrupt'
      });
    });
  });
});
