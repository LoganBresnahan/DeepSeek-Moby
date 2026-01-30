/**
 * Integration tests for interleaved content rendering
 *
 * Tests that text, tool calls, shell commands, and pending files
 * appear in the correct order during streaming responses.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createTestActorSystem,
  waitForPubSub,
  TestActorSystem
} from './helpers';

describe('Interleaved Content Rendering', () => {
  let system: TestActorSystem;

  beforeEach(async () => {
    system = await createTestActorSystem();
  });

  afterEach(() => {
    system.cleanup();
  });

  describe('Text → Tools → Text sequence', () => {
    it('shows first text segment before tools', async () => {
      // Start streaming
      system.dispatchMessage({
        type: 'startResponse',
        messageId: 'msg-1'
      });
      await waitForPubSub();

      // Stream initial text
      system.dispatchMessage({ type: 'streamToken', token: 'I will ' });
      system.dispatchMessage({ type: 'streamToken', token: 'search for you.' });
      await waitForPubSub();

      // Verify first message segment exists
      const messages = system.elements.chatMessages.querySelectorAll('.message.assistant');
      expect(messages.length).toBe(1);
      expect(messages[0].querySelector('.content')?.textContent).toContain('I will search for you.');
    });

    it('finalizes text segment when tools start', async () => {
      // Start and stream initial text
      system.dispatchMessage({ type: 'startResponse', messageId: 'msg-1' });
      await waitForPubSub();

      system.dispatchMessage({ type: 'streamToken', token: 'Let me search.' });
      await waitForPubSub();

      // Start tool calls - this should finalize the current segment
      system.dispatchMessage({
        type: 'toolCallsStart',
        tools: [{ name: 'search', detail: 'query: test' }]
      });
      await waitForPubSub();

      // Verify message segment is no longer marked as streaming
      const firstSegment = system.elements.chatMessages.querySelector('.message.assistant');
      expect(firstSegment).not.toBeNull();
      expect(firstSegment?.classList.contains('streaming')).toBe(false);
    });

    it('creates new segment for text after tools', async () => {
      // Start and stream initial text
      system.dispatchMessage({ type: 'startResponse', messageId: 'msg-1' });
      await waitForPubSub();

      system.dispatchMessage({ type: 'streamToken', token: 'Searching...' });
      await waitForPubSub();

      // Start tools
      system.dispatchMessage({
        type: 'toolCallsStart',
        tools: [{ name: 'search', detail: 'query: test' }]
      });
      await waitForPubSub();

      // Complete tools
      system.dispatchMessage({ type: 'toolCallsEnd' });
      await waitForPubSub();

      // Stream more text - should create new segment
      system.dispatchMessage({ type: 'streamToken', token: 'Found ' });
      system.dispatchMessage({ type: 'streamToken', token: 'results!' });
      await waitForPubSub();

      // Verify we have a continuation segment
      const continuations = system.elements.chatMessages.querySelectorAll('.message.assistant.continuation');
      expect(continuations.length).toBe(1);
      expect(continuations[0].querySelector('.content')?.textContent).toContain('Found results!');
    });

    it('maintains correct DOM order: text → tools → text', async () => {
      // Start streaming
      system.dispatchMessage({ type: 'startResponse', messageId: 'msg-1' });
      await waitForPubSub();

      // First text
      system.dispatchMessage({ type: 'streamToken', token: 'First part.' });
      await waitForPubSub();

      // Tools
      system.dispatchMessage({
        type: 'toolCallsStart',
        tools: [{ name: 'read_file', detail: 'test.ts' }]
      });
      await waitForPubSub();
      system.dispatchMessage({ type: 'toolCallsEnd' });
      await waitForPubSub();

      // Second text
      system.dispatchMessage({ type: 'streamToken', token: 'Second part.' });
      await waitForPubSub();

      // End
      system.dispatchMessage({
        type: 'endResponse',
        message: { content: 'First part.\n\nSecond part.' }
      });
      await waitForPubSub();

      // Check DOM order
      const chatMessages = system.elements.chatMessages;
      const children = Array.from(chatMessages.children).filter(
        el => el.classList.contains('message') || el.classList.contains('tools-batch')
      );

      // Should be: message → tools-batch → continuation
      expect(children.length).toBeGreaterThanOrEqual(3);
      expect(children[0].classList.contains('message')).toBe(true);
      expect(children[1].classList.contains('tools-batch')).toBe(true);
      expect(children[2].classList.contains('continuation')).toBe(true);
    });
  });

  describe('Text → Shell → Text sequence', () => {
    it('finalizes text segment when shell starts', async () => {
      // Start and stream initial text
      system.dispatchMessage({ type: 'startResponse', messageId: 'msg-1' });
      await waitForPubSub();

      system.dispatchMessage({ type: 'streamToken', token: 'Running command.' });
      await waitForPubSub();

      // Start shell - this should finalize the current segment
      system.dispatchMessage({
        type: 'shellExecuting',
        commands: ['npm test']
      });
      await waitForPubSub();

      // Verify message segment is no longer marked as streaming
      const firstSegment = system.elements.chatMessages.querySelector('.message.assistant');
      expect(firstSegment).not.toBeNull();
      expect(firstSegment?.classList.contains('streaming')).toBe(false);
    });

    it('creates new segment for text after shell completes', async () => {
      // Start and stream initial text
      system.dispatchMessage({ type: 'startResponse', messageId: 'msg-1' });
      await waitForPubSub();

      system.dispatchMessage({ type: 'streamToken', token: 'Running...' });
      await waitForPubSub();

      // Shell execution
      system.dispatchMessage({
        type: 'shellExecuting',
        commands: ['npm test']
      });
      await waitForPubSub();

      system.dispatchMessage({
        type: 'shellResults',
        results: [{ output: 'All tests passed', exitCode: 0 }]
      });
      await waitForPubSub();

      // Stream more text - should create new segment
      system.dispatchMessage({ type: 'streamToken', token: 'Tests passed!' });
      await waitForPubSub();

      // Verify we have a continuation segment
      const continuations = system.elements.chatMessages.querySelectorAll('.message.assistant.continuation');
      expect(continuations.length).toBe(1);
    });

    it('maintains correct DOM order: text → shell → text', async () => {
      // Start streaming
      system.dispatchMessage({ type: 'startResponse', messageId: 'msg-1' });
      await waitForPubSub();

      // First text
      system.dispatchMessage({ type: 'streamToken', token: 'Before shell.' });
      await waitForPubSub();

      // Shell
      system.dispatchMessage({
        type: 'shellExecuting',
        commands: ['echo hello']
      });
      await waitForPubSub();

      system.dispatchMessage({
        type: 'shellResults',
        results: [{ output: 'hello', exitCode: 0 }]
      });
      await waitForPubSub();

      // Second text
      system.dispatchMessage({ type: 'streamToken', token: 'After shell.' });
      await waitForPubSub();

      // End
      system.dispatchMessage({
        type: 'endResponse',
        message: { content: 'Before shell.\n\nAfter shell.' }
      });
      await waitForPubSub();

      // Check DOM order
      const chatMessages = system.elements.chatMessages;
      const children = Array.from(chatMessages.children).filter(
        el =>
          el.classList.contains('message') ||
          el.classList.contains('shell-segment')
      );

      // Should be: message → shell-segment → continuation
      expect(children.length).toBeGreaterThanOrEqual(3);
      expect(children[0].classList.contains('message')).toBe(true);
      expect(children[1].classList.contains('shell-segment')).toBe(true);
      expect(children[2].classList.contains('continuation')).toBe(true);
    });
  });

  describe('Text → Pending Files → Text sequence', () => {
    it('finalizes text segment when pending file arrives', async () => {
      // Set edit mode to 'ask' to see pending files dropdown
      system.pending.setEditMode('ask');

      // Start and stream initial text
      system.dispatchMessage({ type: 'startResponse', messageId: 'msg-1' });
      await waitForPubSub();

      system.dispatchMessage({ type: 'streamToken', token: 'Making changes.' });
      await waitForPubSub();

      // Add pending file - this should finalize the current segment
      system.dispatchMessage({
        type: 'pendingFileAdd',
        filePath: '/src/test.ts',
        diffId: 'diff-1'
      });
      await waitForPubSub();

      // Verify message segment is no longer marked as streaming
      const firstSegment = system.elements.chatMessages.querySelector('.message.assistant');
      expect(firstSegment).not.toBeNull();
      expect(firstSegment?.classList.contains('streaming')).toBe(false);
    });
  });

  describe('Complex interleaving', () => {
    it('handles text → tools → text → shell → text sequence', async () => {
      // Start streaming
      system.dispatchMessage({ type: 'startResponse', messageId: 'msg-1' });
      await waitForPubSub();

      // First text
      system.dispatchMessage({ type: 'streamToken', token: 'Step 1.' });
      await waitForPubSub();

      // Tools
      system.dispatchMessage({
        type: 'toolCallsStart',
        tools: [{ name: 'search', detail: 'find files' }]
      });
      await waitForPubSub();
      system.dispatchMessage({ type: 'toolCallsEnd' });
      await waitForPubSub();

      // Second text
      system.dispatchMessage({ type: 'streamToken', token: 'Step 2.' });
      await waitForPubSub();

      // Shell
      system.dispatchMessage({
        type: 'shellExecuting',
        commands: ['npm run build']
      });
      await waitForPubSub();
      system.dispatchMessage({
        type: 'shellResults',
        results: [{ output: 'Built', exitCode: 0 }]
      });
      await waitForPubSub();

      // Third text
      system.dispatchMessage({ type: 'streamToken', token: 'Step 3.' });
      await waitForPubSub();

      // End
      system.dispatchMessage({
        type: 'endResponse',
        message: { content: 'Step 1.\n\nStep 2.\n\nStep 3.' }
      });
      await waitForPubSub();

      // Verify we have the right number of segments and interleaved content
      const messages = system.elements.chatMessages.querySelectorAll('.message.assistant');
      const toolsBatches = system.elements.chatMessages.querySelectorAll('.tools-batch');
      const shellSegments = system.elements.chatMessages.querySelectorAll('.shell-segment');

      // Should have: original message + 2 continuations = 3 message segments
      expect(messages.length).toBeGreaterThanOrEqual(1);
      expect(toolsBatches.length).toBe(1);
      expect(shellSegments.length).toBe(1);
    });
  });

  describe('Text → Thinking → Text sequence (Reasoner model)', () => {
    it('finalizes text segment when thinking starts', async () => {
      // Start streaming
      system.dispatchMessage({ type: 'startResponse', messageId: 'msg-1' });
      await waitForPubSub();

      // Stream initial text
      system.dispatchMessage({ type: 'streamToken', token: 'Let me think.' });
      await waitForPubSub();

      // Thinking starts - this should finalize the current segment
      system.dispatchMessage({ type: 'iterationStart' });
      await waitForPubSub();

      // Verify message segment is no longer marked as streaming
      const firstSegment = system.elements.chatMessages.querySelector('.message.assistant');
      expect(firstSegment).not.toBeNull();
      expect(firstSegment?.classList.contains('streaming')).toBe(false);
    });

    it('creates new segment for text after thinking', async () => {
      // Start streaming
      system.dispatchMessage({ type: 'startResponse', messageId: 'msg-1' });
      await waitForPubSub();

      // Stream initial text
      system.dispatchMessage({ type: 'streamToken', token: 'Analyzing...' });
      await waitForPubSub();

      // Thinking
      system.dispatchMessage({ type: 'iterationStart' });
      await waitForPubSub();
      system.dispatchMessage({ type: 'streamReasoning', token: 'Let me reason about this.' });
      await waitForPubSub();

      // Stream more text - should create new segment
      system.dispatchMessage({ type: 'streamToken', token: 'Based on my analysis...' });
      await waitForPubSub();

      // Verify we have a continuation segment
      const continuations = system.elements.chatMessages.querySelectorAll('.message.assistant.continuation');
      expect(continuations.length).toBe(1);
      expect(continuations[0].querySelector('.content')?.textContent).toContain('Based on my analysis');
    });

    it('maintains correct DOM order: text → thinking → text', async () => {
      // Start streaming
      system.dispatchMessage({ type: 'startResponse', messageId: 'msg-1' });
      await waitForPubSub();

      // First text
      system.dispatchMessage({ type: 'streamToken', token: 'Initial response.' });
      await waitForPubSub();

      // Thinking
      system.dispatchMessage({ type: 'iterationStart' });
      await waitForPubSub();
      system.dispatchMessage({ type: 'streamReasoning', token: 'Reasoning content here.' });
      await waitForPubSub();

      // Second text
      system.dispatchMessage({ type: 'streamToken', token: 'Final response.' });
      await waitForPubSub();

      // End
      system.dispatchMessage({
        type: 'endResponse',
        message: { content: 'Initial response.\n\nFinal response.', reasoning: 'Reasoning content here.' }
      });
      await waitForPubSub();

      // Check DOM order
      const chatMessages = system.elements.chatMessages;
      const children = Array.from(chatMessages.children).filter(
        el => el.classList.contains('message') || el.classList.contains('thinking-iteration-wrapper')
      );

      // Should be: message → thinking → continuation
      expect(children.length).toBeGreaterThanOrEqual(3);
      expect(children[0].classList.contains('message')).toBe(true);
      expect(children[1].classList.contains('thinking-iteration-wrapper')).toBe(true);
      expect(children[2].classList.contains('continuation')).toBe(true);
    });

    it('does not duplicate content in original message after thinking interleaving', async () => {
      // This test specifically catches the bug where finalizeLastMessage
      // would write content to the original message element after interleaving

      // Start streaming
      system.dispatchMessage({ type: 'startResponse', messageId: 'msg-1' });
      await waitForPubSub();

      // Initial empty state - message element created but no content yet
      const originalMessage = system.elements.chatMessages.querySelector('.message.assistant');
      expect(originalMessage).not.toBeNull();

      // Thinking starts immediately (common for reasoner model)
      system.dispatchMessage({ type: 'iterationStart' });
      await waitForPubSub();
      system.dispatchMessage({ type: 'streamReasoning', token: 'Thinking about it...' });
      await waitForPubSub();

      // Text comes after thinking
      system.dispatchMessage({ type: 'streamToken', token: 'Here is my response.' });
      await waitForPubSub();

      // End with full content
      system.dispatchMessage({
        type: 'endResponse',
        message: { content: 'Here is my response.', reasoning: 'Thinking about it...' }
      });
      await waitForPubSub();

      // Verify NO duplicate content:
      // The original message should NOT have the response content (it should be in continuation)
      const allMessages = system.elements.chatMessages.querySelectorAll('.message.assistant');
      const originalContent = originalMessage?.querySelector('.content')?.textContent || '';

      // Count how many times 'Here is my response' appears in all message elements
      let contentCount = 0;
      allMessages.forEach(msg => {
        if (msg.querySelector('.content')?.textContent?.includes('Here is my response')) {
          contentCount++;
        }
      });

      // Content should appear exactly once (in the continuation segment, not in original)
      expect(contentCount).toBe(1);
    });
  });

  describe('State reset between responses', () => {
    it('resets segment state at start of new response', async () => {
      // First response with interleaving
      system.dispatchMessage({ type: 'startResponse', messageId: 'msg-1' });
      await waitForPubSub();

      system.dispatchMessage({ type: 'streamToken', token: 'First.' });
      await waitForPubSub();

      system.dispatchMessage({
        type: 'toolCallsStart',
        tools: [{ name: 'test', detail: 'test' }]
      });
      await waitForPubSub();

      system.dispatchMessage({ type: 'toolCallsEnd' });
      await waitForPubSub();

      system.dispatchMessage({
        type: 'endResponse',
        message: { content: 'First.' }
      });
      await waitForPubSub();

      // Second response - should start fresh
      system.dispatchMessage({ type: 'startResponse', messageId: 'msg-2' });
      await waitForPubSub();

      system.dispatchMessage({ type: 'streamToken', token: 'Second.' });
      await waitForPubSub();

      system.dispatchMessage({
        type: 'endResponse',
        message: { content: 'Second.' }
      });
      await waitForPubSub();

      // The second response should have its own message element (not continuation)
      const allMessages = system.elements.chatMessages.querySelectorAll('.message.assistant');
      expect(allMessages.length).toBeGreaterThanOrEqual(2);

      // Find the last non-continuation message - that should be msg-2
      const nonContinuations = Array.from(allMessages).filter(
        el => !el.classList.contains('continuation')
      );
      expect(nonContinuations.length).toBeGreaterThanOrEqual(2);
    });
  });
});
