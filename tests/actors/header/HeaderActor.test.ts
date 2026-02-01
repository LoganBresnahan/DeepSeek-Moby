/**
 * Unit tests for HeaderActor
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushMicrotasks } from '../../setup';
import { EventStateManager } from '../../../media/state/EventStateManager';
import { HeaderActor } from '../../../media/actors/header/HeaderActor';
import { SessionActor } from '../../../media/actors/session/SessionActor';
import { StreamingActor } from '../../../media/actors/streaming/StreamingActor';

describe('HeaderActor', () => {
  let manager: EventStateManager;
  let headerElement: HTMLElement;
  let sessionElement: HTMLElement;
  let streamingElement: HTMLElement;
  let headerActor: HeaderActor;
  let sessionActor: SessionActor;
  let streamingActor: StreamingActor;

  beforeEach(() => {
    HeaderActor.resetStylesInjected();
    SessionActor.resetStylesInjected();
    StreamingActor.resetStylesInjected();

    manager = new EventStateManager();

    // Create elements
    headerElement = document.createElement('div');
    headerElement.id = 'chat-header';
    document.body.appendChild(headerElement);

    sessionElement = document.createElement('div');
    sessionElement.id = 'session-root';
    document.body.appendChild(sessionElement);

    streamingElement = document.createElement('div');
    streamingElement.id = 'streaming-root';
    document.body.appendChild(streamingElement);

    // Create actors
    sessionActor = new SessionActor(manager, sessionElement);
    streamingActor = new StreamingActor(manager, streamingElement);
    headerActor = new HeaderActor(manager, headerElement);
  });

  afterEach(() => {
    headerActor.destroy();
    sessionActor.destroy();
    streamingActor.destroy();
    document.body.innerHTML = '';
  });

  describe('initialization', () => {
    it('registers with the manager', async () => {
      await flushMicrotasks();
      expect(manager.hasActor('chat-header-HeaderActor')).toBe(true);
    });

    it('creates DOM structure', () => {
      expect(headerElement.querySelector('.header-title')).toBeTruthy();
      expect(headerElement.querySelector('.header-model-select')).toBeTruthy();
      expect(headerElement.querySelector('.header-menu')).toBeTruthy();
    });

    it('starts with default state', () => {
      const state = headerActor.getState();
      expect(state.title).toBe('New Chat');
      expect(state.model).toBe('deepseek-chat');
      expect(state.menuOpen).toBe(false);
      expect(state.streaming).toBe(false);
    });

    it('injects styles into document head', () => {
      const styleTag = document.querySelector('style[data-actor="header"]');
      expect(styleTag).toBeTruthy();
    });
  });

  describe('title display', () => {
    it('shows default title', () => {
      const titleEl = headerElement.querySelector('.header-title');
      expect(titleEl?.textContent).toBe('New Chat');
    });

    it('updates title from session', async () => {
      // Simulate session loaded
      const event = new MessageEvent('message', {
        data: {
          type: 'sessionLoaded',
          sessionId: 'session-1',
          title: 'My Test Chat',
          model: 'deepseek-chat'
        }
      });
      window.dispatchEvent(event);
      await new Promise(resolve => setTimeout(resolve, 10));

      const titleEl = headerElement.querySelector('.header-title');
      expect(titleEl?.textContent).toBe('My Test Chat');
    });

    it('allows programmatic title change', () => {
      headerActor.setTitle('Updated Title');

      const titleEl = headerElement.querySelector('.header-title');
      expect(titleEl?.textContent).toBe('Updated Title');
    });
  });

  describe('model selector', () => {
    it('defaults to deepseek-chat', () => {
      const select = headerElement.querySelector('.header-model-select') as HTMLSelectElement;
      expect(select.value).toBe('deepseek-chat');
    });

    it('calls handler on model change', () => {
      const handler = vi.fn();
      headerActor.onModelChange(handler);

      const select = headerElement.querySelector('.header-model-select') as HTMLSelectElement;
      select.value = 'deepseek-reasoner';
      select.dispatchEvent(new Event('change'));

      expect(handler).toHaveBeenCalledWith('deepseek-reasoner');
    });

    it('disables during streaming', async () => {
      streamingActor.startStream('msg-1');
      await new Promise(resolve => setTimeout(resolve, 10));

      const select = headerElement.querySelector('.header-model-select') as HTMLSelectElement;
      expect(select.disabled).toBe(true);
    });

    it('enables after streaming ends', async () => {
      streamingActor.startStream('msg-1');
      await new Promise(resolve => setTimeout(resolve, 10));

      streamingActor.endStream();
      await new Promise(resolve => setTimeout(resolve, 10));

      const select = headerElement.querySelector('.header-model-select') as HTMLSelectElement;
      expect(select.disabled).toBe(false);
    });

    it('allows programmatic model change', () => {
      headerActor.setModel('deepseek-reasoner');

      const select = headerElement.querySelector('.header-model-select') as HTMLSelectElement;
      expect(select.value).toBe('deepseek-reasoner');
    });
  });

  describe('action buttons', () => {
    it('calls handler for newChat action', () => {
      const handler = vi.fn();
      headerActor.onAction(handler);

      const btn = headerElement.querySelector('[data-action="newChat"]') as HTMLButtonElement;
      btn.click();

      expect(handler).toHaveBeenCalledWith('newChat');
    });

    it('calls handler for showHistory action', () => {
      const handler = vi.fn();
      headerActor.onAction(handler);

      const btn = headerElement.querySelector('[data-action="showHistory"]') as HTMLButtonElement;
      btn.click();

      expect(handler).toHaveBeenCalledWith('showHistory');
    });

    it('disables buttons during streaming', async () => {
      streamingActor.startStream('msg-1');
      await new Promise(resolve => setTimeout(resolve, 10));

      const buttons = headerElement.querySelectorAll('.header-button');
      buttons.forEach(btn => {
        expect((btn as HTMLButtonElement).disabled).toBe(true);
      });
    });
  });

  describe('menu dropdown', () => {
    it('starts closed', () => {
      expect(headerActor.getState().menuOpen).toBe(false);
    });

    it('toggles on menu button click', () => {
      const menuBtn = headerElement.querySelector('.header-menu-toggle') as HTMLButtonElement;
      menuBtn.click();

      expect(headerActor.getState().menuOpen).toBe(true);

      // Click again to close
      menuBtn.click();
      expect(headerActor.getState().menuOpen).toBe(false);
    });

    it('calls handler for menu item actions', () => {
      const handler = vi.fn();
      headerActor.onAction(handler);

      // Open menu
      const menuBtn = headerElement.querySelector('.header-menu-toggle') as HTMLButtonElement;
      menuBtn.click();

      // Click export
      const exportItem = headerElement.querySelector('[data-action="exportChat"]') as HTMLElement;
      exportItem.click();

      expect(handler).toHaveBeenCalledWith('exportChat');
    });

    it('closes menu after action', () => {
      const handler = vi.fn();
      headerActor.onAction(handler);

      // Open menu
      const menuBtn = headerElement.querySelector('.header-menu-toggle') as HTMLButtonElement;
      menuBtn.click();
      expect(headerActor.getState().menuOpen).toBe(true);

      // Click an action
      const exportItem = headerElement.querySelector('[data-action="exportChat"]') as HTMLElement;
      exportItem.click();

      expect(headerActor.getState().menuOpen).toBe(false);
    });

    it('has danger styling for delete action', () => {
      const deleteItem = headerElement.querySelector('[data-action="deleteChat"]');
      expect(deleteItem?.classList.contains('danger')).toBe(true);
    });
  });

  describe('title editing', () => {
    it('calls handler on title change', () => {
      const handler = vi.fn();
      headerActor.onTitleChange(handler);

      // Click title to start editing
      const titleEl = headerElement.querySelector('.header-title') as HTMLElement;
      titleEl.click();

      // Find input
      const input = headerElement.querySelector('.header-title-input') as HTMLInputElement;
      expect(input).toBeTruthy();

      // Change value and blur
      input.value = 'New Title';
      input.dispatchEvent(new FocusEvent('blur'));

      expect(handler).toHaveBeenCalledWith('New Title');
    });
  });

  describe('streaming integration', () => {
    it('updates streaming state from subscription', async () => {
      expect(headerActor.getState().streaming).toBe(false);

      streamingActor.startStream('msg-1');
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(headerActor.getState().streaming).toBe(true);

      streamingActor.endStream();
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(headerActor.getState().streaming).toBe(false);
    });
  });
});
