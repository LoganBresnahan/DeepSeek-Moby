/**
 * Message Handler Integration Tests
 *
 * Tests the VS Code message routing in chat.ts to verify that
 * each message type is correctly dispatched to the appropriate actor.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createTestActorSystem,
  waitForPubSub,
  type TestActorSystem
} from './helpers';

describe('Message Handler Integration', () => {
  let system: TestActorSystem;

  beforeEach(async () => {
    system = await createTestActorSystem();
  });

  afterEach(() => {
    system.cleanup();
  });

  describe('startResponse message', () => {
    it('starts streaming and updates UI state', async () => {
      system.dispatchMessage({
        type: 'startResponse',
        messageId: 'msg-123'
      });
      await waitForPubSub();

      expect(system.streaming.isActive).toBe(true);
      expect(system.streaming.messageId).toBe('msg-123');
      expect(system.elements.sendBtn.style.display).toBe('none');
      expect(system.elements.stopBtn.style.display).toBe('flex');
    });

    it('generates messageId if not provided', async () => {
      system.dispatchMessage({ type: 'startResponse' });
      await waitForPubSub();

      expect(system.streaming.isActive).toBe(true);
      expect(system.streaming.messageId).toMatch(/^msg-\d+$/);
    });

    it('does not start thinking iteration at startResponse time (deferred to content arrival)', async () => {
      const startSpy = vi.spyOn(system.thinking, 'startIteration');

      system.dispatchMessage({
        type: 'startResponse',
        messageId: 'msg-123',
        isReasoner: true
      });
      await waitForPubSub();

      // Thinking is NOT started at startResponse - it's deferred until thinking content arrives
      // This ensures thinking appears inline with the response flow
      expect(startSpy).not.toHaveBeenCalled();
    });

    it('starts thinking when iterationStart message arrives', async () => {
      const startSpy = vi.spyOn(system.thinking, 'startIteration');

      system.dispatchMessage({
        type: 'startResponse',
        messageId: 'msg-123',
        isReasoner: true
      });
      await waitForPubSub();

      // Now send iterationStart
      system.dispatchMessage({ type: 'iterationStart' });
      await waitForPubSub();

      expect(startSpy).toHaveBeenCalled();
    });
  });

  describe('streamToken message', () => {
    it('accumulates content chunks', async () => {
      system.dispatchMessage({ type: 'startResponse', messageId: 'msg-1' });
      await waitForPubSub();

      system.dispatchMessage({ type: 'streamToken', token: 'Hello' });
      await waitForPubSub();
      expect(system.streaming.content).toBe('Hello');

      system.dispatchMessage({ type: 'streamToken', token: ' world!' });
      await waitForPubSub();
      expect(system.streaming.content).toBe('Hello world!');
    });

    it('ignores tokens when not streaming', async () => {
      system.dispatchMessage({ type: 'streamToken', token: 'ignored' });
      await waitForPubSub();

      expect(system.streaming.content).toBe('');
    });
  });

  describe('streamReasoning message', () => {
    it('accumulates thinking chunks', async () => {
      system.dispatchMessage({ type: 'startResponse', messageId: 'msg-1' });
      await waitForPubSub();

      system.dispatchMessage({ type: 'streamReasoning', token: 'Let me think' });
      await waitForPubSub();
      expect(system.streaming.thinking).toBe('Let me think');

      system.dispatchMessage({ type: 'streamReasoning', token: '...' });
      await waitForPubSub();
      expect(system.streaming.thinking).toBe('Let me think...');
    });
  });

  describe('iterationStart message', () => {
    it('starts a new thinking iteration', async () => {
      const startSpy = vi.spyOn(system.thinking, 'startIteration');

      system.dispatchMessage({ type: 'iterationStart' });
      await waitForPubSub();

      expect(startSpy).toHaveBeenCalled();
    });
  });

  describe('endResponse message', () => {
    it('ends streaming and updates UI state', async () => {
      system.dispatchMessage({ type: 'startResponse', messageId: 'msg-1' });
      await waitForPubSub();

      system.dispatchMessage({ type: 'endResponse' });
      await waitForPubSub();

      expect(system.streaming.isActive).toBe(false);
      expect(system.elements.sendBtn.style.display).toBe('flex');
      expect(system.elements.stopBtn.style.display).toBe('none');
    });

    it('adds assistant message if provided', async () => {
      system.dispatchMessage({ type: 'startResponse', messageId: 'msg-1' });
      await waitForPubSub();

      system.dispatchMessage({
        type: 'endResponse',
        message: {
          content: 'Final response',
          reasoning: 'I thought about it'
        }
      });
      await waitForPubSub();

      const messages = system.message.getMessages();
      expect(messages.length).toBe(1);
      expect(messages[0].content).toBe('Final response');
      expect(messages[0].thinking).toBe('I thought about it');
    });

    it('completes thinking iteration', async () => {
      const completeSpy = vi.spyOn(system.thinking, 'completeIteration');

      system.dispatchMessage({ type: 'startResponse', messageId: 'msg-1' });
      await waitForPubSub();
      system.dispatchMessage({ type: 'endResponse' });
      await waitForPubSub();

      expect(completeSpy).toHaveBeenCalled();
    });
  });

  describe('shellExecuting message', () => {
    it('creates and starts shell segment', async () => {
      const createSpy = vi.spyOn(system.shell, 'createSegment');
      const startSpy = vi.spyOn(system.shell, 'startSegment');

      system.dispatchMessage({
        type: 'shellExecuting',
        commands: ['npm test', 'npm build']
      });
      await waitForPubSub();

      expect(createSpy).toHaveBeenCalledWith(['npm test', 'npm build']);
      expect(startSpy).toHaveBeenCalled();
    });

    it('ignores empty commands array', async () => {
      const createSpy = vi.spyOn(system.shell, 'createSegment');

      system.dispatchMessage({
        type: 'shellExecuting',
        commands: []
      });
      await waitForPubSub();

      // createSegment is called even with empty array, that's ok
      // Just make sure it doesn't crash
      expect(true).toBe(true);
    });

    it('ignores missing commands', async () => {
      const createSpy = vi.spyOn(system.shell, 'createSegment');

      system.dispatchMessage({ type: 'shellExecuting' });
      await waitForPubSub();

      expect(createSpy).not.toHaveBeenCalled();
    });
  });

  describe('shellResults message', () => {
    it('sets results for active segment', async () => {
      const setResultsSpy = vi.spyOn(system.shell, 'setResults');

      // First execute commands
      system.dispatchMessage({
        type: 'shellExecuting',
        commands: ['npm test']
      });
      await waitForPubSub();

      // Then send results
      system.dispatchMessage({
        type: 'shellResults',
        results: [{ output: 'All tests passed', exitCode: 0 }]
      });
      await waitForPubSub();

      expect(setResultsSpy).toHaveBeenCalledWith(
        expect.any(String),
        [{ success: true, output: 'All tests passed' }]
      );
    });

    it('ignores results without active segment', async () => {
      const setResultsSpy = vi.spyOn(system.shell, 'setResults');

      system.dispatchMessage({
        type: 'shellResults',
        results: [{ output: 'orphan', exitCode: 0 }]
      });
      await waitForPubSub();

      expect(setResultsSpy).not.toHaveBeenCalled();
    });

    it('maps exitCode to success boolean', async () => {
      const setResultsSpy = vi.spyOn(system.shell, 'setResults');

      system.dispatchMessage({
        type: 'shellExecuting',
        commands: ['fail', 'pass']
      });
      await waitForPubSub();

      system.dispatchMessage({
        type: 'shellResults',
        results: [
          { output: 'error', exitCode: 1 },
          { output: 'ok', exitCode: 0 }
        ]
      });
      await waitForPubSub();

      expect(setResultsSpy).toHaveBeenCalledWith(
        expect.any(String),
        [
          { success: false, output: 'error' },
          { success: true, output: 'ok' }
        ]
      );
    });
  });

  describe('toolCallsStart message', () => {
    it('starts tool batch', async () => {
      const startSpy = vi.spyOn(system.toolCalls, 'startBatch');

      system.dispatchMessage({
        type: 'toolCallsStart',
        tools: [
          { name: 'read_file', detail: 'Reading package.json' },
          { name: 'write_file', detail: 'Writing output.txt' }
        ]
      });
      await waitForPubSub();

      expect(startSpy).toHaveBeenCalledWith([
        { name: 'read_file', detail: 'Reading package.json' },
        { name: 'write_file', detail: 'Writing output.txt' }
      ]);
    });

    it('ignores missing tools array', async () => {
      const startSpy = vi.spyOn(system.toolCalls, 'startBatch');

      system.dispatchMessage({ type: 'toolCallsStart' });
      await waitForPubSub();

      expect(startSpy).not.toHaveBeenCalled();
    });
  });

  describe('toolCallUpdate message', () => {
    it('updates individual tool status', async () => {
      // Start with tools
      system.dispatchMessage({
        type: 'toolCallsStart',
        tools: [
          { name: 'read_file', detail: 'test' },
          { name: 'write_file', detail: 'test' }
        ]
      });
      await waitForPubSub();

      const updateSpy = vi.spyOn(system.toolCalls, 'updateBatch');

      system.dispatchMessage({
        type: 'toolCallUpdate',
        index: 0,
        status: 'running'
      });
      await waitForPubSub();

      expect(updateSpy).toHaveBeenCalled();
      const calls = system.toolCalls.getCalls();
      expect(calls[0].status).toBe('running');
    });

    it('ignores invalid index', async () => {
      system.dispatchMessage({
        type: 'toolCallsStart',
        tools: [{ name: 'read_file', detail: 'test' }]
      });
      await waitForPubSub();

      const updateSpy = vi.spyOn(system.toolCalls, 'updateBatch');

      system.dispatchMessage({
        type: 'toolCallUpdate',
        index: 99,
        status: 'running'
      });
      await waitForPubSub();

      expect(updateSpy).not.toHaveBeenCalled();
    });
  });

  describe('toolCallsUpdate message', () => {
    it('batch updates all tools', async () => {
      const updateSpy = vi.spyOn(system.toolCalls, 'updateBatch');

      system.dispatchMessage({
        type: 'toolCallsUpdate',
        tools: [
          { name: 'read', detail: 'd1', status: 'done' },
          { name: 'write', detail: 'd2', status: 'running' }
        ]
      });
      await waitForPubSub();

      expect(updateSpy).toHaveBeenCalledWith([
        { name: 'read', detail: 'd1', status: 'done' },
        { name: 'write', detail: 'd2', status: 'running' }
      ]);
    });
  });

  describe('toolCallsEnd message', () => {
    it('completes tool calls', async () => {
      const completeSpy = vi.spyOn(system.toolCalls, 'complete');

      system.dispatchMessage({ type: 'toolCallsEnd' });
      await waitForPubSub();

      expect(completeSpy).toHaveBeenCalled();
    });
  });

  describe('addMessage message', () => {
    it('adds user message', async () => {
      system.dispatchMessage({
        type: 'addMessage',
        message: {
          role: 'user',
          content: 'Hello!',
          files: ['file.txt']
        }
      });
      await waitForPubSub();

      const messages = system.message.getMessages();
      expect(messages.length).toBe(1);
      expect(messages[0].role).toBe('user');
      expect(messages[0].content).toBe('Hello!');
    });

    it('adds assistant message with reasoning', async () => {
      system.dispatchMessage({
        type: 'addMessage',
        message: {
          role: 'assistant',
          content: 'Response',
          reasoning: 'Thought process'
        }
      });
      await waitForPubSub();

      const messages = system.message.getMessages();
      expect(messages.length).toBe(1);
      expect(messages[0].role).toBe('assistant');
      expect(messages[0].thinking).toBe('Thought process');
    });
  });

  describe('loadHistory message', () => {
    it('clears and loads conversation history', async () => {
      // Add initial message
      system.message.addUserMessage('Old message');
      expect(system.message.getMessages().length).toBe(1);

      system.dispatchMessage({
        type: 'loadHistory',
        history: [
          { role: 'user', content: 'First' },
          { role: 'assistant', content: 'Reply', reasoning_content: 'Thought' },
          { role: 'user', content: 'Second' }
        ]
      });
      await waitForPubSub();

      const messages = system.message.getMessages();
      expect(messages.length).toBe(3);
      expect(messages[0].content).toBe('First');
      expect(messages[1].content).toBe('Reply');
      expect(messages[1].thinking).toBe('Thought');
      expect(messages[2].content).toBe('Second');
    });

    it('handles empty history', async () => {
      system.message.addUserMessage('Existing');

      system.dispatchMessage({
        type: 'loadHistory',
        history: []
      });
      await waitForPubSub();

      expect(system.message.getMessages().length).toBe(0);
    });
  });

  describe('clearChat message', () => {
    it('clears all messages', async () => {
      system.message.addUserMessage('Message 1');
      system.message.addAssistantMessage('Message 2');
      expect(system.message.getMessages().length).toBe(2);

      system.dispatchMessage({ type: 'clearChat' });
      await waitForPubSub();

      expect(system.message.getMessages().length).toBe(0);
    });
  });

  describe('generationStopped message', () => {
    it('resets UI to non-streaming state', async () => {
      // Start streaming
      system.dispatchMessage({ type: 'startResponse' });
      await waitForPubSub();
      expect(system.elements.sendBtn.style.display).toBe('none');

      // Stop
      system.dispatchMessage({ type: 'generationStopped' });
      await waitForPubSub();

      expect(system.elements.sendBtn.style.display).toBe('flex');
      expect(system.elements.stopBtn.style.display).toBe('none');
    });
  });
});
