/**
 * Tests for InterleavedShadowActor base class
 *
 * Tests dynamic shadow-encapsulated container creation, content updates,
 * event handling, and integration with the pub/sub system.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { InterleavedShadowActor, ShadowContainer, InterleavedShadowConfig } from '../../../media/state/InterleavedShadowActor';
import { EventStateManager } from '../../../media/state/EventStateManager';

// Concrete implementation for testing
class TestInterleavedActor extends InterleavedShadowActor {
  public receivedStateChanges: Array<{ key: string; value: unknown }> = [];

  constructor(manager: EventStateManager, element: HTMLElement, styles = '') {
    super({
      manager,
      element,
      actorName: 'test-interleaved',
      containerStyles: styles || '.container { padding: 8px; }',
      publications: {
        'test.containerCount': () => this.getContainerCount()
      },
      subscriptions: {
        'external.trigger': (value: unknown) => {
          this.receivedStateChanges.push({ key: 'external.trigger', value });
        }
      }
    });
  }

  // Expose protected methods for testing
  public exposedCreateContainer(
    idPrefix: string,
    options?: Parameters<typeof this.createContainer>[1]
  ): ShadowContainer {
    return this.createContainer(idPrefix, options);
  }

  public exposedGetContainer(id: string): ShadowContainer | undefined {
    return this.getContainer(id);
  }

  public exposedGetCurrentContainer(): ShadowContainer | undefined {
    return this.getCurrentContainer();
  }

  public exposedGetAllContainers(): ShadowContainer[] {
    return this.getAllContainers();
  }

  public exposedGetContainerCount(): number {
    return this.getContainerCount();
  }

  public exposedUpdateContainerContent(id: string, html: string): void {
    this.updateContainerContent(id, html);
  }

  public exposedAppendToContainer(id: string, html: string): void {
    this.appendToContainer(id, html);
  }

  public exposedQueryInContainer<T extends Element>(id: string, selector: string): T | null {
    return this.queryInContainer<T>(id, selector);
  }

  public exposedHideContainer(id: string): void {
    this.hideContainer(id);
  }

  public exposedShowContainer(id: string): void {
    this.showContainer(id);
  }

  public exposedAddContainerClass(id: string, ...classes: string[]): void {
    this.addContainerClass(id, ...classes);
  }

  public exposedRemoveContainerClass(id: string, ...classes: string[]): void {
    this.removeContainerClass(id, ...classes);
  }

  public exposedToggleContainerClass(id: string, className: string, force?: boolean): void {
    this.toggleContainerClass(id, className, force);
  }

  public exposedRemoveContainer(id: string, animate = false): void {
    this.removeContainer(id, animate);
  }

  public exposedClearContainers(animate = false): void {
    this.clearContainers(animate);
  }

  public exposedDelegateInContainer<K extends keyof HTMLElementEventMap>(
    containerId: string,
    eventType: K,
    selector: string,
    handler: (event: HTMLElementEventMap[K], matchedElement: HTMLElement) => void
  ): void {
    this.delegateInContainer(containerId, eventType, selector, handler);
  }

  public publishContainerCount(): void {
    this.publish({ 'test.containerCount': this.getContainerCount() });
  }
}

describe('InterleavedShadowActor', () => {
  let manager: EventStateManager;
  let parentElement: HTMLElement;
  let actor: TestInterleavedActor;

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new EventStateManager();
    parentElement = document.createElement('div');
    parentElement.id = 'chat-messages';
    document.body.appendChild(parentElement);
  });

  afterEach(() => {
    vi.useRealTimers();
    actor?.destroy();
    document.body.innerHTML = '';
  });

  describe('Container creation', () => {
    it('creates a container with shadow DOM', () => {
      actor = new TestInterleavedActor(manager, parentElement);
      const container = actor.exposedCreateContainer('test');

      expect(container).toBeDefined();
      expect(container.host).toBeTruthy();
      expect(container.shadow).toBeTruthy();
      expect(container.content).toBeTruthy();
    });

    it('appends container host to parent element', () => {
      actor = new TestInterleavedActor(manager, parentElement);
      const container = actor.exposedCreateContainer('test');

      expect(parentElement.contains(container.host)).toBe(true);
    });

    it('generates unique container IDs', () => {
      actor = new TestInterleavedActor(manager, parentElement);
      const container1 = actor.exposedCreateContainer('test');
      const container2 = actor.exposedCreateContainer('test');

      expect(container1.id).not.toBe(container2.id);
      expect(container1.id).toMatch(/^test-1-/);
      expect(container2.id).toMatch(/^test-2-/);
    });

    it('sets data attributes on container host', () => {
      actor = new TestInterleavedActor(manager, parentElement);
      const container = actor.exposedCreateContainer('test');

      expect(container.host.getAttribute('data-actor')).toBe('test-interleaved');
      expect(container.host.getAttribute('data-container-id')).toBe(container.id);
    });

    it('adopts stylesheets into container shadow', () => {
      actor = new TestInterleavedActor(manager, parentElement, '.custom { color: blue; }');
      const container = actor.exposedCreateContainer('test');

      // Uses adoptedStyleSheets instead of <style> elements
      const sheets = container.shadow.adoptedStyleSheets;
      expect(sheets.length).toBeGreaterThan(0);

      // The actor-specific styles should be in the second sheet
      const actorSheet = sheets[1];
      const cssRules = Array.from(actorSheet.cssRules);
      const hasCustomRule = cssRules.some(rule => rule.cssText.includes('.custom'));
      expect(hasCustomRule).toBe(true);
    });

    it('includes base styles via adoptedStyleSheets', () => {
      actor = new TestInterleavedActor(manager, parentElement);
      const container = actor.exposedCreateContainer('test');

      // Uses adoptedStyleSheets - base sheet should contain :host and animations
      const sheets = container.shadow.adoptedStyleSheets;
      expect(sheets.length).toBeGreaterThan(0);

      // The base sheet should contain :host and animations
      const baseSheet = sheets[0];
      const cssRules = Array.from(baseSheet.cssRules);
      const hasHostRule = cssRules.some(rule => rule.cssText.includes(':host'));
      const hasAnimation = cssRules.some(rule => rule.cssText.includes('bubbleIn'));
      expect(hasHostRule).toBe(true);
      expect(hasAnimation).toBe(true);
    });

    it('applies initial content to container', () => {
      actor = new TestInterleavedActor(manager, parentElement);
      const container = actor.exposedCreateContainer('test', {
        initialContent: '<p>Initial</p>'
      });

      const p = container.shadow.querySelector('p');
      expect(p?.textContent).toBe('Initial');
    });

    it('adds custom host classes', () => {
      actor = new TestInterleavedActor(manager, parentElement);
      const container = actor.exposedCreateContainer('test', {
        hostClasses: ['expanded', 'streaming']
      });

      expect(container.host.classList.contains('expanded')).toBe(true);
      expect(container.host.classList.contains('streaming')).toBe(true);
    });

    it('adds custom data attributes', () => {
      actor = new TestInterleavedActor(manager, parentElement);
      const container = actor.exposedCreateContainer('test', {
        dataAttributes: { iteration: '3', status: 'complete' }
      });

      expect(container.host.getAttribute('data-iteration')).toBe('3');
      expect(container.host.getAttribute('data-status')).toBe('complete');
    });

    it('stores metadata with container', () => {
      actor = new TestInterleavedActor(manager, parentElement);
      const container = actor.exposedCreateContainer('test', {
        metadata: { myData: 'value', count: 5 }
      });

      expect(container.metadata).toEqual({ myData: 'value', count: 5 });
    });

    it('adds animation class by default', () => {
      actor = new TestInterleavedActor(manager, parentElement);
      const container = actor.exposedCreateContainer('test');

      expect(container.host.classList.contains('anim-bubble-in')).toBe(true);
    });

    it('removes animation class after timeout', () => {
      actor = new TestInterleavedActor(manager, parentElement);
      const container = actor.exposedCreateContainer('test');

      vi.advanceTimersByTime(300);

      expect(container.host.classList.contains('anim-bubble-in')).toBe(false);
    });

    it('skips animation when specified', () => {
      actor = new TestInterleavedActor(manager, parentElement);
      const container = actor.exposedCreateContainer('test', {
        skipAnimation: true
      });

      expect(container.host.classList.contains('anim-bubble-in')).toBe(false);
    });
  });

  describe('Container retrieval', () => {
    it('getContainer returns container by ID', () => {
      actor = new TestInterleavedActor(manager, parentElement);
      const created = actor.exposedCreateContainer('test');
      const retrieved = actor.exposedGetContainer(created.id);

      expect(retrieved).toBe(created);
    });

    it('getContainer returns undefined for unknown ID', () => {
      actor = new TestInterleavedActor(manager, parentElement);
      const retrieved = actor.exposedGetContainer('unknown-id');

      expect(retrieved).toBeUndefined();
    });

    it('getCurrentContainer returns most recently created', () => {
      actor = new TestInterleavedActor(manager, parentElement);
      actor.exposedCreateContainer('first');

      // Advance time to ensure different timestamps
      vi.advanceTimersByTime(1);

      const second = actor.exposedCreateContainer('second');

      const current = actor.exposedGetCurrentContainer();
      expect(current?.id).toBe(second.id);
    });

    it('getAllContainers returns all containers', () => {
      actor = new TestInterleavedActor(manager, parentElement);
      actor.exposedCreateContainer('first');
      actor.exposedCreateContainer('second');
      actor.exposedCreateContainer('third');

      const all = actor.exposedGetAllContainers();
      expect(all.length).toBe(3);
    });

    it('getContainerCount returns correct count', () => {
      actor = new TestInterleavedActor(manager, parentElement);
      expect(actor.exposedGetContainerCount()).toBe(0);

      actor.exposedCreateContainer('test');
      expect(actor.exposedGetContainerCount()).toBe(1);

      actor.exposedCreateContainer('test');
      expect(actor.exposedGetContainerCount()).toBe(2);
    });
  });

  describe('Container content updates', () => {
    it('updateContainerContent replaces content', () => {
      actor = new TestInterleavedActor(manager, parentElement);
      const container = actor.exposedCreateContainer('test', {
        initialContent: '<p>Old</p>'
      });

      actor.exposedUpdateContainerContent(container.id, '<p>New</p>');

      const p = container.shadow.querySelector('p');
      expect(p?.textContent).toBe('New');
    });

    it('appendToContainer adds content', () => {
      actor = new TestInterleavedActor(manager, parentElement);
      const container = actor.exposedCreateContainer('test', {
        initialContent: '<p>First</p>'
      });

      actor.exposedAppendToContainer(container.id, '<p>Second</p>');

      const paragraphs = container.shadow.querySelectorAll('p');
      expect(paragraphs.length).toBe(2);
    });

    it('queryInContainer queries within container shadow', () => {
      actor = new TestInterleavedActor(manager, parentElement);
      const container = actor.exposedCreateContainer('test', {
        initialContent: '<button class="btn">Click</button>'
      });

      const btn = actor.exposedQueryInContainer<HTMLButtonElement>(container.id, '.btn');
      expect(btn?.textContent).toBe('Click');
    });
  });

  describe('Container visibility', () => {
    it('hideContainer adds hidden attribute', () => {
      actor = new TestInterleavedActor(manager, parentElement);
      const container = actor.exposedCreateContainer('test');

      actor.exposedHideContainer(container.id);

      expect(container.host.hasAttribute('hidden')).toBe(true);
    });

    it('showContainer removes hidden attribute', () => {
      actor = new TestInterleavedActor(manager, parentElement);
      const container = actor.exposedCreateContainer('test');

      actor.exposedHideContainer(container.id);
      actor.exposedShowContainer(container.id);

      expect(container.host.hasAttribute('hidden')).toBe(false);
    });
  });

  describe('Container classes', () => {
    it('addContainerClass adds classes to host', () => {
      actor = new TestInterleavedActor(manager, parentElement);
      const container = actor.exposedCreateContainer('test');

      actor.exposedAddContainerClass(container.id, 'expanded', 'active');

      expect(container.host.classList.contains('expanded')).toBe(true);
      expect(container.host.classList.contains('active')).toBe(true);
    });

    it('removeContainerClass removes classes from host', () => {
      actor = new TestInterleavedActor(manager, parentElement);
      const container = actor.exposedCreateContainer('test', {
        hostClasses: ['expanded', 'active']
      });

      actor.exposedRemoveContainerClass(container.id, 'expanded');

      expect(container.host.classList.contains('expanded')).toBe(false);
      expect(container.host.classList.contains('active')).toBe(true);
    });

    it('toggleContainerClass toggles class', () => {
      actor = new TestInterleavedActor(manager, parentElement);
      const container = actor.exposedCreateContainer('test');

      actor.exposedToggleContainerClass(container.id, 'expanded');
      expect(container.host.classList.contains('expanded')).toBe(true);

      actor.exposedToggleContainerClass(container.id, 'expanded');
      expect(container.host.classList.contains('expanded')).toBe(false);
    });

    it('toggleContainerClass with force parameter', () => {
      actor = new TestInterleavedActor(manager, parentElement);
      const container = actor.exposedCreateContainer('test');

      actor.exposedToggleContainerClass(container.id, 'expanded', true);
      expect(container.host.classList.contains('expanded')).toBe(true);

      actor.exposedToggleContainerClass(container.id, 'expanded', true);
      expect(container.host.classList.contains('expanded')).toBe(true); // Still true

      actor.exposedToggleContainerClass(container.id, 'expanded', false);
      expect(container.host.classList.contains('expanded')).toBe(false);
    });
  });

  describe('Container removal', () => {
    it('removeContainer removes container immediately', () => {
      actor = new TestInterleavedActor(manager, parentElement);
      const container = actor.exposedCreateContainer('test');
      const id = container.id;

      actor.exposedRemoveContainer(id);

      expect(actor.exposedGetContainer(id)).toBeUndefined();
      expect(parentElement.contains(container.host)).toBe(false);
    });

    it('removeContainer with animation delays removal', () => {
      actor = new TestInterleavedActor(manager, parentElement);
      const container = actor.exposedCreateContainer('test');
      const id = container.id;

      actor.exposedRemoveContainer(id, true);

      // Should still exist during animation
      expect(container.host.classList.contains('anim-fade-out')).toBe(true);

      // After animation completes
      vi.advanceTimersByTime(200);

      expect(actor.exposedGetContainer(id)).toBeUndefined();
    });

    it('clearContainers removes all containers', () => {
      actor = new TestInterleavedActor(manager, parentElement);
      actor.exposedCreateContainer('test1');
      actor.exposedCreateContainer('test2');
      actor.exposedCreateContainer('test3');

      expect(actor.exposedGetContainerCount()).toBe(3);

      actor.exposedClearContainers();

      expect(actor.exposedGetContainerCount()).toBe(0);
      expect(parentElement.children.length).toBe(0);
    });

    it('clearContainers resets ID counter', () => {
      actor = new TestInterleavedActor(manager, parentElement);
      actor.exposedCreateContainer('test');
      actor.exposedCreateContainer('test');
      actor.exposedClearContainers();

      const newContainer = actor.exposedCreateContainer('test');
      expect(newContainer.id).toMatch(/^test-1-/);
    });
  });

  describe('Event handling in containers', () => {
    it('delegateInContainer handles events', () => {
      actor = new TestInterleavedActor(manager, parentElement);
      const container = actor.exposedCreateContainer('test', {
        initialContent: '<button class="btn" data-action="test">Click</button>'
      });

      const clicked: string[] = [];
      actor.exposedDelegateInContainer(container.id, 'click', '.btn', (e, el) => {
        clicked.push(el.dataset.action || '');
      });

      const btn = container.shadow.querySelector<HTMLButtonElement>('.btn')!;
      btn.click();

      expect(clicked).toContain('test');
    });
  });

  describe('Style isolation between containers', () => {
    it('containers share adopted stylesheets for efficiency', () => {
      actor = new TestInterleavedActor(manager, parentElement, '.test { color: red; }');
      const container1 = actor.exposedCreateContainer('test1', {
        initialContent: '<div class="test">Content 1</div>'
      });
      const container2 = actor.exposedCreateContainer('test2', {
        initialContent: '<div class="test">Content 2</div>'
      });

      // Both containers should have adopted stylesheets
      const sheets1 = container1.shadow.adoptedStyleSheets;
      const sheets2 = container2.shadow.adoptedStyleSheets;

      expect(sheets1.length).toBeGreaterThan(0);
      expect(sheets2.length).toBeGreaterThan(0);

      // The key optimization: same CSSStyleSheet objects are shared (not copied)
      expect(sheets1[0]).toBe(sheets2[0]); // Same base sheet
      expect(sheets1[1]).toBe(sheets2[1]); // Same actor-specific sheet
    });

    it('container styles do not affect siblings', () => {
      actor = new TestInterleavedActor(manager, parentElement);

      // Add a light DOM element next to containers
      const lightDiv = document.createElement('div');
      lightDiv.className = 'container'; // Same class as shadow content
      parentElement.appendChild(lightDiv);

      const container = actor.exposedCreateContainer('test');

      // The light DOM element should not be inside any shadow
      expect(container.shadow.contains(lightDiv)).toBe(false);
    });
  });

  describe('Pub/Sub integration', () => {
    it('registers with EventStateManager', async () => {
      actor = new TestInterleavedActor(manager, parentElement);

      // Registration is deferred via queueMicrotask
      await Promise.resolve();
      await Promise.resolve();

      // Actor ID includes class name: `${elementId}-${className}`
      const expectedActorId = `${parentElement.id}-TestInterleavedActor`;
      expect(manager.hasActor(expectedActorId)).toBe(true);
    });

    it('publishes state changes', async () => {
      actor = new TestInterleavedActor(manager, parentElement);

      const subscriberEl = document.createElement('div');
      subscriberEl.id = 'subscriber';
      document.body.appendChild(subscriberEl);

      let receivedCount: unknown;
      subscriberEl.addEventListener('state-changed', ((e: CustomEvent) => {
        if (e.detail.state['test.containerCount'] !== undefined) {
          receivedCount = e.detail.state['test.containerCount'];
        }
      }) as EventListener);

      manager.register({
        actorId: 'subscriber',
        element: subscriberEl,
        publicationKeys: [],
        subscriptionKeys: ['test.*']
      }, {});

      actor.exposedCreateContainer('test');
      actor.publishContainerCount();
      await Promise.resolve();

      expect(receivedCount).toBe(1);
    });
  });

  describe('Lifecycle', () => {
    it('destroy clears all containers', () => {
      actor = new TestInterleavedActor(manager, parentElement);
      actor.exposedCreateContainer('test1');
      actor.exposedCreateContainer('test2');

      actor.destroy();

      expect(parentElement.children.length).toBe(0);
    });

    it('destroy unregisters from manager', () => {
      actor = new TestInterleavedActor(manager, parentElement);
      const actorId = parentElement.id;

      actor.destroy();

      expect(manager.hasActor(actorId)).toBe(false);
    });
  });

  describe('Data attributes on parent', () => {
    it('marks parent element with actor name', () => {
      actor = new TestInterleavedActor(manager, parentElement);

      expect(parentElement.getAttribute('data-interleaved-actor')).toBe('test-interleaved');
    });
  });
});
