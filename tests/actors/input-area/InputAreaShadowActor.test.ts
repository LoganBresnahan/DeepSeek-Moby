/**
 * Tests for InputAreaShadowActor
 *
 * Tests Shadow DOM encapsulation, input handling,
 * attachment management, and streaming state.
 * Note: Send/Stop buttons are in ToolbarShadowActor
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { InputAreaShadowActor, Attachment } from '../../../media/actors/input-area/InputAreaShadowActor';
import { EventStateManager } from '../../../media/state/EventStateManager';
import { ShadowActor } from '../../../media/state/ShadowActor';

describe('InputAreaShadowActor', () => {
  let manager: EventStateManager;
  let element: HTMLElement;
  let actor: InputAreaShadowActor;
  let mockVscode: { postMessage: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    manager = new EventStateManager();
    element = document.createElement('div');
    element.id = 'input-area-container';
    document.body.appendChild(element);
    mockVscode = { postMessage: vi.fn() };
    ShadowActor.resetInstanceCount();
  });

  afterEach(() => {
    actor?.destroy();
    document.body.innerHTML = '';
  });

  describe('Shadow DOM creation', () => {
    it('creates shadow root on element', () => {
      actor = new InputAreaShadowActor(manager, element, mockVscode);
      expect(element.shadowRoot).toBeTruthy();
    });

    it('renders input area structure', () => {
      actor = new InputAreaShadowActor(manager, element, mockVscode);

      expect(element.shadowRoot?.querySelector('.input-area')).toBeTruthy();
      expect(element.shadowRoot?.querySelector('textarea')).toBeTruthy();
    });

    it('adopts stylesheets into shadow root', () => {
      actor = new InputAreaShadowActor(manager, element, mockVscode);
      const sheets = element.shadowRoot?.adoptedStyleSheets;
      expect(sheets?.length).toBeGreaterThan(0);
    });
  });

  describe('Input handling', () => {
    beforeEach(() => {
      actor = new InputAreaShadowActor(manager, element, mockVscode);
    });

    it('tracks textarea value', () => {
      const textarea = element.shadowRoot?.querySelector('textarea') as HTMLTextAreaElement;
      textarea.value = 'Test input';
      textarea.dispatchEvent(new Event('input', { bubbles: true }));

      expect(actor.getValue()).toBe('Test input');
    });

    it('sets value programmatically', () => {
      actor.setValue('Programmatic value');

      const textarea = element.shadowRoot?.querySelector('textarea') as HTMLTextAreaElement;
      expect(textarea.value).toBe('Programmatic value');
    });

    it('focuses textarea', () => {
      const textarea = element.shadowRoot?.querySelector('textarea') as HTMLTextAreaElement;
      const focusSpy = vi.spyOn(textarea, 'focus');

      actor.focus();

      expect(focusSpy).toHaveBeenCalled();
    });

    it('publishes value changes', async () => {
      const received: unknown[] = [];
      const subscriberEl = document.createElement('div');
      subscriberEl.id = 'subscriber';
      document.body.appendChild(subscriberEl);

      subscriberEl.addEventListener('state-changed', ((e: CustomEvent) => {
        if (e.detail.state['input.value'] !== undefined) {
          received.push(e.detail.state['input.value']);
        }
      }) as EventListener);

      manager.register({
        actorId: 'subscriber',
        element: subscriberEl,
        publicationKeys: [],
        subscriptionKeys: ['input.*']
      }, {});

      actor.setValue('Changed');
      await Promise.resolve();

      expect(received).toContain('Changed');
    });
  });

  describe('Send functionality', () => {
    beforeEach(() => {
      actor = new InputAreaShadowActor(manager, element, mockVscode);
    });

    it('calls onSend handler when submit called', () => {
      const handler = vi.fn();
      actor.onSend(handler);
      actor.setValue('Test message');

      actor.submit();

      expect(handler).toHaveBeenCalledWith('Test message', undefined);
    });

    it('does not send empty messages', () => {
      const handler = vi.fn();
      actor.onSend(handler);

      actor.submit();

      expect(handler).not.toHaveBeenCalled();
    });

    it('sends on Enter key (without shift)', () => {
      const handler = vi.fn();
      actor.onSend(handler);
      actor.setValue('Enter message');

      const textarea = element.shadowRoot?.querySelector('textarea') as HTMLTextAreaElement;
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

      expect(handler).toHaveBeenCalledWith('Enter message', undefined);
    });

    it('does not send on Shift+Enter', () => {
      const handler = vi.fn();
      actor.onSend(handler);
      actor.setValue('Multiline');

      const textarea = element.shadowRoot?.querySelector('textarea') as HTMLTextAreaElement;
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));

      expect(handler).not.toHaveBeenCalled();
    });

    it('clears input after send', () => {
      const handler = vi.fn();
      actor.onSend(handler);
      actor.setValue('To be cleared');

      actor.submit();

      expect(actor.getValue()).toBe('');
    });
  });

  describe('Streaming state', () => {
    beforeEach(() => {
      actor = new InputAreaShadowActor(manager, element, mockVscode);
    });

    it('reports streaming state', async () => {
      await Promise.resolve();
      await Promise.resolve();

      expect(actor.isStreaming()).toBe(false);

      manager.handleStateChange({
        source: 'streaming-actor',
        state: { 'streaming.active': true },
        changedKeys: ['streaming.active'],
        publicationChain: [],
        timestamp: Date.now()
      });

      expect(actor.isStreaming()).toBe(true);
    });
  });

  describe('Mid-stream interrupt', () => {
    beforeEach(async () => {
      actor = new InputAreaShadowActor(manager, element, mockVscode);
      await Promise.resolve();
      await Promise.resolve();
    });

    it('queues message when submitting during stream', async () => {
      // Start streaming
      manager.handleStateChange({
        source: 'streaming-actor',
        state: { 'streaming.active': true },
        changedKeys: ['streaming.active'],
        publicationChain: [],
        timestamp: Date.now()
      });

      actor.setValue('Interrupt message');
      actor.submit();

      expect(actor.hasPendingInterrupt()).toBe(true);
      expect(mockVscode.postMessage).toHaveBeenCalledWith({ type: 'stopGeneration' });
    });

    it('sends queued message after streaming ends', async () => {
      vi.useFakeTimers();
      const handler = vi.fn();
      actor.onSend(handler);

      // Start streaming
      manager.handleStateChange({
        source: 'streaming-actor',
        state: { 'streaming.active': true },
        changedKeys: ['streaming.active'],
        publicationChain: [],
        timestamp: Date.now()
      });

      // Queue interrupt
      actor.setValue('Queued message');
      actor.submit();

      expect(handler).not.toHaveBeenCalled();

      // End streaming
      manager.handleStateChange({
        source: 'streaming-actor',
        state: { 'streaming.active': false },
        changedKeys: ['streaming.active'],
        publicationChain: [],
        timestamp: Date.now()
      });

      // Wait for timeout
      vi.advanceTimersByTime(100);

      expect(handler).toHaveBeenCalledWith('Queued message', undefined);
      vi.useRealTimers();
    });
  });

  describe('Attach functionality', () => {
    beforeEach(() => {
      actor = new InputAreaShadowActor(manager, element, mockVscode);
    });

    it('triggers file input when triggerAttach called', () => {
      const fileInput = element.shadowRoot?.querySelector('.hidden-input') as HTMLInputElement;
      const clickSpy = vi.spyOn(fileInput, 'click');

      actor.triggerAttach();

      expect(clickSpy).toHaveBeenCalled();
    });
  });

  describe('State', () => {
    beforeEach(() => {
      actor = new InputAreaShadowActor(manager, element, mockVscode);
    });

    it('returns current state', () => {
      actor.setValue('Test');

      const state = actor.getState();

      expect(state.value).toBe('Test');
      expect(state.submitting).toBe(false);
      expect(state.streaming).toBe(false);
      expect(state.attachments).toEqual([]);
    });
  });

  describe('File chips', () => {
    beforeEach(() => {
      actor = new InputAreaShadowActor(manager, element, mockVscode);
    });

    it('renders file chips when files provided', () => {
      const files = new Map<string, string>([
        ['file1.ts', 'content1'],
        ['file2.ts', 'content2']
      ]);

      actor.updateFileChips(files);

      const chips = element.shadowRoot?.querySelectorAll('.file-chip');
      expect(chips?.length).toBe(2);
    });

    it('hides container when no files', () => {
      actor.updateFileChips(new Map());

      const container = element.shadowRoot?.querySelector('.file-chips-container');
      expect(container?.classList.contains('hidden')).toBe(true);
    });
  });

  describe('Lifecycle', () => {
    it('cleans up on destroy', () => {
      actor = new InputAreaShadowActor(manager, element, mockVscode);

      actor.destroy();

      // Should not throw
      expect(actor.getValue()).toBe('');
    });
  });
});
