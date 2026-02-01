/**
 * Unit tests for InputAreaActor
 *
 * InputAreaActor wraps existing DOM elements (textarea, buttons, etc.)
 * instead of creating them, so we need to create the DOM structure first.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushMicrotasks } from '../../setup';
import { EventStateManager } from '../../../media/state/EventStateManager';
import { InputAreaActor } from '../../../media/actors/input-area/InputAreaActor';
import { StreamingActor } from '../../../media/actors/streaming/StreamingActor';

describe('InputAreaActor', () => {
  let manager: EventStateManager;
  let rootElement: HTMLElement;
  let streamingElement: HTMLElement;
  let inputAreaActor: InputAreaActor;
  let streamingActor: StreamingActor;
  let mockVSCode: { postMessage: ReturnType<typeof vi.fn> };

  // Create the DOM structure that InputAreaActor expects
  function createInputAreaDOM(): void {
    // Textarea
    const textarea = document.createElement('textarea');
    textarea.id = 'messageInput';
    document.body.appendChild(textarea);

    // Send button
    const sendBtn = document.createElement('button');
    sendBtn.id = 'sendBtn';
    sendBtn.style.display = 'flex';
    document.body.appendChild(sendBtn);

    // Stop button
    const stopBtn = document.createElement('button');
    stopBtn.id = 'stopBtn';
    stopBtn.style.display = 'none';
    document.body.appendChild(stopBtn);

    // Attach button
    const attachBtn = document.createElement('button');
    attachBtn.id = 'attachBtn';
    document.body.appendChild(attachBtn);

    // File input
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.id = 'fileInput';
    document.body.appendChild(fileInput);

    // Attachments container
    const attachments = document.createElement('div');
    attachments.id = 'attachments';
    document.body.appendChild(attachments);

    // File chips container
    const fileChipsContainer = document.createElement('div');
    fileChipsContainer.id = 'fileChipsContainer';
    document.body.appendChild(fileChipsContainer);

    // File chips
    const fileChips = document.createElement('div');
    fileChips.id = 'fileChips';
    document.body.appendChild(fileChips);
  }

  beforeEach(() => {
    // Reset styles injection
    StreamingActor.resetStylesInjected();

    manager = new EventStateManager();
    mockVSCode = { postMessage: vi.fn() };

    // Create DOM structure that InputAreaActor wraps
    createInputAreaDOM();

    // Create root element for InputAreaActor (hidden, just for registration)
    rootElement = document.createElement('div');
    rootElement.id = 'input-area-root';
    document.body.appendChild(rootElement);

    // Create streaming element for streaming actor
    streamingElement = document.createElement('div');
    streamingElement.id = 'streaming-root';
    document.body.appendChild(streamingElement);

    // Create actors
    streamingActor = new StreamingActor(manager, streamingElement);
    inputAreaActor = new InputAreaActor(manager, rootElement, mockVSCode);
  });

  afterEach(() => {
    inputAreaActor.destroy();
    streamingActor.destroy();
    document.body.innerHTML = '';
  });

  describe('initialization', () => {
    it('binds to existing DOM elements', () => {
      const state = inputAreaActor.getState();
      expect(state).toBeDefined();
      expect(state.value).toBe('');
      expect(state.submitting).toBe(false);
      expect(state.streaming).toBe(false);
    });

    it('starts with empty state', () => {
      const state = inputAreaActor.getState();
      expect(state.value).toBe('');
      expect(state.attachments).toEqual([]);
    });
  });

  describe('input handling', () => {
    it('updates value when textarea changes', () => {
      const textarea = document.getElementById('messageInput') as HTMLTextAreaElement;
      textarea.value = 'Hello World';
      textarea.dispatchEvent(new Event('input'));

      expect(inputAreaActor.getValue()).toBe('Hello World');
    });

    it('can set value programmatically', () => {
      inputAreaActor.setValue('Test message');
      const textarea = document.getElementById('messageInput') as HTMLTextAreaElement;
      expect(textarea.value).toBe('Test message');
      expect(inputAreaActor.getValue()).toBe('Test message');
    });

    it('clears value after submit', async () => {
      const sendHandler = vi.fn();
      inputAreaActor.onSend(sendHandler);

      const textarea = document.getElementById('messageInput') as HTMLTextAreaElement;
      textarea.value = 'Test message';
      textarea.dispatchEvent(new Event('input'));

      const sendBtn = document.getElementById('sendBtn') as HTMLButtonElement;
      sendBtn.click();

      await flushMicrotasks();

      expect(sendHandler).toHaveBeenCalledWith('Test message', undefined);
      expect(inputAreaActor.getValue()).toBe('');
    });
  });

  describe('submit handling', () => {
    it('calls onSend handler when send button clicked', () => {
      const sendHandler = vi.fn();
      inputAreaActor.onSend(sendHandler);

      const textarea = document.getElementById('messageInput') as HTMLTextAreaElement;
      textarea.value = 'Hello';
      textarea.dispatchEvent(new Event('input'));

      const sendBtn = document.getElementById('sendBtn') as HTMLButtonElement;
      sendBtn.click();

      expect(sendHandler).toHaveBeenCalledWith('Hello', undefined);
    });

    it('submits on Enter key (without Shift)', () => {
      const sendHandler = vi.fn();
      inputAreaActor.onSend(sendHandler);

      const textarea = document.getElementById('messageInput') as HTMLTextAreaElement;
      textarea.value = 'Test';
      textarea.dispatchEvent(new Event('input'));

      const enterEvent = new KeyboardEvent('keydown', {
        key: 'Enter',
        shiftKey: false
      });
      textarea.dispatchEvent(enterEvent);

      expect(sendHandler).toHaveBeenCalledWith('Test', undefined);
    });

    it('does not submit on Shift+Enter', () => {
      const sendHandler = vi.fn();
      inputAreaActor.onSend(sendHandler);

      const textarea = document.getElementById('messageInput') as HTMLTextAreaElement;
      textarea.value = 'Test';
      textarea.dispatchEvent(new Event('input'));

      const enterEvent = new KeyboardEvent('keydown', {
        key: 'Enter',
        shiftKey: true
      });
      textarea.dispatchEvent(enterEvent);

      expect(sendHandler).not.toHaveBeenCalled();
    });

    it('does not submit empty message', () => {
      const sendHandler = vi.fn();
      inputAreaActor.onSend(sendHandler);

      const sendBtn = document.getElementById('sendBtn') as HTMLButtonElement;
      sendBtn.click();

      expect(sendHandler).not.toHaveBeenCalled();
    });
  });

  describe('stop handling', () => {
    it('calls onStop handler when stop button clicked', () => {
      const stopHandler = vi.fn();
      inputAreaActor.onStop(stopHandler);

      const stopBtn = document.getElementById('stopBtn') as HTMLButtonElement;
      stopBtn.click();

      expect(stopHandler).toHaveBeenCalled();
    });

    it('posts stopGeneration message to VS Code', () => {
      const stopBtn = document.getElementById('stopBtn') as HTMLButtonElement;
      stopBtn.click();

      expect(mockVSCode.postMessage).toHaveBeenCalledWith({ type: 'stopGeneration' });
    });
  });

  describe('streaming state', () => {
    it('responds to streaming.active changes', async () => {
      const sendBtn = document.getElementById('sendBtn') as HTMLButtonElement;
      const stopBtn = document.getElementById('stopBtn') as HTMLButtonElement;

      // Start streaming
      streamingActor.startStream('msg-1');
      await flushMicrotasks();

      expect(inputAreaActor.isStreaming()).toBe(true);
      expect(sendBtn.style.display).toBe('none');
      expect(stopBtn.style.display).toBe('flex');

      // End streaming
      streamingActor.endStream();
      await flushMicrotasks();

      expect(inputAreaActor.isStreaming()).toBe(false);
      expect(sendBtn.style.display).toBe('flex');
      expect(stopBtn.style.display).toBe('none');
    });
  });

  describe('mid-stream interrupt', () => {
    it('queues message when submitted during streaming', async () => {
      const sendHandler = vi.fn();
      inputAreaActor.onSend(sendHandler);

      // Start streaming
      streamingActor.startStream('msg-1');
      await flushMicrotasks();

      // Try to send during streaming
      const textarea = document.getElementById('messageInput') as HTMLTextAreaElement;
      textarea.value = 'Interrupt message';
      textarea.dispatchEvent(new Event('input'));

      const sendBtn = document.getElementById('sendBtn') as HTMLButtonElement;
      sendBtn.click();

      // Handler should NOT be called yet (message is queued)
      expect(sendHandler).not.toHaveBeenCalled();
      expect(inputAreaActor.hasPendingInterrupt()).toBe(true);

      // Input should be cleared immediately for UX
      expect(inputAreaActor.getValue()).toBe('');
    });

    it('sends queued message when streaming ends', async () => {
      const sendHandler = vi.fn();
      inputAreaActor.onSend(sendHandler);

      // Start streaming
      streamingActor.startStream('msg-1');
      await flushMicrotasks();

      // Queue a message during streaming
      inputAreaActor.setValue('Interrupt message');
      const sendBtn = document.getElementById('sendBtn') as HTMLButtonElement;
      sendBtn.click();

      // End streaming
      streamingActor.endStream();
      await flushMicrotasks();

      // Wait for the delayed send
      await new Promise(resolve => setTimeout(resolve, 150));

      expect(sendHandler).toHaveBeenCalledWith('Interrupt message', undefined);
      expect(inputAreaActor.hasPendingInterrupt()).toBe(false);
    });

    it('adds interrupting class to send button during interrupt', async () => {
      // Start streaming
      streamingActor.startStream('msg-1');
      await flushMicrotasks();

      // Queue a message during streaming
      inputAreaActor.setValue('Interrupt');
      const sendBtn = document.getElementById('sendBtn') as HTMLButtonElement;
      sendBtn.click();

      expect(sendBtn.classList.contains('interrupting')).toBe(true);
    });

    it('removes interrupting class when streaming ends', async () => {
      // Start streaming
      streamingActor.startStream('msg-1');
      await flushMicrotasks();

      // Queue a message
      inputAreaActor.setValue('Interrupt');
      const sendBtn = document.getElementById('sendBtn') as HTMLButtonElement;
      sendBtn.click();

      // End streaming
      streamingActor.endStream();
      await flushMicrotasks();

      expect(sendBtn.classList.contains('interrupting')).toBe(false);
    });
  });

  describe('focus', () => {
    it('can focus the textarea', () => {
      const focusSpy = vi.spyOn(document.getElementById('messageInput')!, 'focus');
      inputAreaActor.focus();
      expect(focusSpy).toHaveBeenCalled();
    });
  });

  describe('file chips', () => {
    it('updates file chips display', () => {
      const files = new Map([
        ['file1.ts', 'content1'],
        ['file2.ts', 'content2']
      ]);

      inputAreaActor.updateFileChips(files);

      const fileChipsContainer = document.getElementById('fileChipsContainer') as HTMLElement;
      const fileChips = document.getElementById('fileChips') as HTMLElement;

      expect(fileChipsContainer.style.display).toBe('flex');
      expect(fileChips.querySelectorAll('.file-chip').length).toBe(2);
    });

    it('hides file chips when empty', () => {
      inputAreaActor.updateFileChips(new Map());

      const fileChipsContainer = document.getElementById('fileChipsContainer') as HTMLElement;
      expect(fileChipsContainer.style.display).toBe('none');
    });
  });
});
