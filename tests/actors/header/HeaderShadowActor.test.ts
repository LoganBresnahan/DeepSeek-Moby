/**
 * Tests for HeaderShadowActor
 *
 * Tests Shadow DOM encapsulation, title editing,
 * model selection, and action handling.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HeaderShadowActor, HeaderAction } from '../../../media/actors/header/HeaderShadowActor';
import { EventStateManager } from '../../../media/state/EventStateManager';
import { ShadowActor } from '../../../media/state/ShadowActor';

describe('HeaderShadowActor', () => {
  let manager: EventStateManager;
  let element: HTMLElement;
  let actor: HeaderShadowActor;

  beforeEach(() => {
    manager = new EventStateManager();
    element = document.createElement('div');
    element.id = 'header-container';
    document.body.appendChild(element);
    ShadowActor.resetInstanceCount();
  });

  afterEach(() => {
    actor?.destroy();
    document.body.innerHTML = '';
  });

  describe('Shadow DOM creation', () => {
    it('creates shadow root on element', () => {
      actor = new HeaderShadowActor(manager, element);
      expect(element.shadowRoot).toBeTruthy();
    });

    it('renders header structure', () => {
      actor = new HeaderShadowActor(manager, element);

      expect(element.shadowRoot?.querySelector('.header-container')).toBeTruthy();
      expect(element.shadowRoot?.querySelector('.title')).toBeTruthy();
      expect(element.shadowRoot?.querySelector('.model-select')).toBeTruthy();
    });

    it('renders action buttons', () => {
      actor = new HeaderShadowActor(manager, element);

      expect(element.shadowRoot?.querySelector('[data-action="newChat"]')).toBeTruthy();
      expect(element.shadowRoot?.querySelector('[data-action="showHistory"]')).toBeTruthy();
    });
  });

  describe('Title', () => {
    beforeEach(() => {
      actor = new HeaderShadowActor(manager, element);
    });

    it('displays default title', () => {
      const title = element.shadowRoot?.querySelector('.title');
      expect(title?.textContent).toBe('New Chat');
    });

    it('can set title programmatically', () => {
      actor.setTitle('Custom Title');

      const title = element.shadowRoot?.querySelector('.title');
      expect(title?.textContent).toBe('Custom Title');
    });

    it('responds to session.title subscription', async () => {
      await Promise.resolve();
      await Promise.resolve();

      manager.handleStateChange({
        source: 'session-actor',
        state: { 'session.title': 'Session Title' },
        changedKeys: ['session.title'],
        publicationChain: [],
        timestamp: Date.now()
      });

      const title = element.shadowRoot?.querySelector('.title');
      expect(title?.textContent).toBe('Session Title');
    });

    it('starts editing on title click', () => {
      const title = element.shadowRoot?.querySelector('.title') as HTMLElement;
      title.click();

      const input = element.shadowRoot?.querySelector('.title-input') as HTMLInputElement;
      expect(input).toBeTruthy();
    });

    it('calls handler when title changes', () => {
      const handler = vi.fn();
      actor.onTitleChange(handler);

      const title = element.shadowRoot?.querySelector('.title') as HTMLElement;
      title.click();

      const input = element.shadowRoot?.querySelector('.title-input') as HTMLInputElement;
      input.value = 'Edited Title';
      input.blur();

      expect(handler).toHaveBeenCalledWith('Edited Title');
    });

    it('saves on Enter key', () => {
      const handler = vi.fn();
      actor.onTitleChange(handler);

      const title = element.shadowRoot?.querySelector('.title') as HTMLElement;
      title.click();

      const input = element.shadowRoot?.querySelector('.title-input') as HTMLInputElement;
      input.value = 'Enter Title';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

      expect(handler).toHaveBeenCalledWith('Enter Title');
    });

    it('cancels on Escape key', () => {
      const handler = vi.fn();
      actor.onTitleChange(handler);

      actor.setTitle('Original');

      const title = element.shadowRoot?.querySelector('.title') as HTMLElement;
      title.click();

      const input = element.shadowRoot?.querySelector('.title-input') as HTMLInputElement;
      input.value = 'Changed';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

      expect(actor.getState().title).toBe('Original');
    });
  });

  describe('Model selection', () => {
    beforeEach(() => {
      actor = new HeaderShadowActor(manager, element);
    });

    it('displays model selector', () => {
      const select = element.shadowRoot?.querySelector('.model-select') as HTMLSelectElement;
      expect(select).toBeTruthy();
      expect(select.options.length).toBeGreaterThan(0);
    });

    it('defaults to deepseek-chat', () => {
      const select = element.shadowRoot?.querySelector('.model-select') as HTMLSelectElement;
      expect(select.value).toBe('deepseek-chat');
    });

    it('can set model programmatically', () => {
      actor.setModel('deepseek-reasoner');

      const select = element.shadowRoot?.querySelector('.model-select') as HTMLSelectElement;
      expect(select.value).toBe('deepseek-reasoner');
    });

    it('calls handler when model changes', () => {
      const handler = vi.fn();
      actor.onModelChange(handler);

      const select = element.shadowRoot?.querySelector('.model-select') as HTMLSelectElement;
      select.value = 'deepseek-reasoner';
      select.dispatchEvent(new Event('change', { bubbles: true }));

      expect(handler).toHaveBeenCalledWith('deepseek-reasoner');
    });
  });

  describe('Actions', () => {
    beforeEach(() => {
      actor = new HeaderShadowActor(manager, element);
    });

    it('calls handler for newChat action', () => {
      const handler = vi.fn();
      actor.onAction(handler);

      const btn = element.shadowRoot?.querySelector('[data-action="newChat"]') as HTMLButtonElement;
      btn.click();

      expect(handler).toHaveBeenCalledWith('newChat');
    });

    it('calls handler for showHistory action', () => {
      const handler = vi.fn();
      actor.onAction(handler);

      const btn = element.shadowRoot?.querySelector('[data-action="showHistory"]') as HTMLButtonElement;
      btn.click();

      expect(handler).toHaveBeenCalledWith('showHistory');
    });
  });

  describe('Menu dropdown', () => {
    beforeEach(() => {
      actor = new HeaderShadowActor(manager, element);
    });

    it('opens menu on toggle click', () => {
      const toggle = element.shadowRoot?.querySelector('.menu-toggle') as HTMLButtonElement;
      toggle.click();

      const dropdown = element.shadowRoot?.querySelector('.menu-dropdown');
      expect(dropdown?.classList.contains('open')).toBe(true);
      expect(actor.getState().menuOpen).toBe(true);
    });

    it('closes menu on outside click', () => {
      const toggle = element.shadowRoot?.querySelector('.menu-toggle') as HTMLButtonElement;
      toggle.click();

      expect(actor.getState().menuOpen).toBe(true);

      document.body.click();

      expect(actor.getState().menuOpen).toBe(false);
    });

    it('calls action handler from menu items', () => {
      const handler = vi.fn();
      actor.onAction(handler);

      const toggle = element.shadowRoot?.querySelector('.menu-toggle') as HTMLButtonElement;
      toggle.click();

      const exportItem = element.shadowRoot?.querySelector('[data-action="exportChat"]') as HTMLElement;
      exportItem.click();

      expect(handler).toHaveBeenCalledWith('exportChat');
    });
  });

  describe('Streaming state', () => {
    beforeEach(async () => {
      actor = new HeaderShadowActor(manager, element);
      await Promise.resolve();
      await Promise.resolve();
    });

    it('disables controls when streaming', () => {
      manager.handleStateChange({
        source: 'streaming-actor',
        state: { 'streaming.active': true },
        changedKeys: ['streaming.active'],
        publicationChain: [],
        timestamp: Date.now()
      });

      const select = element.shadowRoot?.querySelector('.model-select') as HTMLSelectElement;
      expect(select.disabled).toBe(true);
    });

    it('shows streaming indicator when streaming', () => {
      manager.handleStateChange({
        source: 'streaming-actor',
        state: { 'streaming.active': true },
        changedKeys: ['streaming.active'],
        publicationChain: [],
        timestamp: Date.now()
      });

      const indicator = element.shadowRoot?.querySelector('.streaming-indicator');
      expect(indicator?.classList.contains('active')).toBe(true);
    });

    it('prevents title editing when streaming', () => {
      manager.handleStateChange({
        source: 'streaming-actor',
        state: { 'streaming.active': true },
        changedKeys: ['streaming.active'],
        publicationChain: [],
        timestamp: Date.now()
      });

      const title = element.shadowRoot?.querySelector('.title') as HTMLElement;
      title.click();

      const input = element.shadowRoot?.querySelector('.title-input');
      expect(input).toBeNull();
    });
  });

  describe('State', () => {
    beforeEach(() => {
      actor = new HeaderShadowActor(manager, element);
    });

    it('returns current state', () => {
      const state = actor.getState();

      expect(state).toEqual({
        title: 'New Chat',
        model: 'deepseek-chat',
        menuOpen: false,
        streaming: false
      });
    });
  });

  describe('Lifecycle', () => {
    it('removes document listener on destroy', () => {
      actor = new HeaderShadowActor(manager, element);

      // Open menu
      const toggle = element.shadowRoot?.querySelector('.menu-toggle') as HTMLButtonElement;
      toggle.click();

      actor.destroy();

      // Should not throw even though handler is removed
      document.body.click();
    });
  });
});
