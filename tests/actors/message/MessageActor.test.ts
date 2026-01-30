/**
 * Unit tests for MessageActor
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushMicrotasks } from '../../setup';
import { EventStateManager } from '../../../media/state/EventStateManager';
import { MessageActor } from '../../../media/actors/message/MessageActor';
import { StreamingActor } from '../../../media/actors/streaming/StreamingActor';

describe('MessageActor', () => {
  let manager: EventStateManager;
  let messagesElement: HTMLElement;
  let streamingElement: HTMLElement;
  let messageActor: MessageActor;
  let streamingActor: StreamingActor;

  beforeEach(() => {
    // Reset styles injection
    MessageActor.resetStylesInjected();
    StreamingActor.resetStylesInjected();

    manager = new EventStateManager();

    // Create elements
    messagesElement = document.createElement('div');
    messagesElement.id = 'chat-messages';
    document.body.appendChild(messagesElement);

    streamingElement = document.createElement('div');
    streamingElement.id = 'streaming-root';
    document.body.appendChild(streamingElement);

    // Create actors - streaming first since message subscribes to it
    streamingActor = new StreamingActor(manager, streamingElement);
    messageActor = new MessageActor(manager, messagesElement);
  });

  afterEach(() => {
    messageActor.destroy();
    streamingActor.destroy();
    document.body.innerHTML = '';
  });

  describe('initialization', () => {
    it('registers with the manager', async () => {
      await flushMicrotasks();
      expect(manager.hasActor('chat-messages-MessageActor')).toBe(true);
    });

    it('starts with empty state', () => {
      const state = messageActor.getState();
      expect(state.count).toBe(0);
      expect(state.lastId).toBe(null);
      expect(state.streaming).toBe(false);
    });

    it('injects styles into document head', () => {
      const styleTag = document.querySelector('style[data-actor="message"]');
      expect(styleTag).toBeTruthy();
    });
  });

  describe('addUserMessage', () => {
    it('adds a user message to the DOM', () => {
      messageActor.addUserMessage('Hello, world!');

      const messageEl = messagesElement.querySelector('.message.user');
      expect(messageEl).toBeTruthy();
      expect(messageEl?.textContent).toContain('Hello, world!');
    });

    it('displays the user role', () => {
      messageActor.addUserMessage('Test');

      const roleEl = messagesElement.querySelector('.message.user .role');
      expect(roleEl?.textContent).toBe('YOU');
    });

    it('returns the message ID', () => {
      const id = messageActor.addUserMessage('Test');
      expect(id).toMatch(/^msg-user-/);
    });

    it('updates message count', () => {
      messageActor.addUserMessage('Test');
      expect(messageActor.getState().count).toBe(1);
    });

    it('renders attached files', () => {
      messageActor.addUserMessage('Check this file', ['document.pdf', 'image.png']);

      const fileTags = messagesElement.querySelectorAll('.message-file-tag');
      expect(fileTags.length).toBe(2);
      expect(fileTags[0].textContent).toContain('document.pdf');
      expect(fileTags[1].textContent).toContain('image.png');
    });
  });

  describe('addAssistantMessage', () => {
    it('adds an assistant message to the DOM', () => {
      messageActor.addAssistantMessage('I can help with that.');

      const messageEl = messagesElement.querySelector('.message.assistant');
      expect(messageEl).toBeTruthy();
      expect(messageEl?.textContent).toContain('I can help with that.');
    });

    it('displays the assistant role', () => {
      messageActor.addAssistantMessage('Test');

      const roleEl = messagesElement.querySelector('.message.assistant .role');
      expect(roleEl?.textContent).toBe('DEEPSEEK MOBY');
    });

    it('renders thinking content', () => {
      messageActor.addAssistantMessage('The answer is 42.', {
        thinking: 'Let me calculate this step by step...'
      });

      const thinkingEl = messagesElement.querySelector('.thinking-content');
      expect(thinkingEl).toBeTruthy();
      expect(thinkingEl?.textContent).toContain('Let me calculate');
    });
  });

  describe('streaming integration', () => {
    it('creates message element when streaming starts', async () => {
      streamingActor.startStream('msg-123');

      // Wait for microtask (deferred registration) and pub/sub
      await new Promise(resolve => setTimeout(resolve, 10));

      const streamingMessage = messagesElement.querySelector('.message.streaming');
      expect(streamingMessage).toBeTruthy();
    });

    it('updates content during streaming', async () => {
      streamingActor.startStream('msg-123');
      await new Promise(resolve => setTimeout(resolve, 10));

      streamingActor.handleContentChunk('Hello ');
      await new Promise(resolve => setTimeout(resolve, 10));

      const contentEl = messagesElement.querySelector('.message.streaming .content');
      expect(contentEl?.textContent).toContain('Hello');

      streamingActor.handleContentChunk('world!');
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(contentEl?.textContent).toContain('Hello world!');
    });

    it('removes streaming class when stream ends', async () => {
      streamingActor.startStream('msg-123');
      await new Promise(resolve => setTimeout(resolve, 10));

      streamingActor.handleContentChunk('Complete message');
      streamingActor.endStream();
      await new Promise(resolve => setTimeout(resolve, 10));

      const streamingMessage = messagesElement.querySelector('.message.streaming');
      expect(streamingMessage).toBeFalsy();

      const finalMessage = messagesElement.querySelector('.message.assistant');
      expect(finalMessage).toBeTruthy();
    });

    it('stores message in internal state', async () => {
      streamingActor.startStream('msg-123');
      await new Promise(resolve => setTimeout(resolve, 10));

      streamingActor.handleContentChunk('Test content');
      await new Promise(resolve => setTimeout(resolve, 10));

      const message = messageActor.getMessage('msg-123');
      expect(message).toBeTruthy();
      expect(message?.content).toBe('Test content');
    });
  });

  describe('clear', () => {
    it('removes all messages from DOM', () => {
      messageActor.addUserMessage('Message 1');
      messageActor.addAssistantMessage('Message 2');

      messageActor.clear();

      expect(messagesElement.innerHTML).toBe('');
    });

    it('resets message count', () => {
      messageActor.addUserMessage('Test');
      messageActor.clear();

      expect(messageActor.getState().count).toBe(0);
    });
  });

  describe('getMessage', () => {
    it('retrieves message by ID', () => {
      const id = messageActor.addUserMessage('Find me!');

      const message = messageActor.getMessage(id);
      expect(message).toBeTruthy();
      expect(message?.content).toBe('Find me!');
    });

    it('returns undefined for unknown ID', () => {
      const message = messageActor.getMessage('unknown-id');
      expect(message).toBeUndefined();
    });
  });

  describe('getMessages', () => {
    it('returns all messages', () => {
      messageActor.addUserMessage('First');
      messageActor.addAssistantMessage('Second');
      messageActor.addUserMessage('Third');

      const messages = messageActor.getMessages();
      expect(messages.length).toBe(3);
    });

    it('returns a copy (not internal array)', () => {
      messageActor.addUserMessage('Test');

      const messages = messageActor.getMessages();
      messages.push({ id: 'fake', role: 'user', content: 'Fake', timestamp: 0 });

      expect(messageActor.getState().count).toBe(1);
    });
  });

  describe('HTML escaping', () => {
    it('escapes HTML in user messages', () => {
      messageActor.addUserMessage('<script>alert("xss")</script>');

      const contentEl = messagesElement.querySelector('.message.user .content');
      expect(contentEl?.innerHTML).not.toContain('<script>');
      expect(contentEl?.textContent).toContain('<script>');
    });

    it('escapes HTML in file names', () => {
      messageActor.addUserMessage('Test', ['<img src=x onerror=alert(1)>']);

      const fileTag = messagesElement.querySelector('.message-file-tag');
      expect(fileTag?.innerHTML).not.toContain('<img');
    });
  });
});
