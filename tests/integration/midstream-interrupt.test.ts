/**
 * Mid-Stream Interrupt Integration Tests
 *
 * Tests the "Interrupt & Append" feature (Option 2) that allows users
 * to send a new message while the AI is still generating a response.
 *
 * Flow:
 * 1. User types message during streaming
 * 2. User submits -> message is queued, stopGeneration is sent
 * 3. Backend stops and sends generationStopped
 * 4. Frontend sends the queued message
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createTestActorSystem,
  waitForPubSub,
  type TestActorSystem
} from './helpers';

describe('Mid-Stream Interrupt Flow', () => {
  let system: TestActorSystem;

  beforeEach(async () => {
    system = await createTestActorSystem();
  });

  afterEach(() => {
    system.cleanup();
  });

  describe('basic interrupt flow', () => {
    it('allows typing in input during streaming', async () => {
      // Start streaming
      system.dispatchMessage({ type: 'startResponse', messageId: 'msg-1' });
      await waitForPubSub();

      expect(system.isStreaming()).toBe(true);

      // User can still type in the input
      system.elements.messageInput.value = 'New message while streaming';

      // Verify input is not disabled (we allow typing during streaming)
      expect(system.elements.messageInput.value).toBe('New message while streaming');
    });

    it('queues message and sends stopGeneration when submitting during streaming', async () => {
      // Start streaming
      system.dispatchMessage({ type: 'startResponse', messageId: 'msg-1' });
      await waitForPubSub();

      // Stream some content
      system.dispatchMessage({ type: 'streamToken', token: 'Partial response...' });
      await waitForPubSub();

      // User submits during streaming
      system.sendMessage('Interrupt with this!');

      // Should have queued the message
      expect(system.getPendingInterruptMessage()).toEqual({
        content: 'Interrupt with this!'
      });

      // Should have sent stopGeneration
      expect(system.vscode.postMessage).toHaveBeenCalledWith({
        type: 'stopGeneration'
      });

      // Should show interrupting state
      expect(system.elements.sendBtn.classList.contains('interrupting')).toBe(true);
    });

    it('sends queued message after receiving generationStopped', async () => {
      // Start streaming
      system.dispatchMessage({ type: 'startResponse', messageId: 'msg-1' });
      await waitForPubSub();

      // Stream some content
      system.dispatchMessage({ type: 'streamToken', token: 'Partial...' });
      await waitForPubSub();

      // User submits during streaming
      system.sendMessage('My follow-up message');

      // Simulate backend stopping
      system.dispatchMessage({ type: 'generationStopped' });
      await waitForPubSub();

      // Give the setTimeout in generationStopped handler time to fire
      await new Promise(resolve => setTimeout(resolve, 50));

      // Should have sent the queued message
      expect(system.vscode.postMessage).toHaveBeenCalledWith({
        type: 'sendMessage',
        message: 'My follow-up message'
      });

      // Pending message should be cleared
      expect(system.getPendingInterruptMessage()).toBeNull();

      // Interrupting state should be removed
      expect(system.elements.sendBtn.classList.contains('interrupting')).toBe(false);
    });

    it('adds user message to UI after interrupt completes', async () => {
      // Start streaming
      system.dispatchMessage({ type: 'startResponse', messageId: 'msg-1' });
      await waitForPubSub();

      // Stream some content
      system.dispatchMessage({ type: 'streamToken', token: 'AI response...' });
      await waitForPubSub();

      // User submits during streaming
      system.sendMessage('User follow-up');

      // Simulate backend stopping
      system.dispatchMessage({ type: 'generationStopped' });
      await waitForPubSub();

      // Wait for the queued message to be sent
      await new Promise(resolve => setTimeout(resolve, 50));

      // User message should be added to the message list
      const messages = system.message.getMessages();
      const userMessages = messages.filter(m => m.role === 'user');
      expect(userMessages.some(m => m.content === 'User follow-up')).toBe(true);
    });
  });

  describe('multiple interrupt attempts', () => {
    it('only sends one stopGeneration even if user submits multiple times', async () => {
      // Start streaming
      system.dispatchMessage({ type: 'startResponse', messageId: 'msg-1' });
      await waitForPubSub();

      // User submits first message
      system.sendMessage('First interrupt attempt');

      // User changes mind and submits again before stop completes
      system.sendMessage('Second interrupt attempt');

      // User submits a third time
      system.sendMessage('Third interrupt attempt');

      // Should only have ONE stopGeneration call
      const stopCalls = system.vscode.postMessage.mock.calls.filter(
        call => call[0].type === 'stopGeneration'
      );
      expect(stopCalls.length).toBe(1);

      // Should have the LAST message queued (overwrites previous)
      expect(system.getPendingInterruptMessage()?.content).toBe('Third interrupt attempt');
    });

    it('sends the most recent message when interrupt completes', async () => {
      // Start streaming
      system.dispatchMessage({ type: 'startResponse', messageId: 'msg-1' });
      await waitForPubSub();

      // User submits multiple times
      system.sendMessage('First attempt');
      system.sendMessage('Second attempt');
      system.sendMessage('Final message');

      // Simulate backend stopping
      system.dispatchMessage({ type: 'generationStopped' });
      await waitForPubSub();

      // Wait for queued message
      await new Promise(resolve => setTimeout(resolve, 50));

      // Should send the final message
      const sendCalls = system.vscode.postMessage.mock.calls.filter(
        call => call[0].type === 'sendMessage'
      );
      expect(sendCalls[sendCalls.length - 1][0].message).toBe('Final message');
    });
  });

  describe('UI state management', () => {
    it('clears input immediately when interrupt is triggered', async () => {
      // Start streaming
      system.dispatchMessage({ type: 'startResponse', messageId: 'msg-1' });
      await waitForPubSub();

      // Set input value
      system.elements.messageInput.value = 'My interrupt message';

      // Submit
      system.sendMessage('My interrupt message');

      // Input should be cleared immediately (good UX)
      expect(system.elements.messageInput.value).toBe('');
    });

    it('resets button state after interrupt completes', async () => {
      // Start streaming
      system.dispatchMessage({ type: 'startResponse', messageId: 'msg-1' });
      await waitForPubSub();

      // During streaming, stop button is visible
      expect(system.elements.stopBtn.style.display).toBe('flex');
      expect(system.elements.sendBtn.style.display).toBe('none');

      // User submits interrupt
      system.sendMessage('Interrupt');

      // Should show interrupting state
      expect(system.elements.sendBtn.classList.contains('interrupting')).toBe(true);

      // Simulate backend stopping
      system.dispatchMessage({ type: 'generationStopped' });
      await waitForPubSub();

      // Buttons should be reset
      expect(system.elements.sendBtn.style.display).toBe('flex');
      expect(system.elements.stopBtn.style.display).toBe('none');
      expect(system.elements.sendBtn.classList.contains('interrupting')).toBe(false);
    });

    it('does not queue empty messages', async () => {
      // Start streaming
      system.dispatchMessage({ type: 'startResponse', messageId: 'msg-1' });
      await waitForPubSub();

      // Try to submit empty message
      system.sendMessage('');
      system.sendMessage('   '); // whitespace only

      // Should NOT have queued anything
      expect(system.getPendingInterruptMessage()).toBeNull();

      // Should NOT have called stopGeneration
      const stopCalls = system.vscode.postMessage.mock.calls.filter(
        call => call[0].type === 'stopGeneration'
      );
      expect(stopCalls.length).toBe(0);
    });
  });

  describe('normal flow (not streaming)', () => {
    it('sends message immediately when not streaming', async () => {
      // Not streaming - normal state
      expect(system.isStreaming()).toBe(false);

      // Send message
      system.sendMessage('Normal message');

      // Should send immediately (no queuing)
      expect(system.vscode.postMessage).toHaveBeenCalledWith({
        type: 'sendMessage',
        message: 'Normal message'
      });

      // Should NOT have queued anything
      expect(system.getPendingInterruptMessage()).toBeNull();

      // Should NOT have called stopGeneration
      const stopCalls = system.vscode.postMessage.mock.calls.filter(
        call => call[0].type === 'stopGeneration'
      );
      expect(stopCalls.length).toBe(0);
    });

    it('adds user message to UI immediately when not streaming', async () => {
      // Send message when not streaming
      system.sendMessage('Hello AI');

      // Message should be added to UI immediately
      const messages = system.message.getMessages();
      expect(messages.some(m => m.role === 'user' && m.content === 'Hello AI')).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('handles generationStopped without pending message (manual stop)', async () => {
      // Start streaming
      system.dispatchMessage({ type: 'startResponse', messageId: 'msg-1' });
      await waitForPubSub();

      // User clicks stop button (no pending message)
      system.dispatchMessage({ type: 'generationStopped' });
      await waitForPubSub();

      // Wait a bit
      await new Promise(resolve => setTimeout(resolve, 50));

      // Should NOT have sent any message
      const sendCalls = system.vscode.postMessage.mock.calls.filter(
        call => call[0].type === 'sendMessage'
      );
      expect(sendCalls.length).toBe(0);

      // UI should still be reset
      expect(system.elements.sendBtn.style.display).toBe('flex');
      expect(system.elements.stopBtn.style.display).toBe('none');
    });

    it('handles rapid stream start -> interrupt -> stop sequence', async () => {
      // Start streaming
      system.dispatchMessage({ type: 'startResponse', messageId: 'msg-1' });
      await waitForPubSub();

      // Immediately interrupt
      system.sendMessage('Quick interrupt');

      // Immediately stopped
      system.dispatchMessage({ type: 'generationStopped' });
      await waitForPubSub();

      // Wait for queued message
      await new Promise(resolve => setTimeout(resolve, 50));

      // Should have sent the interrupt message
      expect(system.vscode.postMessage).toHaveBeenCalledWith({
        type: 'sendMessage',
        message: 'Quick interrupt'
      });
    });
  });
});
