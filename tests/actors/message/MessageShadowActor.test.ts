/**
 * Tests for MessageShadowActor
 *
 * Tests Shadow DOM encapsulation, message rendering,
 * streaming support, and interleaving functionality.
 *
 * Architecture: MessageShadowActor extends InterleavedShadowActor.
 * Each message gets its own shadow container as a child of the parent element.
 * This allows proper interleaving with thinking/shell content.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MessageShadowActor } from '../../../media/actors/message/MessageShadowActor';
import { EventStateManager } from '../../../media/state/EventStateManager';
import { InterleavedShadowActor } from '../../../media/state/InterleavedShadowActor';

describe('MessageShadowActor', () => {
  let manager: EventStateManager;
  let element: HTMLElement;
  let actor: MessageShadowActor;

  /**
   * Helper to find a message container by role (user/assistant).
   * With InterleavedShadowActor, each message has its own shadow host.
   */
  function findMessageContainer(role: 'user' | 'assistant' | 'streaming'): HTMLElement | null {
    const selector = role === 'streaming'
      ? '[data-actor="message"].streaming'
      : `[data-actor="message"].${role}`;
    return element.querySelector(selector);
  }

  /**
   * Helper to query inside a message's shadow DOM.
   */
  function queryInMessageShadow(role: 'user' | 'assistant' | 'streaming', selector: string): Element | null {
    const container = findMessageContainer(role);
    return container?.shadowRoot?.querySelector(selector) ?? null;
  }

  beforeEach(() => {
    manager = new EventStateManager();
    element = document.createElement('div');
    element.id = 'chat-messages';
    document.body.appendChild(element);
    InterleavedShadowActor.resetInstanceCount();
  });

  afterEach(() => {
    actor?.destroy();
    document.body.innerHTML = '';
  });

  describe('InterleavedShadowActor architecture', () => {
    it('marks parent with data-interleaved-actor attribute', () => {
      actor = new MessageShadowActor(manager, element);
      expect(element.getAttribute('data-interleaved-actor')).toBe('message');
    });

    it('creates no containers initially', () => {
      actor = new MessageShadowActor(manager, element);
      expect(element.children.length).toBe(0);
    });

    it('each message gets its own shadow container', () => {
      actor = new MessageShadowActor(manager, element);
      actor.addUserMessage('First');
      actor.addAssistantMessage('Second');

      expect(element.children.length).toBe(2);
      expect(element.children[0].shadowRoot).toBeTruthy();
      expect(element.children[1].shadowRoot).toBeTruthy();
    });

    it('injects styles into each message shadow', () => {
      actor = new MessageShadowActor(manager, element);
      actor.addUserMessage('Test');

      const container = findMessageContainer('user');
      const style = container?.shadowRoot?.querySelector('style');
      expect(style).toBeTruthy();
      expect(style?.textContent).toContain('.message');
    });
  });

  describe('User messages', () => {
    beforeEach(() => {
      actor = new MessageShadowActor(manager, element);
    });

    it('adds user message to DOM', () => {
      actor.addUserMessage('Hello world');

      const message = queryInMessageShadow('user', '.message.user');
      expect(message).toBeTruthy();
      expect(message?.querySelector('.content')?.textContent).toContain('Hello world');
    });

    it('returns message ID', () => {
      const id = actor.addUserMessage('Test');
      expect(id).toMatch(/^msg-user-/);
    });

    it('displays file attachments', () => {
      actor.addUserMessage('Check these files', ['file1.ts', 'file2.ts']);

      const container = findMessageContainer('user');
      const files = container?.shadowRoot?.querySelectorAll('.file-tag');
      expect(files?.length).toBe(2);
    });

    it('publishes state after adding message', async () => {
      const received: unknown[] = [];
      const subscriberEl = document.createElement('div');
      subscriberEl.id = 'subscriber';
      document.body.appendChild(subscriberEl);

      subscriberEl.addEventListener('state-changed', ((e: CustomEvent) => {
        if (e.detail.state['message.count'] !== undefined) {
          received.push(e.detail.state['message.count']);
        }
      }) as EventListener);

      manager.register({
        actorId: 'subscriber',
        element: subscriberEl,
        publicationKeys: [],
        subscriptionKeys: ['message.*']
      }, {});

      actor.addUserMessage('Test');
      await Promise.resolve();

      expect(received).toContain(1);
    });
  });

  describe('Assistant messages', () => {
    beforeEach(() => {
      actor = new MessageShadowActor(manager, element);
    });

    it('adds assistant message to DOM', () => {
      actor.addAssistantMessage('Hello from AI');

      const message = queryInMessageShadow('assistant', '.message.assistant');
      expect(message).toBeTruthy();
      expect(message?.querySelector('.content')?.textContent).toContain('Hello from AI');
    });

    it('uses custom ID when provided', () => {
      const id = actor.addAssistantMessage('Test', { id: 'custom-id' });
      expect(id).toBe('custom-id');
    });
  });

  describe('Streaming messages', () => {
    beforeEach(() => {
      actor = new MessageShadowActor(manager, element);
    });

    it('creates streaming message on messageId change', async () => {
      // Wait for actor registration
      await Promise.resolve();
      await Promise.resolve();

      manager.handleStateChange({
        source: 'streaming-actor',
        state: { 'streaming.messageId': 'stream-1' },
        changedKeys: ['streaming.messageId'],
        publicationChain: [],
        timestamp: Date.now()
      });

      // With InterleavedShadowActor, the streaming class is on the host element
      const container = findMessageContainer('streaming');
      expect(container).toBeTruthy();
      const message = container?.shadowRoot?.querySelector('.message');
      expect(message).toBeTruthy();
    });

    it('updates streaming message content', async () => {
      await Promise.resolve();
      await Promise.resolve();

      manager.handleStateChange({
        source: 'streaming-actor',
        state: { 'streaming.messageId': 'stream-1' },
        changedKeys: ['streaming.messageId'],
        publicationChain: [],
        timestamp: Date.now()
      });

      manager.handleStateChange({
        source: 'streaming-actor',
        state: { 'streaming.content': 'Streaming content...' },
        changedKeys: ['streaming.content'],
        publicationChain: [],
        timestamp: Date.now()
      });

      const container = findMessageContainer('streaming');
      const content = container?.shadowRoot?.querySelector('.message .content');
      expect(content?.textContent).toContain('Streaming content...');
    });

    it('removes streaming class when streaming ends', async () => {
      await Promise.resolve();
      await Promise.resolve();

      manager.handleStateChange({
        source: 'streaming-actor',
        state: { 'streaming.messageId': 'stream-1' },
        changedKeys: ['streaming.messageId'],
        publicationChain: [],
        timestamp: Date.now()
      });

      manager.handleStateChange({
        source: 'streaming-actor',
        state: { 'streaming.active': false },
        changedKeys: ['streaming.active'],
        publicationChain: [],
        timestamp: Date.now()
      });

      // Streaming class should be removed from host
      const streamingContainer = findMessageContainer('streaming');
      expect(streamingContainer).toBeNull();
    });
  });

  describe('Interleaving support', () => {
    beforeEach(() => {
      actor = new MessageShadowActor(manager, element);
    });

    it('reports streaming state', async () => {
      await Promise.resolve();
      await Promise.resolve();

      expect(actor.isStreaming()).toBe(false);

      manager.handleStateChange({
        source: 'streaming-actor',
        state: { 'streaming.messageId': 'stream-1' },
        changedKeys: ['streaming.messageId'],
        publicationChain: [],
        timestamp: Date.now()
      });

      expect(actor.isStreaming()).toBe(true);
    });

    it('finalizes current segment', async () => {
      await Promise.resolve();
      await Promise.resolve();

      manager.handleStateChange({
        source: 'streaming-actor',
        state: { 'streaming.messageId': 'stream-1' },
        changedKeys: ['streaming.messageId'],
        publicationChain: [],
        timestamp: Date.now()
      });

      actor.finalizeCurrentSegment();
      expect(actor.needsNewSegment()).toBe(true);
    });

    it('resumes with new segment creating new shadow container', async () => {
      await Promise.resolve();
      await Promise.resolve();

      manager.handleStateChange({
        source: 'streaming-actor',
        state: { 'streaming.messageId': 'stream-1' },
        changedKeys: ['streaming.messageId'],
        publicationChain: [],
        timestamp: Date.now()
      });

      // Should have 1 container initially
      expect(element.querySelectorAll('[data-actor="message"]').length).toBe(1);

      actor.finalizeCurrentSegment();
      actor.resumeWithNewSegment();

      // Now should have 2 containers (original + continuation)
      expect(element.querySelectorAll('[data-actor="message"]').length).toBe(2);

      // The new container should have continuation class
      const continuations = element.querySelectorAll('[data-actor="message"].continuation');
      expect(continuations.length).toBe(1);
    });

    it('updates segment content directly', async () => {
      await Promise.resolve();
      await Promise.resolve();

      manager.handleStateChange({
        source: 'streaming-actor',
        state: { 'streaming.messageId': 'stream-1' },
        changedKeys: ['streaming.messageId'],
        publicationChain: [],
        timestamp: Date.now()
      });

      actor.updateCurrentSegmentContent('Direct content');
      expect(actor.getCurrentSegmentContent()).toBe('Direct content');
    });
  });

  describe('Code blocks', () => {
    beforeEach(() => {
      actor = new MessageShadowActor(manager, element);
    });

    it('renders fenced code blocks', () => {
      actor.addAssistantMessage('```typescript\nconst x = 1;\n```');

      const container = findMessageContainer('assistant');
      const codeBlock = container?.shadowRoot?.querySelector('.code-block');
      expect(codeBlock).toBeTruthy();
      expect(codeBlock?.querySelector('code')?.textContent).toContain('const x = 1;');
    });

    it('shows language label', () => {
      actor.addAssistantMessage('```javascript\nlet y = 2;\n```');

      const container = findMessageContainer('assistant');
      const lang = container?.shadowRoot?.querySelector('.code-lang');
      expect(lang?.textContent).toBe('javascript');
    });

    it('includes copy button', () => {
      actor.addAssistantMessage('```python\nprint("hello")\n```');

      const container = findMessageContainer('assistant');
      const copyBtn = container?.shadowRoot?.querySelector('.copy-btn');
      expect(copyBtn).toBeTruthy();
    });

    it('includes collapse toggle', () => {
      actor.addAssistantMessage('```rust\nfn main() {}\n```');

      const container = findMessageContainer('assistant');
      const toggleBtn = container?.shadowRoot?.querySelector('.collapse-toggle-btn');
      expect(toggleBtn).toBeTruthy();
    });

    it('collapses code blocks when edit mode is ask/auto', () => {
      actor.setEditMode('ask');
      actor.addAssistantMessage('```typescript\nconst x = 1;\n```');

      const container = findMessageContainer('assistant');
      const codeBlock = container?.shadowRoot?.querySelector('.code-block');
      expect(codeBlock?.classList.contains('collapsed')).toBe(true);
    });
  });

  describe('Edit mode', () => {
    beforeEach(() => {
      actor = new MessageShadowActor(manager, element);
    });

    it('starts in manual mode', () => {
      expect(actor.getEditMode()).toBe('manual');
    });

    it('can change edit mode', () => {
      actor.setEditMode('auto');
      expect(actor.getEditMode()).toBe('auto');
    });
  });

  describe('Message management', () => {
    beforeEach(() => {
      actor = new MessageShadowActor(manager, element);
    });

    it('gets all messages', () => {
      actor.addUserMessage('User message');
      actor.addAssistantMessage('Assistant message');

      const messages = actor.getMessages();
      expect(messages.length).toBe(2);
    });

    it('clears all messages and containers', () => {
      actor.addUserMessage('Message 1');
      actor.addAssistantMessage('Message 2');

      actor.clear();

      expect(actor.getMessages().length).toBe(0);
      // With InterleavedShadowActor, containers are children of element
      expect(element.children.length).toBe(0);
    });
  });

  describe('State', () => {
    beforeEach(() => {
      actor = new MessageShadowActor(manager, element);
    });

    it('tracks message state correctly', () => {
      const id = actor.addUserMessage('Test');

      const messages = actor.getMessages();
      expect(messages.length).toBe(1);
      expect(id).toMatch(/^msg-user-/);
      expect(actor.isStreaming()).toBe(false);
    });
  });

  describe('Finalize message', () => {
    beforeEach(() => {
      actor = new MessageShadowActor(manager, element);
    });

    it('updates content of last assistant message', () => {
      actor.addAssistantMessage('Initial');
      actor.finalizeLastMessage({ content: 'Updated content' });

      const container = findMessageContainer('assistant');
      const content = container?.shadowRoot?.querySelector('.message.assistant .content');
      expect(content?.textContent).toContain('Updated content');
    });
  });

  describe('Lifecycle', () => {
    it('cleans up on destroy', () => {
      actor = new MessageShadowActor(manager, element);
      actor.addUserMessage('Test');

      actor.destroy();

      expect(actor.getMessages().length).toBe(0);
    });
  });
});
