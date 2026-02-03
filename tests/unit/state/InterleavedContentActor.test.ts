/**
 * Tests for InterleavedContentActor
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { InterleavedContentActor, type InterleavedContentConfig } from '../../../media/state/InterleavedContentActor';
import { EventStateManager } from '../../../media/state/EventStateManager';
import { resetUniqueIdCounter } from '../../../media/utils/uniqueId';

/**
 * Concrete test implementation of InterleavedContentActor
 */
class TestInterleavedActor extends InterleavedContentActor {
  constructor(config: Omit<InterleavedContentConfig, 'publications' | 'subscriptions' | 'actorName' | 'containerClassName' | 'styles'>) {
    super({
      ...config,
      publications: {},
      subscriptions: {},
      actorName: 'test-interleaved',
      containerClassName: 'test-container',
      styles: '.test-container { display: block; }'
    });
  }

  // Expose protected methods for testing
  public testCreateContainer(prefix: string, classes?: string[], dataAttrs?: Record<string, string>) {
    return this.createContainer(prefix, classes, dataAttrs);
  }

  public testGetContainer(id: string) {
    return this.getContainer(id);
  }

  public testGetCurrentContainer() {
    return this.getCurrentContainer();
  }

  public testRemoveContainer(id: string) {
    this.removeContainer(id);
  }

  public testUpdateContainerContent(id: string, html: string) {
    this.updateContainerContent(id, html);
  }

  public testHideContainer(id: string) {
    this.hideContainer(id);
  }

  public testShowContainer(id: string) {
    this.showContainer(id);
  }

  public testGetContainerIds() {
    return this.getContainerIds();
  }

  public testGetContainerCount() {
    return this.getContainerCount();
  }
}

describe('InterleavedContentActor', () => {
  let manager: EventStateManager;
  let element: HTMLElement;

  beforeEach(() => {
    resetUniqueIdCounter();
    InterleavedContentActor.resetAllStylesInjected();
    manager = new EventStateManager();
    element = document.createElement('div');
  });

  afterEach(() => {
    manager.resetStyles();
    InterleavedContentActor.resetAllStylesInjected();
  });

  describe('style injection', () => {
    it('injects styles into document head', async () => {
      const actor = new TestInterleavedActor({ manager, element });
      await new Promise(resolve => queueMicrotask(resolve));

      const styleTag = document.querySelector('style[data-actor="test-interleaved"]');
      expect(styleTag).toBeTruthy();
      expect(styleTag?.textContent).toContain('.test-container');

      actor.destroy();
    });

    it('only injects styles once per actor type', async () => {
      const actor1 = new TestInterleavedActor({ manager, element: document.createElement('div') });
      const actor2 = new TestInterleavedActor({ manager, element: document.createElement('div') });
      await new Promise(resolve => queueMicrotask(resolve));

      const styleTags = document.querySelectorAll('style[data-actor="test-interleaved"]');
      expect(styleTags.length).toBe(1);

      actor1.destroy();
      actor2.destroy();
    });
  });

  describe('container management', () => {
    it('creates container with unique ID', async () => {
      const actor = new TestInterleavedActor({ manager, element });
      await new Promise(resolve => queueMicrotask(resolve));

      const container1 = actor.testCreateContainer('item');
      const container2 = actor.testCreateContainer('item');

      expect(container1.id).not.toBe(container2.id);
      expect(container1.id).toContain('item-');
      expect(container2.id).toContain('item-');

      actor.destroy();
    });

    it('adds container to parent element', async () => {
      const actor = new TestInterleavedActor({ manager, element });
      await new Promise(resolve => queueMicrotask(resolve));

      const container = actor.testCreateContainer('test');

      expect(element.contains(container.element)).toBe(true);

      actor.destroy();
    });

    it('applies container class name', async () => {
      const actor = new TestInterleavedActor({ manager, element });
      await new Promise(resolve => queueMicrotask(resolve));

      const container = actor.testCreateContainer('test');

      expect(container.element.classList.contains('test-container')).toBe(true);

      actor.destroy();
    });

    it('applies additional classes', async () => {
      const actor = new TestInterleavedActor({ manager, element });
      await new Promise(resolve => queueMicrotask(resolve));

      const container = actor.testCreateContainer('test', ['extra-class', 'another']);

      expect(container.element.classList.contains('extra-class')).toBe(true);
      expect(container.element.classList.contains('another')).toBe(true);

      actor.destroy();
    });

    it('applies data attributes', async () => {
      const actor = new TestInterleavedActor({ manager, element });
      await new Promise(resolve => queueMicrotask(resolve));

      const container = actor.testCreateContainer('test', [], { type: 'special', index: '5' });

      expect(container.element.getAttribute('data-type')).toBe('special');
      expect(container.element.getAttribute('data-index')).toBe('5');

      actor.destroy();
    });

    it('sets data-actor attribute', async () => {
      const actor = new TestInterleavedActor({ manager, element });
      await new Promise(resolve => queueMicrotask(resolve));

      const container = actor.testCreateContainer('test');

      expect(container.element.getAttribute('data-actor')).toBe('test-interleaved');

      actor.destroy();
    });

    it('adds bubble animation class initially', async () => {
      const actor = new TestInterleavedActor({ manager, element });
      await new Promise(resolve => queueMicrotask(resolve));

      const container = actor.testCreateContainer('test');

      expect(container.element.classList.contains('anim-bubble-in')).toBe(true);

      actor.destroy();
    });

    it('removes animation class after delay', async () => {
      vi.useFakeTimers();
      const actor = new TestInterleavedActor({ manager, element });
      await vi.runAllTimersAsync();

      const container = actor.testCreateContainer('test');

      expect(container.element.classList.contains('anim-bubble-in')).toBe(true);

      vi.advanceTimersByTime(300);

      expect(container.element.classList.contains('anim-bubble-in')).toBe(false);

      actor.destroy();
      vi.useRealTimers();
    });

    it('tracks createdAt timestamp', async () => {
      const actor = new TestInterleavedActor({ manager, element });
      await new Promise(resolve => queueMicrotask(resolve));

      const before = Date.now();
      const container = actor.testCreateContainer('test');
      const after = Date.now();

      expect(container.createdAt).toBeGreaterThanOrEqual(before);
      expect(container.createdAt).toBeLessThanOrEqual(after);

      actor.destroy();
    });
  });

  describe('getContainer', () => {
    it('retrieves container by ID', async () => {
      const actor = new TestInterleavedActor({ manager, element });
      await new Promise(resolve => queueMicrotask(resolve));

      const created = actor.testCreateContainer('test');
      const retrieved = actor.testGetContainer(created.id);

      expect(retrieved).toBe(created);

      actor.destroy();
    });

    it('returns undefined for unknown ID', async () => {
      const actor = new TestInterleavedActor({ manager, element });
      await new Promise(resolve => queueMicrotask(resolve));

      const retrieved = actor.testGetContainer('nonexistent');

      expect(retrieved).toBeUndefined();

      actor.destroy();
    });
  });

  describe('getCurrentContainer', () => {
    it('returns most recently created container', async () => {
      vi.useFakeTimers();
      const actor = new TestInterleavedActor({ manager, element });
      await vi.runAllTimersAsync();

      const container1 = actor.testCreateContainer('test');
      vi.advanceTimersByTime(10);
      const container2 = actor.testCreateContainer('test');
      vi.advanceTimersByTime(10);
      const container3 = actor.testCreateContainer('test');

      const current = actor.testGetCurrentContainer();

      expect(current).toBe(container3);

      actor.destroy();
      vi.useRealTimers();
    });

    it('returns undefined when no containers', async () => {
      const actor = new TestInterleavedActor({ manager, element });
      await new Promise(resolve => queueMicrotask(resolve));

      const current = actor.testGetCurrentContainer();

      expect(current).toBeUndefined();

      actor.destroy();
    });
  });

  describe('removeContainer', () => {
    it('removes container from DOM', async () => {
      const actor = new TestInterleavedActor({ manager, element });
      await new Promise(resolve => queueMicrotask(resolve));

      const container = actor.testCreateContainer('test');
      expect(element.contains(container.element)).toBe(true);

      actor.testRemoveContainer(container.id);

      expect(element.contains(container.element)).toBe(false);

      actor.destroy();
    });

    it('removes container from tracking', async () => {
      const actor = new TestInterleavedActor({ manager, element });
      await new Promise(resolve => queueMicrotask(resolve));

      const container = actor.testCreateContainer('test');
      expect(actor.testGetContainer(container.id)).toBeDefined();

      actor.testRemoveContainer(container.id);

      expect(actor.testGetContainer(container.id)).toBeUndefined();

      actor.destroy();
    });

    it('handles removing nonexistent container gracefully', async () => {
      const actor = new TestInterleavedActor({ manager, element });
      await new Promise(resolve => queueMicrotask(resolve));

      // Should not throw
      actor.testRemoveContainer('nonexistent');

      actor.destroy();
    });
  });

  describe('updateContainerContent', () => {
    it('updates container innerHTML', async () => {
      const actor = new TestInterleavedActor({ manager, element });
      await new Promise(resolve => queueMicrotask(resolve));

      const container = actor.testCreateContainer('test');
      actor.testUpdateContainerContent(container.id, '<span>Hello</span>');

      expect(container.element.innerHTML).toBe('<span>Hello</span>');

      actor.destroy();
    });

    it('handles updating nonexistent container gracefully', async () => {
      const actor = new TestInterleavedActor({ manager, element });
      await new Promise(resolve => queueMicrotask(resolve));

      // Should not throw
      actor.testUpdateContainerContent('nonexistent', '<span>Hello</span>');

      actor.destroy();
    });
  });

  describe('hideContainer / showContainer', () => {
    it('hides container by setting display none', async () => {
      const actor = new TestInterleavedActor({ manager, element });
      await new Promise(resolve => queueMicrotask(resolve));

      const container = actor.testCreateContainer('test');
      actor.testHideContainer(container.id);

      expect(container.element.style.display).toBe('none');

      actor.destroy();
    });

    it('shows container by clearing display', async () => {
      const actor = new TestInterleavedActor({ manager, element });
      await new Promise(resolve => queueMicrotask(resolve));

      const container = actor.testCreateContainer('test');
      container.element.style.display = 'none';

      actor.testShowContainer(container.id);

      expect(container.element.style.display).toBe('');

      actor.destroy();
    });
  });

  describe('getContainerIds / getContainerCount', () => {
    it('returns all container IDs', async () => {
      const actor = new TestInterleavedActor({ manager, element });
      await new Promise(resolve => queueMicrotask(resolve));

      const c1 = actor.testCreateContainer('test');
      const c2 = actor.testCreateContainer('test');
      const c3 = actor.testCreateContainer('test');

      const ids = actor.testGetContainerIds();

      expect(ids).toContain(c1.id);
      expect(ids).toContain(c2.id);
      expect(ids).toContain(c3.id);
      expect(ids.length).toBe(3);

      actor.destroy();
    });

    it('returns correct count', async () => {
      const actor = new TestInterleavedActor({ manager, element });
      await new Promise(resolve => queueMicrotask(resolve));

      expect(actor.testGetContainerCount()).toBe(0);

      actor.testCreateContainer('test');
      expect(actor.testGetContainerCount()).toBe(1);

      actor.testCreateContainer('test');
      expect(actor.testGetContainerCount()).toBe(2);

      actor.destroy();
    });
  });

  describe('clearContainers', () => {
    it('removes all containers from DOM', async () => {
      const actor = new TestInterleavedActor({ manager, element });
      await new Promise(resolve => queueMicrotask(resolve));

      const c1 = actor.testCreateContainer('test');
      const c2 = actor.testCreateContainer('test');

      actor.clearContainers();

      expect(element.contains(c1.element)).toBe(false);
      expect(element.contains(c2.element)).toBe(false);

      actor.destroy();
    });

    it('clears tracking map', async () => {
      const actor = new TestInterleavedActor({ manager, element });
      await new Promise(resolve => queueMicrotask(resolve));

      actor.testCreateContainer('test');
      actor.testCreateContainer('test');

      actor.clearContainers();

      expect(actor.testGetContainerCount()).toBe(0);

      actor.destroy();
    });

    it('resets ID counter', async () => {
      const actor = new TestInterleavedActor({ manager, element });
      await new Promise(resolve => queueMicrotask(resolve));

      actor.testCreateContainer('test');
      actor.testCreateContainer('test');

      actor.clearContainers();

      const newContainer = actor.testCreateContainer('test');
      expect(newContainer.id).toContain('test-1-');

      actor.destroy();
    });
  });

  describe('destroy', () => {
    it('clears all containers on destroy', async () => {
      const actor = new TestInterleavedActor({ manager, element });
      await new Promise(resolve => queueMicrotask(resolve));

      const c1 = actor.testCreateContainer('test');
      const c2 = actor.testCreateContainer('test');

      actor.destroy();

      expect(element.contains(c1.element)).toBe(false);
      expect(element.contains(c2.element)).toBe(false);
    });
  });

  describe('static reset methods', () => {
    it('resetStylesInjectedFor clears specific actor styles', async () => {
      const actor = new TestInterleavedActor({ manager, element });
      await new Promise(resolve => queueMicrotask(resolve));

      let styleTag = document.querySelector('style[data-actor="test-interleaved"]');
      expect(styleTag).toBeTruthy();

      InterleavedContentActor.resetStylesInjectedFor('test-interleaved');

      styleTag = document.querySelector('style[data-actor="test-interleaved"]');
      expect(styleTag).toBeFalsy();

      actor.destroy();
    });

    it('resetAllStylesInjected clears all injected styles', async () => {
      const actor = new TestInterleavedActor({ manager, element });
      await new Promise(resolve => queueMicrotask(resolve));

      InterleavedContentActor.resetAllStylesInjected();

      const styleTag = document.querySelector('style[data-actor="test-interleaved"]');
      expect(styleTag).toBeFalsy();

      actor.destroy();
    });
  });
});
