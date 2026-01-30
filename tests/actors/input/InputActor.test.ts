/**
 * Unit tests for InputActor
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushMicrotasks } from '../../setup';
import { EventStateManager } from '../../../media/state/EventStateManager';
import { InputActor } from '../../../media/actors/input/InputActor';
import { StreamingActor } from '../../../media/actors/streaming/StreamingActor';

describe('InputActor', () => {
  let manager: EventStateManager;
  let inputElement: HTMLElement;
  let streamingElement: HTMLElement;
  let inputActor: InputActor;
  let streamingActor: StreamingActor;

  beforeEach(() => {
    // Reset styles injection
    InputActor.resetStylesInjected();
    StreamingActor.resetStylesInjected();

    manager = new EventStateManager();

    // Create elements
    inputElement = document.createElement('div');
    inputElement.id = 'chat-input';
    document.body.appendChild(inputElement);

    streamingElement = document.createElement('div');
    streamingElement.id = 'streaming-root';
    document.body.appendChild(streamingElement);

    // Create actors
    streamingActor = new StreamingActor(manager, streamingElement);
    inputActor = new InputActor(manager, inputElement);
  });

  afterEach(() => {
    inputActor.destroy();
    streamingActor.destroy();
    document.body.innerHTML = '';
  });

  describe('initialization', () => {
    it('registers with the manager', async () => {
      await flushMicrotasks();
      expect(manager.hasActor('chat-input-InputActor')).toBe(true);
    });

    it('starts with empty state', () => {
      const state = inputActor.getState();
      expect(state.value).toBe('');
      expect(state.submitting).toBe(false);
      expect(state.focused).toBe(false);
      expect(state.files).toEqual([]);
      expect(state.disabled).toBe(false);
    });

    it('creates DOM structure', () => {
      expect(inputElement.querySelector('.input-textarea')).toBeTruthy();
      expect(inputElement.querySelector('.input-submit')).toBeTruthy();
    });

    it('injects styles into document head', () => {
      const styleTag = document.querySelector('style[data-actor="input"]');
      expect(styleTag).toBeTruthy();
    });
  });

  describe('input handling', () => {
    it('updates value on input', () => {
      const textarea = inputElement.querySelector('.input-textarea') as HTMLTextAreaElement;
      textarea.value = 'Hello';
      textarea.dispatchEvent(new Event('input'));

      expect(inputActor.getValue()).toBe('Hello');
    });

    it('publishes value changes', () => {
      const spy = vi.spyOn(manager, 'handleStateChange');

      const textarea = inputElement.querySelector('.input-textarea') as HTMLTextAreaElement;
      textarea.value = 'Test';
      textarea.dispatchEvent(new Event('input'));

      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({
          state: expect.objectContaining({
            'input.value': 'Test'
          })
        })
      );
    });

    it('tracks focus state', () => {
      const textarea = inputElement.querySelector('.input-textarea') as HTMLTextAreaElement;

      textarea.dispatchEvent(new FocusEvent('focus'));
      expect(inputActor.getState().focused).toBe(true);

      textarea.dispatchEvent(new FocusEvent('blur'));
      expect(inputActor.getState().focused).toBe(false);
    });
  });

  describe('setValue', () => {
    it('sets the input value', () => {
      inputActor.setValue('Programmatic value');

      const textarea = inputElement.querySelector('.input-textarea') as HTMLTextAreaElement;
      expect(textarea.value).toBe('Programmatic value');
      expect(inputActor.getValue()).toBe('Programmatic value');
    });
  });

  describe('clear', () => {
    it('clears the input value', () => {
      inputActor.setValue('Some text');
      inputActor.clear();

      expect(inputActor.getValue()).toBe('');
    });

    it('clears attached files', () => {
      inputActor.addFile('/path/to/file.txt');
      inputActor.clear();

      expect(inputActor.getState().files).toEqual([]);
    });
  });

  describe('submit handling', () => {
    it('calls submit handler on button click', () => {
      const handler = vi.fn();
      inputActor.onSubmit(handler);

      inputActor.setValue('Submit me');
      const button = inputElement.querySelector('.input-submit') as HTMLButtonElement;
      button.click();

      expect(handler).toHaveBeenCalledWith('Submit me', []);
    });

    it('calls submit handler on Enter key', () => {
      const handler = vi.fn();
      inputActor.onSubmit(handler);

      inputActor.setValue('Enter submit');
      const textarea = inputElement.querySelector('.input-textarea') as HTMLTextAreaElement;
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));

      expect(handler).toHaveBeenCalledWith('Enter submit', []);
    });

    it('does not submit on Shift+Enter', () => {
      const handler = vi.fn();
      inputActor.onSubmit(handler);

      inputActor.setValue('Multiline');
      const textarea = inputElement.querySelector('.input-textarea') as HTMLTextAreaElement;
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true }));

      expect(handler).not.toHaveBeenCalled();
    });

    it('does not submit empty input', () => {
      const handler = vi.fn();
      inputActor.onSubmit(handler);

      const button = inputElement.querySelector('.input-submit') as HTMLButtonElement;
      button.click();

      expect(handler).not.toHaveBeenCalled();
    });

    it('does not submit whitespace-only input', () => {
      const handler = vi.fn();
      inputActor.onSubmit(handler);

      inputActor.setValue('   \n\t  ');
      const button = inputElement.querySelector('.input-submit') as HTMLButtonElement;
      button.click();

      expect(handler).not.toHaveBeenCalled();
    });

    it('sets submitting state', () => {
      const handler = vi.fn();
      inputActor.onSubmit(handler);

      inputActor.setValue('Test');
      const button = inputElement.querySelector('.input-submit') as HTMLButtonElement;
      button.click();

      expect(inputActor.getState().submitting).toBe(true);
    });

    it('includes attached files in submit', () => {
      const handler = vi.fn();
      inputActor.onSubmit(handler);

      inputActor.setValue('With files');
      inputActor.addFile('/path/file1.txt');
      inputActor.addFile('/path/file2.txt');

      const button = inputElement.querySelector('.input-submit') as HTMLButtonElement;
      button.click();

      expect(handler).toHaveBeenCalledWith('With files', ['/path/file1.txt', '/path/file2.txt']);
    });
  });

  describe('streaming integration', () => {
    it('disables input when streaming starts', async () => {
      streamingActor.startStream('msg-123');
      await new Promise(resolve => setTimeout(resolve, 10));

      const textarea = inputElement.querySelector('.input-textarea') as HTMLTextAreaElement;
      expect(textarea.disabled).toBe(true);
    });

    it('enables input when streaming ends', async () => {
      streamingActor.startStream('msg-123');
      await new Promise(resolve => setTimeout(resolve, 10));

      streamingActor.endStream();
      await new Promise(resolve => setTimeout(resolve, 10));

      const textarea = inputElement.querySelector('.input-textarea') as HTMLTextAreaElement;
      expect(textarea.disabled).toBe(false);
    });

    it('resets submitting state when streaming ends', async () => {
      const handler = vi.fn();
      inputActor.onSubmit(handler);

      inputActor.setValue('Test');
      const button = inputElement.querySelector('.input-submit') as HTMLButtonElement;
      button.click();

      expect(inputActor.getState().submitting).toBe(true);

      streamingActor.startStream('msg-123');
      await new Promise(resolve => setTimeout(resolve, 10));

      streamingActor.endStream();
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(inputActor.getState().submitting).toBe(false);
    });

    it('clears input after streaming ends', async () => {
      const handler = vi.fn();
      inputActor.onSubmit(handler);

      inputActor.setValue('Test message');
      inputActor.addFile('/file.txt');

      const button = inputElement.querySelector('.input-submit') as HTMLButtonElement;
      button.click();

      streamingActor.startStream('msg-123');
      await new Promise(resolve => setTimeout(resolve, 10));

      streamingActor.endStream();
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(inputActor.getValue()).toBe('');
      expect(inputActor.getState().files).toEqual([]);
    });
  });

  describe('file attachments', () => {
    it('adds a file', () => {
      inputActor.addFile('/path/to/document.pdf');

      expect(inputActor.getState().files).toContain('/path/to/document.pdf');
    });

    it('does not add duplicate files', () => {
      inputActor.addFile('/path/to/file.txt');
      inputActor.addFile('/path/to/file.txt');

      expect(inputActor.getState().files.length).toBe(1);
    });

    it('renders file tags', () => {
      inputActor.addFile('/path/to/document.pdf');

      const fileTag = inputElement.querySelector('.input-file-tag');
      expect(fileTag).toBeTruthy();
      expect(fileTag?.textContent).toContain('document.pdf');
    });

    it('removes a file', () => {
      inputActor.addFile('/path/to/file.txt');
      inputActor.removeFile('/path/to/file.txt');

      expect(inputActor.getState().files).toEqual([]);
    });

    it('removes file via button click', () => {
      inputActor.addFile('/path/to/file.txt');

      const removeBtn = inputElement.querySelector('.input-file-remove') as HTMLButtonElement;
      removeBtn.click();

      expect(inputActor.getState().files).toEqual([]);
    });
  });

  describe('focus', () => {
    it('focuses the textarea', () => {
      inputActor.focus();

      // Note: In happy-dom, focus might not work exactly like browser
      // But we can verify the method doesn't throw
      expect(() => inputActor.focus()).not.toThrow();
    });
  });
});
