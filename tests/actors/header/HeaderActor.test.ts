/**
 * Unit tests for HeaderActor
 *
 * Tests header display updates including:
 * - Model name display updates via pub/sub
 * - Title display updates via pub/sub
 * - Model ID to display name conversion
 * - State management
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HeaderActor, HeaderElements } from '../../../media/actors/header/HeaderActor';
import { EventStateManager } from '../../../media/state/EventStateManager';

describe('HeaderActor', () => {
  let manager: EventStateManager;
  let element: HTMLElement;
  let actor: HeaderActor;
  let modelNameEl: HTMLElement;
  let titleEl: HTMLElement;

  beforeEach(() => {
    manager = new EventStateManager({ batchBroadcasts: false });
    element = document.createElement('div');
    element.id = 'header-root';
    document.body.appendChild(element);

    // Create elements that HeaderActor will update
    modelNameEl = document.createElement('span');
    modelNameEl.id = 'modelName';
    document.body.appendChild(modelNameEl);

    titleEl = document.createElement('span');
    titleEl.id = 'sessionTitle';
    document.body.appendChild(titleEl);

    const elements: HeaderElements = {
      modelNameEl,
      titleEl
    };

    actor = new HeaderActor(manager, element, elements);
  });

  afterEach(() => {
    actor.destroy();
    document.body.innerHTML = '';
  });

  describe('initialization', () => {
    it('registers with the manager', async () => {
      await new Promise(resolve => queueMicrotask(resolve));
      expect(manager.hasActor('header-root-HeaderActor')).toBe(true);
    });

    it('starts with default state', () => {
      const state = actor.getState();
      expect(state.model).toBe('deepseek-chat');
      expect(state.title).toBe('New Chat');
    });
  });

  describe('model updates via pub/sub', () => {
    it('updates model name element when session.model is published', () => {
      manager.publishDirect('session.model', 'deepseek-reasoner');

      expect(modelNameEl.textContent).toBe('Reasoner (R1)');
    });

    it('converts deepseek-chat to display name', () => {
      manager.publishDirect('session.model', 'deepseek-chat');

      expect(modelNameEl.textContent).toBe('Chat (V3)');
    });

    it('handles unknown model IDs gracefully', () => {
      manager.publishDirect('session.model', 'deepseek-custom-model');

      expect(modelNameEl.textContent).toBe('custom model');
    });

    it('ignores empty model value', () => {
      manager.publishDirect('session.model', 'deepseek-reasoner');
      manager.publishDirect('session.model', '');

      // Should keep the previous value in display
      expect(actor.getState().model).toBe('deepseek-reasoner');
    });

    it('updates internal state', () => {
      manager.publishDirect('session.model', 'deepseek-reasoner');

      expect(actor.getState().model).toBe('deepseek-reasoner');
    });
  });

  describe('title updates via pub/sub', () => {
    it('updates title element when session.title is published', () => {
      manager.publishDirect('session.title', 'My Conversation');

      expect(titleEl.textContent).toBe('My Conversation');
    });

    it('uses default title for empty value', () => {
      manager.publishDirect('session.title', '');

      expect(actor.getState().title).toBe('New Chat');
    });

    it('updates internal state', () => {
      manager.publishDirect('session.title', 'Test Title');

      expect(actor.getState().title).toBe('Test Title');
    });
  });

  describe('without title element', () => {
    it('works without titleEl', async () => {
      const newActor = new HeaderActor(manager, document.createElement('div'), {
        modelNameEl
      });

      // Wait for actor registration
      await new Promise(resolve => queueMicrotask(resolve));

      // Should not throw
      manager.publishDirect('session.title', 'Test Title');
      expect(newActor.getState().title).toBe('Test Title');

      newActor.destroy();
    });
  });

  describe('refreshDisplays', () => {
    it('updates both displays', () => {
      // Manually clear elements
      modelNameEl.textContent = '';
      titleEl.textContent = '';

      // Set internal state via pub/sub
      manager.publishDirect('session.model', 'deepseek-reasoner');
      manager.publishDirect('session.title', 'Test');

      // Manually clear again
      modelNameEl.textContent = '';
      titleEl.textContent = '';

      // Refresh
      actor.refreshDisplays();

      expect(modelNameEl.textContent).toBe('Reasoner (R1)');
      expect(titleEl.textContent).toBe('Test');
    });
  });

  describe('getState', () => {
    it('returns current state', () => {
      manager.publishDirect('session.model', 'deepseek-reasoner');
      manager.publishDirect('session.title', 'Test Session');

      const state = actor.getState();

      expect(state.model).toBe('deepseek-reasoner');
      expect(state.title).toBe('Test Session');
    });
  });

  describe('lifecycle', () => {
    it('cleans up on destroy', () => {
      actor.destroy();

      // Should not throw on subsequent operations
      expect(() => actor.getState()).not.toThrow();
    });
  });
});
