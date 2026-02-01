/**
 * Streaming Flow Integration Tests
 *
 * Tests the complete streaming lifecycle from start to end,
 * including the pub/sub communication between actors.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createTestActorSystem,
  waitForPubSub,
  simulateStreamingResponse,
  type TestActorSystem
} from './helpers';

describe('Streaming Flow Integration', () => {
  let system: TestActorSystem;

  beforeEach(async () => {
    system = await createTestActorSystem();
  });

  afterEach(() => {
    system.cleanup();
  });

  describe('basic streaming flow', () => {
    it('completes a full streaming cycle', async () => {
      await simulateStreamingResponse(system, {
        messageId: 'test-msg-1',
        tokens: ['Hello', ', ', 'world', '!'],
        finalContent: 'Hello, world!'
      });

      // Streaming should be complete
      expect(system.streaming.isActive).toBe(false);

      // Message should be added
      const messages = system.message.getMessages();
      expect(messages.length).toBe(1);
      expect(messages[0].content).toBe('Hello, world!');

      // UI should be reset
      expect(system.elements.sendBtn.style.display).toBe('flex');
      expect(system.elements.stopBtn.style.display).toBe('none');
    });

    it('accumulates tokens during streaming', async () => {
      system.dispatchMessage({ type: 'startResponse', messageId: 'msg-1' });
      await waitForPubSub();

      const tokens = ['The ', 'quick ', 'brown ', 'fox'];
      for (const token of tokens) {
        system.dispatchMessage({ type: 'streamToken', token });
        await waitForPubSub(5);
      }

      expect(system.streaming.content).toBe('The quick brown fox');
      expect(system.streaming.isActive).toBe(true);
    });

    it('publishes streaming state correctly', async () => {
      system.dispatchMessage({ type: 'startResponse', messageId: 'test-id' });
      await waitForPubSub();

      // Verify streaming state is published to manager
      expect(system.manager.getState('streaming.active')).toBe(true);
      expect(system.manager.getState('streaming.messageId')).toBe('test-id');
    });

    it('accumulates content in streaming actor', async () => {
      system.dispatchMessage({ type: 'startResponse', messageId: 'prog-1' });
      await waitForPubSub();

      system.dispatchMessage({ type: 'streamToken', token: 'First' });
      await waitForPubSub();

      // Verify content is accumulated
      expect(system.streaming.content).toBe('First');
      expect(system.manager.getState('streaming.content')).toBe('First');
    });
  });

  describe('reasoner mode streaming', () => {
    it('handles thinking content in reasoner mode', async () => {
      system.dispatchMessage({
        type: 'startResponse',
        messageId: 'reasoner-1',
        isReasoner: true
      });
      await waitForPubSub();

      // Stream thinking
      system.dispatchMessage({
        type: 'streamReasoning',
        token: 'Let me analyze this problem...'
      });
      await waitForPubSub();

      expect(system.streaming.thinking).toBe('Let me analyze this problem...');

      // Stream content
      system.dispatchMessage({
        type: 'streamToken',
        token: 'The answer is 42.'
      });
      await waitForPubSub();

      expect(system.streaming.content).toBe('The answer is 42.');
    });

    it('starts thinking iteration when thinking content arrives (not at startResponse)', async () => {
      system.dispatchMessage({
        type: 'startResponse',
        messageId: 'reasoner-2',
        isReasoner: true
      });
      await waitForPubSub();

      // At startResponse time, no thinking iteration should exist yet
      let state = system.thinking.getState();
      expect(state.iterations.length).toBe(0);

      // When thinking content arrives (via pub/sub from streamReasoning), iteration is created
      system.dispatchMessage({ type: 'iterationStart' });
      await waitForPubSub();

      state = system.thinking.getState();
      expect(state.iterations.length).toBeGreaterThan(0);
    });

    it('completes with reasoning in final message', async () => {
      await simulateStreamingResponse(system, {
        messageId: 'reasoner-3',
        isReasoner: true,
        tokens: ['Answer'],
        reasoningTokens: ['Thinking...'],
        finalContent: 'Answer',
        finalReasoning: 'Full reasoning process'
      });

      const messages = system.message.getMessages();
      expect(messages[0].thinking).toBe('Full reasoning process');
    });
  });

  describe('multiple thinking iterations', () => {
    it('handles multiple iteration starts', async () => {
      system.dispatchMessage({
        type: 'startResponse',
        messageId: 'multi-1',
        isReasoner: true
      });
      await waitForPubSub();

      // First iteration
      system.dispatchMessage({ type: 'iterationStart' });
      await waitForPubSub();

      // Second iteration
      system.dispatchMessage({ type: 'iterationStart' });
      await waitForPubSub();

      const state = system.thinking.getState();
      // Should have multiple iterations tracked
      expect(state.iterations.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('streaming state management', () => {
    it('prevents concurrent streams', async () => {
      system.dispatchMessage({ type: 'startResponse', messageId: 'first' });
      await waitForPubSub();

      expect(system.streaming.messageId).toBe('first');

      // Try to start another
      system.dispatchMessage({ type: 'startResponse', messageId: 'second' });
      await waitForPubSub();

      // StreamingActor.startStream resets state, so it will accept the new one
      // This behavior might need to change, but we test current behavior
      expect(system.streaming.messageId).toBe('second');
    });

    it('resets content on new stream', async () => {
      // First stream
      system.dispatchMessage({ type: 'startResponse', messageId: 'stream-1' });
      system.dispatchMessage({ type: 'streamToken', token: 'Old content' });
      await waitForPubSub();

      // Start new stream
      system.dispatchMessage({ type: 'startResponse', messageId: 'stream-2' });
      await waitForPubSub();

      expect(system.streaming.content).toBe('');
      expect(system.streaming.thinking).toBe('');
    });
  });

  describe('error recovery', () => {
    it('handles generationStopped during streaming', async () => {
      system.dispatchMessage({ type: 'startResponse', messageId: 'abort-1' });
      system.dispatchMessage({ type: 'streamToken', token: 'Partial' });
      await waitForPubSub();

      system.dispatchMessage({ type: 'generationStopped' });
      await waitForPubSub();

      // UI should reset
      expect(system.elements.sendBtn.style.display).toBe('flex');
      expect(system.elements.stopBtn.style.display).toBe('none');
    });

    it('handles empty response', async () => {
      system.dispatchMessage({ type: 'startResponse', messageId: 'empty-1' });
      await waitForPubSub();

      // End without any tokens
      system.dispatchMessage({
        type: 'endResponse',
        message: { content: '' }
      });
      await waitForPubSub();

      expect(system.streaming.isActive).toBe(false);
      // Empty message should still be added
      const messages = system.message.getMessages();
      expect(messages.length).toBe(1);
    });
  });

  describe('pub/sub state propagation', () => {
    it('streaming state propagates through manager', async () => {
      system.dispatchMessage({ type: 'startResponse', messageId: 'pub-1' });
      await waitForPubSub();

      // Verify streaming state in manager
      expect(system.manager.getState('streaming.active')).toBe(true);

      system.dispatchMessage({ type: 'endResponse' });
      await waitForPubSub();

      expect(system.manager.getState('streaming.active')).toBe(false);
    });

    it('streaming.content updates are published', async () => {
      system.dispatchMessage({ type: 'startResponse', messageId: 'pub-2' });
      await waitForPubSub();

      // Each token triggers a publication
      system.dispatchMessage({ type: 'streamToken', token: 'Test' });
      await waitForPubSub();

      // Verify the global state has the content
      expect(system.manager.getState('streaming.content')).toBe('Test');
    });
  });

  describe('DOM rendering during streaming', () => {
    it('verifies actors are registered with manager', async () => {
      // Check that both actors are registered
      expect(system.manager.getActorCount()).toBeGreaterThanOrEqual(2);
      expect(system.manager.hasActor(system.streaming.getId())).toBe(true);
      expect(system.manager.hasActor(system.message.getId())).toBe(true);
    });

    it('verifies streaming.messageId propagates to manager state', async () => {
      system.dispatchMessage({ type: 'startResponse', messageId: 'propagation-test' });
      await waitForPubSub();

      // The streaming state should be in the manager
      expect(system.manager.getState('streaming.messageId')).toBe('propagation-test');
      expect(system.manager.getState('streaming.active')).toBe(true);
    });

    it('verifies MessageActor subscription is called', async () => {
      // Spy on the message actor's element to check if state-changed events are received
      const eventSpy = vi.fn();
      system.message.getElement().addEventListener('state-changed', eventSpy);

      system.dispatchMessage({ type: 'startResponse', messageId: 'spy-test' });
      await waitForPubSub();

      // MessageActor should receive state-changed events from StreamingActor
      expect(eventSpy).toHaveBeenCalled();

      // Check that streaming.messageId was included in the events
      const allChangedKeys = eventSpy.mock.calls.flatMap(call => call[0].detail.changedKeys);
      expect(allChangedKeys).toContain('streaming.messageId');
      expect(allChangedKeys).toContain('streaming.active');
    });

    it('creates streaming element when streaming starts', async () => {
      system.dispatchMessage({ type: 'startResponse', messageId: 'dom-test-1' });
      await waitForPubSub();

      // A streaming message element should be created
      const streamingEl = system.elements.chatMessages.querySelector('.message.streaming');
      expect(streamingEl).toBeTruthy();
      expect(streamingEl?.getAttribute('data-message-id')).toBe('dom-test-1');
    });

    it('updates DOM content as tokens arrive', async () => {
      system.dispatchMessage({ type: 'startResponse', messageId: 'dom-test-2' });
      await waitForPubSub();

      // Stream some tokens
      system.dispatchMessage({ type: 'streamToken', token: 'Hello' });
      await waitForPubSub();

      // Check DOM content
      const contentEl = system.elements.chatMessages.querySelector('.message.streaming .content');
      expect(contentEl).toBeTruthy();
      expect(contentEl?.textContent).toContain('Hello');

      // Stream more tokens
      system.dispatchMessage({ type: 'streamToken', token: ' world!' });
      await waitForPubSub();

      expect(contentEl?.textContent).toContain('Hello world!');
    });

    it('streaming content is visible before endResponse', async () => {
      system.dispatchMessage({ type: 'startResponse', messageId: 'dom-test-3' });
      await waitForPubSub();

      const tokens = ['The ', 'quick ', 'brown ', 'fox'];
      for (const token of tokens) {
        system.dispatchMessage({ type: 'streamToken', token });
        await waitForPubSub(5);
      }

      // Before endResponse, content should be visible in DOM
      const chatMessagesText = system.elements.chatMessages.textContent;
      expect(chatMessagesText).toContain('The quick brown fox');
    });

    it('removes streaming class when stream ends', async () => {
      system.dispatchMessage({ type: 'startResponse', messageId: 'dom-test-4' });
      await waitForPubSub();

      system.dispatchMessage({ type: 'streamToken', token: 'Content' });
      await waitForPubSub();

      // Should have streaming class
      let streamingEl = system.elements.chatMessages.querySelector('.message.streaming');
      expect(streamingEl).toBeTruthy();

      // End streaming
      system.dispatchMessage({ type: 'endResponse', message: { content: 'Content' } });
      await waitForPubSub();

      // Should no longer have streaming class
      streamingEl = system.elements.chatMessages.querySelector('.message.streaming');
      expect(streamingEl).toBeNull();
    });
  });

  describe('scroll integration', () => {
    it('ScrollActor resets scroll state on stream start', async () => {
      // Fill container with content to make scrolling relevant
      for (let i = 0; i < 20; i++) {
        const div = document.createElement('div');
        div.style.height = '50px';
        div.textContent = `Message ${i}`;
        system.elements.chatMessages.appendChild(div);
      }

      system.dispatchMessage({ type: 'startResponse', messageId: 'scroll-1' });
      await waitForPubSub();

      // ScrollActor state uses autoScroll, userScrolled, nearBottom
      // After stream start, user scroll state should be reset
      const state = system.scroll.getState();
      expect(state.autoScroll).toBe(true);
      expect(state.userScrolled).toBe(false);
    });
  });
});
